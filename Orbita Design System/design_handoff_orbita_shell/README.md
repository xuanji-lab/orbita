# Handoff: Orbita desktop shell — glass layering, sidebar hierarchy, task status

## Overview

Orbita is an Electron desktop agent workbench. This handoff covers a revision of its
primary surface: the application shell (frosted-glass layering), the left sidebar
(information hierarchy and chrome), and the task list row (status). It also corrects
three defects found while building the design system — see **Defects to fix** below,
which is the highest-value part of this package.

The work does **not** cover the transcript internals (tool cards, thinking blocks),
the right drawer's contents, or the settings dialog. Those are unchanged.

## About the design files

The files in this bundle are **design references created in HTML** — prototypes showing
intended look and behaviour, not production code to copy. The renderer is React +
Vite + Tailwind v4 with shadcn primitives; recreate these designs there using the
codebase's existing patterns. `ui_kits/orbita-desktop/*.jsx` is a browser-only mock
(no build step, components pulled off a global) and is not importable.

The one exception is `tokens/*.css`: that is plain CSS custom properties and can be
adopted directly, reconciled against `src/renderer/src/styles.css`.

## Fidelity

**High-fidelity.** Colours, type, spacing, radii, shadows and motion are final and
derive from the renderer's own `styles.css`. Recreate pixel-accurately. Every value
below is a token; prefer the token over the literal.

## Defects to fix

These are bugs in the current renderer, found by deriving the design system from it.
Fix these first — they are the substance of the change.

### 1. The glass alphas are baked composites, then composited again

`styles.css` declares three alphas: `.60`, `.84`, `.936` (dark `.50 / .75 / .875`).
Those three numbers are not independent — `.84 = 1-(1-.60)²` and `.936 = 1-(1-.60)³`.
They are the *result* of stacking one `.60` surface two and three deep. Because the
markup then nests them, the compositing happens a second time: layer 3 inside layer 2
inside layer 1 resolves to an effective alpha of **0.9997** — opaque, glass in name only.

**Fix:** one token, one alpha, applied at every level. Let nesting produce the ladder.

```css
:root                    { --glass-alpha: .60; --glass-bg: rgba(255,255,255,.60); }
:root[data-theme="dark"] { --glass-alpha: .70; --glass-bg: rgba(29,32,36,.70); }
```

Delete `--glass-bg-l1/l2/l3`. Every glass surface paints `--glass-bg`. Nested depth
reads as `1-(1-a)ⁿ`: light `.60 → .84 → .936`, dark `.70 → .91 → .973`.

Note the themes are deliberately **unequal** — dark blocks more. Light text needs a
settled ground; at a low alpha the wallpaper bleeds through and light-on-grey loses
contrast. This is why dark is `.70`, not `.50`.

### 2. Sidebar rows paint an opaque surface on a translucent parent

`SessionRow` at rest fills with `--color-bg-panel` (`#ffffff` light, `#1d2024` dark).
The sidebar sits on layer 1, so an opaque tile there breaks the layering — the row
reads as floating rather than as part of the boundary.

**Fix:** rest state is `transparent`. Only hover and active paint, both with the
neutral `--color-bg-hover`. Active is distinguished by `font-weight` (600), not colour.
Do **not** use `--color-bg-active` here — it is accent-tinted and colours a list.

### 3. Dimmed text on glass reads as neither theme's ink

Disabled and de-emphasised labels use `--color-text-tertiary` (`#8b8f94` light,
`#858e99` dark) and several also apply `opacity: .55`, compounding to ~`#c8cacd`.
That mid-grey sits almost exactly between the two themes' text colours, so on a
translucent surface it looks like the wallpaper is driving the text colour.

**Fix:** on layer 1, text is a solid theme colour at full strength — `--color-text-primary`
for labels, `--color-text-secondary` for icons. Disable with a solid colour, never with
opacity. Affected: `ModeChip` (disabled), `RailButton` (disabled), the sidebar usage
caption.

## Screens / views

### Application shell

**Purpose:** the frame every screen lives in.

**Layout** — one flex row, `--space-3` (12px) gap, `--space-3` padding:

| Region | Width | Surface |
| --- | --- | --- |
| Sidebar | 288px fixed (48px collapsed rail) | none — transparent |
| Content pane | `flex: 1`, `min-width: 0` | layer 2 glass |
| Action rail | 32px fixed, chat page only | none — transparent |
| Right drawer | 320px, closed by default | solid panel |

Layer structure, which differs from the current implementation:

- **Layer 1** is the whole window **including the sidebar**. Glass, `--radius-xl` (10px),
  `--shadow-composer`, `blur(20px)`, `border: 0`.
- **Layer 2** is the content pane, floating inside layer 1 with an even 12px gap on all
  four sides. Its **left edge is what defines the sidebar's width** — there is no sidebar
  panel to resize. Same glass recipe, `border: 0`.
- **The sidebar and action rail have no surface at all.** No fill, no border, no dividers.
  They sit directly on layer 1.
- **Layer 3** is the composer and session cards.

The desk behind layer 1 is a wallpaper gradient. Theme and wallpaper are **independent** —
all four pairings must work (light UI on a dark wall, dark UI on a light wall).

**Radius rule:** radius follows the *surface*, not the element. Every glass card is
`--radius-xl` (10px) whatever its layer. The composer is a glass card, so it is 10px —
not the 14px `--radius-composer`, which now applies only to the user bubble.

### Left sidebar

**Purpose:** navigate workspaces and tasks.

Vertical stack, `--space-3` gap, `--space-2 --space-3` padding, transparent:

1. **Header** — collapse button (32px ghost icon button, `panel-left`, 14px) then the
   wordmark, 10px gap, left-aligned. The button *leads* the wordmark; it is not
   opposite it.
2. **Mode tabs** — `Agent mode` (active) and `Orchestrate` (disabled, planned),
   `role="tablist"`, 4px gap, each `flex: 1`.
3. **New task** — full-width accent button, 32px, `plus` icon + label, `--radius-md`.
   The only accent in the sidebar.
4. **Search** — 32px, transparent, no border, `search` icon 14px in tertiary, then input.
5. **Tree** — scrolls, two nodes:
   - **WORKSPACES** — node header: uppercase micro label in the business face,
     `.06em` tracking, secondary; new-workspace button (`folder-plus`, 14px, 26px box)
     right-aligned. Each workspace is a disclosure row: `folder` 14px (stroke 1.8),
     name at 600, optional `git-branch` + branch name in micro/tertiary, task count,
     then a new-task button (`plus`, 14px, 26px box).
     *Implementation note:* the count sits inside the disclosure and the new-task button
     must not nest inside it — a button cannot contain a button. Use a grid
     (`minmax(0,1fr) 26px`) with the disclosure and the action as siblings, and put hover
     on the wrapper so the row still highlights as one.
   - **TASKS** — same header, holds every task belonging to no workspace. **Derive this
     list** (any task not referenced by a workspace) rather than flagging it, so a task
     cannot go missing. Search filters it too.
6. **Footer** — three rows, each leading with a **26px icon slot** and `--space-2` gap so
   the icons share a column: `archive` + "Archived（0）"; `gauge` + a 7-square usage meter
   (10px squares, 2px radius, 3px gap, filled `--color-accent`, empty `--color-bg-hover`);
   avatar + user name + settings button.

**Collapsed rail** — 48px, transparent, no dividers: expand, agent mode, orchestrate
(disabled), new task, search, spacer, settings. **Archive is deliberately absent** —
collapsing signals focus on current work, so the historical-chat affordance goes away.

### Task row (`SessionRow`)

32px min height (`--control-height-md`), 2px vertical margin, `--space-2` gap,
`--radius-sm`, transparent at rest.

**Leading slot carries status** — a 13px box, empty when idle so titles stay aligned:

| Status | Icon | Colour |
| --- | --- | --- |
| running | `loader-circle`, spinning 1s linear infinite | `--color-accent` |
| done | `check` | `--color-text-tertiary` |
| failed | `triangle-alert` | `--color-danger` |
| idle | none — empty 13px box | — |

Then the title (one line, ellipsis), then the time in the mono/tabular face at
`--font-size-micro`/tertiary. A read-only lock toggle (11px) sits outside the row button,
revealed on hover or when locked.

There is **no** separate running dot — status is encoded once.

### Chat header

Title at `--font-size-title`/700, then a workspace badge (`variant="outline"`, mono).
The badge must read the **open task's** workspace; a task with no workspace shows **no
badge** rather than a borrowed one. Right side holds only the commit hash badge — the
Terminal / Copy transcript / Files-panel actions moved to the action rail.

### Action rail

32px, transparent, chat page only, `--space-3` gap: files panel toggle
(`panel-right`), copy transcript (`copy`), terminal (`terminal`). Each a 32px icon
button filled `--color-bg-panel`, no border, no shadow.

## Interactions & behaviour

- **Home → chat.** On send: slogan and session cards fade up and out (220ms), the
  composer glides to the bottom (240ms). It does **not** resize — both pages read
  `--content-max-width: 1000px`. Nothing about the composer changes but its position:
  same width, same glass surface, same radius. There is no solid chat variant.
- **Hover.** Fills with `--color-bg-hover` and lifts text from secondary to primary.
  Never a colour change, never a transform. Cards lift shadow composer → popover.
- **Press.** Deepens the fill; accent buttons go to `--color-accent-strong`.
- **Disabled.** `cursor: not-allowed` plus a `title` explaining why for planned
  features. On glass, use a solid theme colour, not opacity (see defect 3).
- **Focus.** 2px accent ring at 16%, plus a solid accent outline on `:focus-visible`.
- **Motion.** 120ms hover/row, 140ms composer border, 160ms chevrons, 220ms fades,
  240ms the composer travel. Entrances `cubic-bezier(.22,1,.36,1)`; the travel
  `cubic-bezier(.4,0,.6,1)`. No idle animation, no bounce, no parallax.
  `prefers-reduced-motion` collapses everything to 0.01ms.
- **Theme.** `data-theme="dark"` on the root element.

## State

| State | Type | Notes |
| --- | --- | --- |
| `page` | `"home" \| "chat"` | |
| `activeId` | task id | drives title, badge, row active state |
| `collapsed` | boolean | sidebar rail |
| `drawerOpen` | boolean | closed by default |
| `theme` | `"light" \| "dark"` | |
| `openNodes` | map | workspace disclosure state |
| `search` | string | filters workspaces **and** the Tasks node |
| `readOnly` | id set | per-task lock |

A task needs `{ id, title, time, status?, running?, readOnly?, project? }`. `project`
absent means it belongs to the Tasks node. `running` currently wins over `status`;
folding it into `status: "running"` would be cleaner.

## Naming

The UI says **workspaces** and **tasks**: a workspace holds tasks. The code still says
`SessionRow`, `SESSIONS`, `onNewSession`. Renaming to task vocabulary is recommended and
was left undone deliberately, so it can be one deliberate pass rather than piecemeal.

## Design tokens

Full values in `tokens/*.css`. Key ones:

**Colour, light** — app `#f3f4f1`, sidebar `#f7f7f3`, panel `#ffffff`, muted `#f8f8f5`,
hover `#f0f1ed`, active `#e7eefd`; text `#202124` / `#5f6368` / `#8b8f94`;
accent `#1d4ed8`, accent-strong `#16379c`, accent-fg `#ffffff`;
danger `#b42318`, warning `#b7791f`, info `#2563eb`.

**Colour, dark** — app `#111315`, sidebar `#171a1d`, panel `#1d2024`, muted `#16191c`,
hover `#252a2f`; text `#eceff3` / `#b9c0c8` / `#858e99`;
accent `#e3c25a`, danger `#ff7b72`, warning `#d4a72c`, info `#6aa4ff`.

**Glass** — `--glass-bg` per theme (above), `blur(20px)`,
border `rgba(255,255,255,.55)` light / `rgba(255,255,255,.08)` dark.

**Type** — brand serif Literata (slogan 36px/600 `.04em`, wordmark 22px/500) with
Source Han Serif SC for CJK; UI sans Manrope with Source Han Sans SC, 11 → 20px;
transcript prose 15px/1.68; mono/tabular for machine facts.
Weights 400 / 500 / 600 / 650 / 700.

**Spacing** — 4 · 8 · 12 · 16 · 20 · 24 · 32. Radii 4 / 6 / 8 / 10, 14 user bubble,
`999px` true circles only. Controls 24/28/32/36; rows 32/36/48; rail 48;
`--content-max-width: 1000px`.

**Shadows** — `--shadow-border` (1px inner hairline), `--shadow-composer`
(`0 8px 28px rgba(20,24,31,.08)`), `--shadow-popover`, `--shadow-modal`.

## Assets

- **Icons: Lucide, and only Lucide.** The renderer already has `lucide-react`; use it.
  Glyphs referenced here: `panel-left`, `panel-right`, `bot`, `workflow`, `plus`,
  `folder`, `folder-plus`, `git-branch`, `search`, `archive`, `gauge`, `user`,
  `settings`, `lock`, `lock-open`, `loader-circle`, `check`, `triangle-alert`, `copy`,
  `terminal`, `arrow-up`. Sizes 16px rails/headers, 13–14px rows, 11–12px inline
  affordances; stroke 1.8 lists, 2 controls.
- **Fonts** in `assets/fonts/` (Literata, Manrope, Source Han Serif/Sans SC, + OFL).
  Note the renderer's `styles.css` still declares a legacy commercial-substitute stack
  (`PlantinNowVariable`, `CommitMono`, `DepartureMono`) and a system fallback — the
  webfonts are shipped but not yet wired up.
- **No imagery, illustration, pattern or texture.** None ships and none should be added.
  No emoji anywhere.
- **No logo.** `design/logos/` is empty; the wordmark is live text in the brand serif.

## Files

This folder holds the brief and the directly adoptable CSS:

| Path | What it is |
| --- | --- |
| `README.md` | This document. Self-sufficient — implement from it alone. |
| `readme.md` | The full design system: character, content voice, visual foundations, iconography. Read this second. |
| `tokens/` | The CSS custom properties. Adoptable directly, reconciled against the renderer's `styles.css`. |
| `styles.css` | Entry point — `@import` lines only. |

The rest lives in the design system project alongside this folder, and is included in
the full-project download:

| Path | What it is |
| --- | --- |
| `ui_kits/orbita-desktop/index.html` | Click-through mock of the whole shell — home, chat, sidebar, drawer, settings, plus theme and wallpaper toggles. Open this to see the intended behaviour. |
| `components/` | Reference implementations, each with `.d.ts` (props) and `.prompt.md` (what & when). Browser-only — read, don't import. |
| `guidelines/` | Foundation specimen cards. `brand-glass.card.html` documents the layering rule. |
| `assets/icons/lucide/` | The Lucide glyphs used, plus the ISC licence. The renderer should use `lucide-react` instead. |
| `assets/fonts/` | Literata, Manrope, Source Han Serif/Sans SC, + OFL. |

They are deliberately not duplicated into this folder: the design system compiles every
`.jsx` and card in the project, so a second copy registers each component twice and
collides.

## Open questions

1. **Disabled states on glass.** Removing opacity dimming makes disabled controls look
   identical to enabled ones apart from the cursor. Needs a deliberate treatment.
2. **The usage meter has lost its label.** Seven squares with five filled, no caption
   and no unit — previously "4 of 6 hours used". Decide what it measures.
3. **`docs/orbita-design.md`** — the upstream written spec — was never available. Values
   here come from the code; that document may be more current on intent.
