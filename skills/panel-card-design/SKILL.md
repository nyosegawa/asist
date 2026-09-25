---
name: panel-card-design
description: How to add, change or design the cards (built-in panels) that appear in ASIST's left and right docks. Use when adding a new panel or card type, redesigning an existing card (weather, exchange rates, timer, calendar and so on), fixing a card that overflows or is cut off, working with card sizes s/m/l/focus, editing src/renderer/src/panels/**, PanelCard / PanelContent / Dock / FocusOverlay, or taking card screenshots for review. Also use for カード、パネル、天気カード、見切れ、はみ出し、S/M/L. Do not use for the calendar workspace screen, settings screen, or changes that only touch the LLM tool schema.
---

# Designing and implementing a panel card

ASIST splits the work between the shell (Dock / PanelCard / PanelContent / FocusOverlay) and the card itself. The shell measures the height of the dock, decides the size (s / m / l), and provides the frame, the kicker, the backdrop layer, the note in the header and the box for the body. The card lays its content out so that it fits the height of the size it was given. Window height varies between Macs and external monitors, so keeping to this division is what prevents overflow.

## Read first

- The contract with the shell (the fields of the definition, the CSS variables, the height for each size, the numbers used in verification) is in [references/shell-contract.md](references/shell-contract.md). Read it before you implement anything.
- For worked examples, read the weather card `src/renderer/src/panels/builtin/weather.tsx` and `weather.css` (the scenery backdrop layer, the note about the time of the forecast, and how the three sizes fold down), and the exchange rate card `fx.tsx` and `fx.css` (the large number at the top, the note in the header, and a table of amounts that shortens as the size falls). For a card that holds a list, read the news card `news.tsx`; for a card that holds controls, read the TODO card `todo.tsx` and the Agent job card `agent-job.tsx`.
- The shared parts are in `src/renderer/src/panels/primitives/Card.tsx` (Box / Facts / More / Row / Actions / Action / Chip / Empty) and `card.css` (the heading and the large number at the top, `.card-hero` and `.card-big`; the box `.card-box`; a row `.card-row`; the fact list `.card-facts`; the row that leads to the focus view `.card-more`; the controls `.card-actions`). Build a new card out of these first and write only what is specific to that card in its own CSS. Formatting such as relative times and uptime is in `primitives/format.ts`.
- The shell is implemented in `src/renderer/src/panels/shell/card.ts` (the contract's types and thresholds), `PanelCard.tsx`, `PanelContent.tsx`, `src/renderer/src/ui/Dock.tsx` and `FocusOverlay.tsx`.

## Steps

1. Add the type to the catalog. Write the description, the slot, the zod schema and the key in `src/shared/panel-catalog.ts`. The LLM's tools are generated from there.
2. Write the card definition. Export a `CardDefinition` from `src/renderer/src/panels/builtin/<type>.tsx` (its appearance goes in a `.css` file of the same name) and register it in `src/renderer/src/panels/registry.tsx`. What you decide there is `kicker` (the heading at the top left), `className` (when you pass the frame's color through a variable), `meta` (the note at the right of the header), `backdrop` (the background across the whole card) and `scroll` (true only when the length of the content is not fixed).
3. Decide what each size shows. Build l out fully first, then decide what to keep in s, and put m between the two. s is the floor that fits even in the smallest window, so every card has an s. Leave the details to the focus view; in s it is fine to place a row that leads to it.
4. Write the CSS. Put the `card` class and `data-size={size}` on the body's root element (`<div className="card xx" data-size={size}>`). The shared parts already change their dimensions for m / s / focus through `.card[data-size]`, so fold down only the elements specific to your card, as in `.xx[data-size='s']`. Take the l values as the baseline and cut padding, font sizes and rows for m and s. Limit how many entries a list shows and send the rest to the focus view through `More`.
5. Add fixed data to the demo. Put the data in `src/renderer/src/demo/fixtures/<area>.ts`, add one sample to `fixtures/cards.ts` so it appears in the card list, and add the mapping from an utterance in `sayings.ts`. If main fetches this type, return the same fixtures from `panelFetch` in `api.ts` as well. A card's appearance is checked in the demo, so being able to show it without the real services is a precondition.
6. Verify (see Verification below).
7. Update the tests and the documentation. Following `tests/card-shell.test.ts`, write tests that protect behavior: what each size shows, the path to the focus view, and whether the note and the backdrop are present. Write the display rules in README and in that card's specification (for the weather card, `src/main/services/weather/SPEC.md`).

## Rules

Each rule comes with its reason. Where the reason does not apply, ask.

- A card does not read the window height, `vh` or `window.innerHeight`. The shell measures the height and hands it over as `size`. When a card measures for itself, the thresholds scatter and its size switching disagrees with the shell's.
- A card's CSS does not touch the shell's classes (`.panel-card`, `.panel-focus`, `.dock`, `.panel-head`, `.panel-body`). Set the card's tint with `--card-hue` from the class you put in `className`; the theme turns it into the frame, and the colours inside the card come from theme tokens (the `theme` skill). This keeps a change to the shell's structure, or a new theme, from breaking every card.
- Do not cut into the header with absolute positioning. Hand the note at the right of the header to the shell as `meta`, and a background that reaches under the header as `backdrop`. This removes magic numbers.
- Keep a fixed height only as the baseline for l, and reduce it from there for m and s. For an element whose content grows, such as a list, either set `scroll: true` or cut the number of entries.
- When a card without `scroll` has content taller than its box, the shell reports it with `console.error` and a red outline. That is a design defect: fix it by folding the content down, not by raising the threshold.
- Leave the grounds for a number (why this height, on what setup it was measured) in a code comment or in `shell-contract.md`.

## Verification

The tools and how to iterate with them are in the `visual-debugging` skill. For cards, meet the following.

```bash
npm run demo:cards -- /tmp/card-shots --say "長野県の今日の天気を教えて" --say "東京都の明日の天気を教えて"
```

`demo:cards` sends the utterances in order and writes `card-l.png`, `card-m.png`, `card-s.png` and `card-sizes.json` at the l / m / s heights. A card fits when each size's `size` in the JSON matches the window and `clipped` is `null`. When `clipped` is `error`, fold that size's content down. Omitting `--say` uses the two weather utterances. For a new card, pass the utterance that shows it in the demo to `--say`.

While you are writing, leave `npm run demo:open` running and measure with something like `npm run demo:drive -- --port <the port it printed> --size s --cards --rect '.wx-hero'`. To see all four sizes at once, capture them in one image with `npm run demo:gallery -- <output directory> --type <kind>`, or open `/cards/<sample>` in the browser pane after `npm run demo`. Always look at the images yourself. Even when the numbers fit, the spacing between elements or the font sizes can be wrong.

Finally, make `npm run typecheck` and `npm test` pass.

## Fixing a card that does not fit

1. Read the console message "card does not fit: <type> size=<size> content <n>px > box <m>px" to see which size is over and by how much.
2. Tighten the padding, the line height and the font size at that size. If that is not enough, drop rows or sections and show what you dropped in the focus view.
3. Changing the threshold `CARD_SIZE_MIN_HEIGHT` is the last resort. If you do change it, keep l fitting in the dock of a maximized window on a 1440×900 screen (728px inside), and capture the other cards again.

## Done when

- In `card-sizes.json`, every size's `size` matches and `clipped` is `null`.
- `npm run typecheck` and `npm test` pass.
- The report carries the three screenshots of l / m / s. Open the focus view at least once and check it too (`npm run demo:drive -- --port <port> --click '[aria-label="パネルを拡大"]' --shot focus --out …`).
