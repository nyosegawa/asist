---
name: worktree-delegation
description: How to hand part of the ASIST work to a subagent, usually in its own git worktree, and take the result back into the branch of the pull request - deciding what to hand over, writing the brief, reviewing the diff, merging, and removing the worktree and branch afterwards. Use when the user asks to delegate or parallelize work (subagentに任せて、worktreeで、並行して進めて、別のAgentに調べさせて), when you decide to split a task across agents yourself, or when a subagent's branch is waiting to be merged or a leftover worktree needs cleaning up. Do not use for a quick read-only search you can run yourself.
---

# Handing work to a subagent

A subagent works best on a task whose files do not overlap with yours. Everything below exists to keep
two sets of changes from colliding, and to make sure what reaches your branch is something you have read.

## 1. Decide whether to hand it over

- Hand over a task whose files you will not touch while it runs, such as skills while you change `src/`,
  or a bug in one screen while you build another.
- Keep a task yourself when it edits the files you are editing now, or when it cannot be described
  without the decisions you are still making.
- A read-only investigation (prices, library comparisons) needs no worktree; start it without isolation.

## 2. Decide where it works

- **Its own worktree** (the Agent tool's `isolation: "worktree"`) is the default. It starts from a commit,
  not from your working tree, so commit anything it must see before starting it.
- **The main working tree, without a worktree**, only when the task depends on your uncommitted changes
  (updating the tests for the change you just made). Then name exactly which files are its own and which
  are yours, tell it not to commit, and do not touch its files until it reports.

## 3. Write the brief

Use the template in `references/brief.md`. A subagent has none of this conversation, so the brief carries
the background, the files it may touch, what to read first (AGENTS.md and the skills that apply), how to
verify, that it commits on its own branch and never pushes or merges, and the shape of its report. Tell
it which files another agent is changing at the same time. Keep the template's "How to work" part: a
subagent that splits its task into agents of its own and replies "waiting for them" stops there, because
nothing reaches it after it replies, and leaves its changes uncommitted.

## 4. While it runs

- Keep working on your own files. Tell the user in one line what you handed over.
- Do not run a long check such as `npm run demo:fit` while you are merging or while files it reads are
  changing; the demo reloads under it and the run fails for no reason in the code.
- Never `cd` into a worktree. In Claude Code that moves the session's working directory there. Read its
  files by absolute path and run git with `git -C <path>`.

## 5. Take the result back

1. If it replied without a commit or without the report, check `git -C <path> status` and
   `git -C <path> log <your branch>..HEAD`, then resume the same agent (SendMessage to its id) and ask it to finish
   and commit. Do not finish its work yourself in its worktree.
2. Read its report, then read the diff yourself: `git diff <your branch>...<branch> --stat` and the parts that
   matter. Check that the diff is what the report says. Do not pass a report on to the user unread.
3. On the branch of your pull request, never on main: if its files overlap with your uncommitted
   changes, commit yours first, then `git merge --no-edit <branch>`. Resolve any conflict by hand. The
   merge commit disappears when the pull request is squashed.
4. Run `npm run typecheck` and `npm test` on the merged tree. Run `npm run build` or the screen checks
   when the change calls for them. Then push the branch; the pull request follows the `pull-request`
   skill.
5. Remove what it left: `git worktree remove --force <path>`, `git branch -d <branch>` (or `-D` when the
   branch was merged under another commit), and confirm with `git worktree list` and `git branch`.
   A branch you decide not to merge is removed the same way, after telling the user.

## 6. Report to the user

Say who did what, what was found (root causes, bugs it caught in your own change), what you took into
the branch and pushed, what nobody checked, and that the worktree is gone. Write it in Japanese.
