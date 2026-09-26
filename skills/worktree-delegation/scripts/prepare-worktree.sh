#!/bin/sh
# Creates a worktree for a subagent at .claude/worktrees/<name> of the main checkout, on a new branch from
# the base (origin/main by default), and clones into it what Git leaves out and the checks need:
# node_modules, resources/git and resources/uv. Without resources/git about seventy tests that run git fail,
# and an isolated subagent cannot copy it itself: the guard refuses a command that names git twice.
# Usage: sh skills/worktree-delegation/scripts/prepare-worktree.sh <name> <branch> [base]
# It prints the path of the worktree.
set -eu

if [ $# -lt 2 ]; then
  echo "使い方: prepare-worktree.sh <名前> <ブランチ> [基にするコミット]" >&2
  exit 2
fi
name=$1
branch=$2
base=${3:-origin/main}

# The main checkout, also when this runs from inside another worktree.
common=$(git rev-parse --path-format=absolute --git-common-dir)
root=$(dirname "$common")
dir="$root/.claude/worktrees/$name"

if [ -e "$dir" ]; then
  echo "$dir はもうあります。別の名前にするか、先に片づけてください" >&2
  exit 1
fi
git -C "$root" fetch -q origin
git -C "$root" worktree add -q -b "$branch" "$dir" "$base"

# cp -c clones on APFS, so each copy takes seconds and no extra space.
for dep in node_modules resources/git resources/uv; do
  if [ -e "$root/$dep" ]; then
    cp -cR "$root/$dep" "$dir/$dep"
  else
    echo "$dep が本体にないので写していません(npm ci や npm run build で作られます)" >&2
  fi
done
echo "$dir"
