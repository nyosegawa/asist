---
name: screen-mock
description: Build a proposed ASIST screen or feature out of the app's own components and fixed data, capture it, and show it to the user for a decision before building it for real. Use when asked 「mockで先に見たい」「モックを見せて」「案を見せて」「先にデザインを見たい」「イメージを出して」「mockup」「prototype first」, and when proposing a rework of a workspace screen (settings, tasks, diary) or a new screen. For checking something already built or investigating a broken layout use visual-debugging, and for designing a single panel card use panel-card-design.
---

# Screen mocks

A mock in this project is not static HTML or an image: it is a capture of the app's own React components
drawn with the demo's fixed data (the rule in the `visual-debugging` skill). It grows straight into the
implementation, so once it is approved do not throw it away, but go on to the tests and the commit.
Build only what the decision needs, and check in along the way.

## Steps

1. **Work out what is being decided.** Which screen, what is wrong with it now (capture the current state
   and look at it yourself), and whether the mock is meant to compare the layout (what goes where), the
   appearance (colors and dimensions) or the flow (the order of the steps). Write the proposal out briefly
   in words first and confirm the direction before you build it. If there is more than one proposal, build
   the one you recommend and describe the others in words.
2. **Look at the state of the working tree.** Use `git status` and `ListAgents` to see whether another
   session is editing the same working tree. If one is, tell that session which files you will touch, and
   do not create a branch (changing branches in a shared working tree puts the other session's commits on
   your branch). Stay on the branch you are on and build without committing.
3. **Build it from the app's own components.** A screen goes in `src/renderer/src/ui/<screen>/` and its
   styles in `src/renderer/src/assets/<screen>.css` (`@import`ed from `main.css`). Match the dimensions and
   colors of the existing screens (memory `my-`, tasks `tk-`, the calendar `cal-`). Take the data from
   `src/renderer/src/demo/fixtures/` and the mock in `demo/api.ts`, and make the empty, loading, failed and
   ready states visible. Make it openable by URL (`/screens/<screen>`; if there is none, add the name to
   `demo/screens.ts` and how to open it to `demo/views.ts`). Give page switches an attribute such as
   `data-page` so the capture steps can `--click` them.
4. **Capture it.** Following `references/capture.md`, use `npm run demo:drive -- --launch` to capture each
   page at 1440×900, and, for a tall page, the whole of it with `--fit`. Put the images in a scratch directory and always look at them yourself.
5. **Show it.** Send the images with `SendUserFile` (the user does not see tool output). The accompanying
   message covers the layout you changed, which parts are fixed data, what you want decided (two to four
   points), and the list of files you touched.
6. **Wait for an answer.** Once it is approved, make `npm run typecheck` and `npm test` pass, add tests and
   commit. If there are corrections, capture again the same way. If it is dropped, restore the files you
   touched with `git checkout -- <files>` and `rm`, and say that you restored them.

## What not to do

- Draw a picture in static HTML or an image editor. It diverges from the app and cannot be used as the implementation.
- Change production behavior (IPC, persistence, main-process work) in the name of a mock. Change only the renderer's appearance and the demo's fixed data.
- Send a capture without looking at it. Even when the numbers are right, spacing and cramped text show up only in the image.
- Create a branch in a shared working tree, run `git stash`, or rewrite files another session is working on.

## Done when

The user has the images, the points you want decided are stated in words, and the list of files you touched is there. After approval, go through the tests and the commit.
