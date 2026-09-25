# Orbita Design System

Orbita is a desktop agent workbench — an Electron app whose primary surface is a single-agent
conversation. The character it aims for is a **quiet, editorial workbench with brand-grade craft**:
not a dashboard, not a cockpit. Opening the app lands directly in Agent mode, where a brand-serif
slogan and one input box carry the entire home screen. Multi-agent complexity is deliberately
hidden inside the (not yet shipped) orchestration mode.

The interface is built from **translucent cards with a unified, stacking alpha ladder**. The whole
app is one large semi-transparent card — the boundary of the application, sidebar included. The
content pane floats inside it with an even gap on all four sides, and its left edge is what sets the
sidebar's width; the sidebar itself has no surface, sitting directly on the boundary. The input box
and session cards float one level higher. Every layer paints the **same** alpha: the ladder
(.60 → .84 → .936) is what compositing produces, not three authored values, so depth cannot drift
out of sync. The same card recipe is reused everywhere by changing only width and height.

Information follows one rule: **simple by default, expandable on demand**. Thinking, tool calls and
file reads collapse to a single line until clicked. Restraint is the discipline: no emoji, no piles
of colour and counters, every colour with exactly one job.

## 设计品味导言 / Design Taste Statement

> 自用户口述提炼（2026-08-22），是整份设计系统的意图源头；下文所有具体规则都应能回溯到这段话。

**中文**：Orbita 的界面应该是一个**安静的、有品牌质感的编辑工作台**，而不是仪表盘或驾驶舱。核心视觉语言是"毛玻璃卡片的透明度叠加"：整个应用是一张半透明的大卡（app 的边界），聊天面是浮在其上的中卡，输入框和会话卡是再浮一层的小卡——统一透明度，层级越高越实，最里层刚好近纯白；同一个卡片配方改宽高即可复用到侧栏图标等一切表面。打开软件即进入 Agent 模式：品牌衬线体的 slogan「璇玑运转，诸事得序」与输入框构成首页的全部重心，新建会话永远先落在这个页面，首条消息发出时 slogan 与会话卡淡出、输入框丝滑滑落到窗口底部成为聊天页的输入框——输入框宽度跨页面保持一致，动效只用来解释"东西去哪了"，绝不做装饰。信息呈现的总原则是**简洁为默认、细节可展开**：agent 的思考、工具调用、文件阅读都折叠成一行、点击才展开，用户需要的是"知道 agent 在干嘛"与可追溯，而不是被过程淹没。克制是这个界面的纪律：**不用 emoji、不堆彩色和计数器**（那是幼稚和噪音），颜色各有明确职责——accent 只给主操作，模式选中明主题用蓝、暗主题用黄，状态优先用图标和文字；密度 balanced，不做 IDE 式拥挤。结构上左右双栏对称、可折叠成纯图标条；右侧永远默认收起，不自动弹出抢注意力。主工作面是单 agent 对话，多 agent 的复杂性要藏进编排模式而不是铺成驾驶舱。整体气质是**极简的 composer 首页 + 编辑器级的秩序感：安静、透亮、层级分明，让用户的注意力只落在"下一步要做什么"上**。

**English**: Orbita should feel like a **quiet, editorial workbench with brand-grade craft** — not a dashboard, not a cockpit. The core visual language is **frosted-glass cards with unified, stacking translucency**: the whole app is one large semi-transparent card (the boundary of the application); the chat surface floats on it as a medium card; the input box and session cards float one level higher as small cards — one unified opacity per layer, each level more solid than the last, the innermost cards landing almost pure white. The same card recipe is reused everywhere (sidebar icons, future surfaces) by changing only width and height. Opening the app lands directly in Agent mode: the brand-serif slogan and the input box carry the entire weight of the home screen. Every new session starts on this page; when the first message is sent, the slogan and session cards fade away while the input box glides smoothly to the bottom of the window and becomes the chat composer — the input keeps the same width across pages, and **motion only ever explains where things went, never decorates**. Information follows one rule: **simple by default, expandable on demand** — thinking, tool calls, and file reads collapse to a single line until clicked; the user needs to know what the agent is doing and be able to trace it, not drown in process. **Restraint is the discipline of this interface**: no emoji, no piles of color and counters (that is noise and childishness). Every color has exactly one job — accent is reserved for the primary action; the selected mode reads blue on the light theme and yellow on the dark theme; status prefers icons and words over color. Density is balanced, never IDE-crowded. Structurally, the left and right sidebars are symmetric and collapse into slim icon-only strips; the right side stays closed by default and never pops open to steal attention. The primary work surface is a single-agent conversation; the complexity of multi-agent work hides inside the orchestration mode instead of spreading into a cockpit. The overall character: **a minimalist composer-first home with editor-grade order — quiet, translucent, clearly layered — so the user's attention lands only on "what do I do next."**

## Status: this file is the 真源

This file plus `tokens/*.css` are the design language 真源. The renderer does not hold a second copy
of token values: `src/renderer/src/styles.css:5` `@import`s this system's `styles.css` directly, so
there is no "spec vs. shipped" drift to reconcile — a token either exists here and renders, or it
does not exist and the renderer is missing a declaration.

Values that serve a single feature live next to that feature's CSS in the renderer
(`src/renderer/src/styles.css`, or that feature's own `.css`); they do not get promoted into
`tokens/`.

| Concern | Where it lives | Rule |
| --- | --- | --- |
| Why a decision was made, and when | The commit that changes this file or a token file | AGENTS.md 规定仓里不写别的 markdown, so the decision record is the commit message, not a separate document. |
| Raw brand assets | `design/` at the repo root | `design/` is the asset 真源: 2,034 Lucide SVGs in `design/icons/lucide/svg/`, 6 font files across `design/fonts/`'s four family folders. This system's `assets/` is a working **subset** (the glyphs in use, 5 font files) — copy from `design/`, never the other way. |

Adding or removing a first-class design concept (a new card language, a new component system level)
means editing this file and the relevant tokens directly; the why and when goes in that commit's
message — see *附：中文规范 › 硬规则* below.

## No logo

`design/logos/` does not exist in this checkout — git does not track empty directories, and the
folder has never held an asset. **Orbita has no finalised logo.** Wherever a mark would go, the
product renders the name as plain type: lowercase `orbita` set in the brand serif
(`var(--font-family-brand)`), written directly where it's used — the sidebar titlebar
(`src/renderer/src/shell/Sidebar.tsx`) and the home slogan
(`src/renderer/src/features/chat/ChatView.tsx`). There is no `BrandLockup` component and no leftover
mark glyph anywhere in the renderer. When a logo is finalised, drop `SVG + PNG + usage rules` into
`assets/` and wire it in where the plain wordmark sits today.

The **app icon** is a separate thing and does exist: `assets/app-icon.svg` — 稿纸, a green manuscript
grid with a red circle seal reading 璇玑 (the product's Chinese name). It only appears outside the
renderer (Dock, Finder, the packaged `.app`); `bun run icon` renders it into `build/icon.icns`
(`scripts/make-icon.sh`). Don't use it as an in-app mark — inside the window the plain wordmark rule
above still holds.

## Content fundamentals

UI copy is English, written as literals in the components — there is no i18n layer in this checkout.
Brand copy — the slogan — stays in Chinese.

- **Voice: flat, mechanical, unhurried.** Labels are nouns or bare verbs: "New Session", "Search",
  "Start Agent", "Model", "Files", "Confirm". Toasts state what happened, nothing more:
  "Session opened", "Agent created", "Project refreshed", "Share link copied".
- **Sentence case everywhere.** "New workspace name", "Remove workspace", "Main workspace". No
  Title Case, no ALL CAPS except acronyms. `ORBITA` appears capitalised only inside prose that names
  the app ("It may have been removed outside ORBITA."); the wordmark itself is lowercase.
- **Group labels are the one uppercase.** Sidebar node titles, settings section labels, menu group
  headers, panel group headers and card kickers are written in sentence case in the source and set
  uppercase by CSS (`text-transform: uppercase`): mono, `--font-size-micro`, `0.06em` tracking,
  secondary grey (tertiary for card kickers). They name a group; they never stand in for a heading
  or a button.
- **Second person, only when the user must act.** "You can retry this view or reload the app." Never
  first person, never "we". The agent does not speak about itself in the UI chrome.
- **Consequences before actions.** "Remove this workspace? Its branch and directory will be deleted.
  This cannot be undone." Destructive copy names the object, the effect, and the finality — in that
  order, in three short sentences.
- **Refusals explain the blocker, not the rule.** "There are running agents in this workspace. Close
  them before removing." "This project is not a Git repository, cannot enable workspaces."
- **Placeholders invite, they don't instruct.** The composer reads "Ask anything, or start a task";
  a name field reads "Enter branch or workspace name".
- **Interpolation is plain and terse**: "Switched to {name}", "{count} more sessions…", "{days}d ago",
  "Moved {count} file(s)". Counts stay numeric; units abbreviate (`d`, `s`).
- **Ellipsis for in-flight, past tense for done.** "Creating...", "Loading…" → "Workspace created: ",
  "File renamed".
- **Tooltips carry the second half of the sentence.** Icons get their meaning from `title`:
  "Read-only (tools can only read) · click to make writable", "Archive (planned)",
  "Opens with the orchestration phase". The centre dot `·` is the standard connector.
- **Planned features are shown, disabled, and labelled as planned** — never hidden, never faked.
- **No emoji. Anywhere.** Emoji that previously stood in for group labels were replaced with Lucide
  glyphs (see `atom-group-label`). Do not reintroduce them, including in headings and empty states.
- **Mono for machine facts.** Paths, ids, branch names, durations, model names and counts are set in
  the mono/tabular face so a number never re-flows a row.
- **The slogan is the one lyrical line in the product**: 璇玑运转，诸事得序 — set in the brand
  serif at 36px, letter-spaced, centred. Nothing else on the home screen competes with it.

## Visual foundations

**Colour.** Three themes: **white + blue** (light), **warm dark + yellow** (dark), and
**neutral black + yellow** (black). A warm off-white shell (`#f3f4f1`) with
pure-white panels, three text greys, three hairline greys. Every colour has exactly one job: the
accent is blue `#1d4ed8` on light and yellow `#d6c245` on dark, and it means the single primary
action (the send button, "New task", "Start Agent"), the selected mode, and a checked checkbox
(native `accent-color`, settled 2026-09-24 on the migration page, which lists many) — nothing else; amber
`#b7791f` means running; info blue `#2563eb` marks the thinking glyph; red `#b42318` is failure;
green `#1a7f37` (dark `#56d364`) is success — git additions, passed validation, editor badges.
**A filled status surface carries its own foreground token** (`--color-danger-fg`, `--color-info-fg`,
`--color-accent-fg`): the plain `--color-danger` / `--color-info` values are tuned to read as *text*
on the theme ground, and as a fill they leave white text at 2.5:1. Filled danger therefore uses
`--color-danger-solid`, which is darker.
Status prefers icons and words over colour — a spinner, a check, a lock glyph. List rows (sidebar
sessions, settings tabs, menu items — one recipe, `.option-row`) hover with the neutral translucent
fill; the selected row takes `--color-bg-active`, the same soft wash as the selected mode (light
`#e7eefd`, Warm `.05` yellow, Ink `.18` yellow), plus semibold weight — chosen 2026-08-25 over a
neutral ink fill, trade-off recorded beside `--option-active-bg` in `src/renderer/src/styles.css`. Max two
background colours per screen. The dark theme — **Warm** in settings — is a barely-warm
near-black (`#191c1d` shell, `#232525` panel, ink `#d6d5cf / #a3a29b / #82817b` with only a
whisper of warmth, yellow washes at `.05` — selection is carried by weight and ink, not fill):
gruvbox's full cream (`#ebdbb2`) read as "过于黄色" and was cut twice. The black theme — **Ink** — is a **neutral near-black** (Vercel-referenced
`#0a0a0a` shell, `#111111` panel, ink `#ededed / #a1a1a1 / #707070`), the darkest ground in the set
and **the dark landing of `system`**. Both take the yellow accent (`#d6c245`) on
`--color-accent-fg`; both are manual choices, `system` resolves to light or Ink. (Both dark grounds
re-cut 2026-09-03 after seven same-day iterations — true black, GitHub default, GitHub ×0.78 and
neutral gray each bounced; the user picked warm for dark and darkest-neutral for black from a
rendered comparison page, then softened, renamed, darkened and de-yellowed Warm across two more
rounds.)

**Type.** Two families do everything. Brand serif **Literata** (variable, with Source Han Serif SC
for CJK) appears exactly twice: the home slogan and the sidebar wordmark. UI sans **Manrope**
(variable, with Source Han Sans SC) runs the whole interface on a tight 11 → 20px scale, with a
separate 15px/1.68 track for transcript prose and a mono/tabular face for machine facts. Weights:
450 body, 500 controls, 600 titles, 650 for tool and card names, 700 for the chat header. Manrope's
400 skeleton reads thin without subpixel antialiasing (off since this system doesn't force greyscale
smoothing), so body sits at 450 — still one step below the 500 controls weight. Model and
thinking-level labels in the composer bar are set *italic* at secondary grey — the only italic in
the UI.

**Layout.** A fixed shell: left sidebar (288px, collapsing to a 48px icon rail), conversation pane,
a 32px action rail for session actions, right drawer (320px, **closed by default**). Both sidebars
are unbounded — no fill, no border, no dividers — so the pane's edges are the only structure. The
sidebar lists two nodes: **Workspaces** (each holding tasks, with its own new-task control) and
**Tasks** for anything belonging to no workspace. One shared measure — `--content-max-width: 1000px` — governs the
transcript, the composer and the home card, which is why the input box keeps the same width from the
home screen to the chat page. Density is balanced: 32/36/48px row heights, 24–36px controls, never
IDE-crowded.

**Backgrounds.** No imagery, no illustration, no pattern, no texture, no photography — the product
ships none and this system adds none. The only gradient is the desk behind the glass (a soft warm
off-white wash) plus two functional gradients in the app (a radial accent glow on the boot screen,
and the mark gradient on the legacy logo block). Depth comes from translucency and hairlines, not
from colour.

**Transparency.** No blur (2026-09-23): translucency comes from a single `--glass-bg` alpha, stacked
by nesting rather than blurred behind — a moving pixel anywhere on screen used to force the GPU to
recomposite the whole window every frame, so the depth cue now comes from compositing alone. One
alpha, applied at every level; nesting produces the ladder (`1-(1-a)ⁿ`), so light reads
`.60 / .84 / .936` and dark and black `.70 / .91 / .973`. The themes are deliberately unequal —
**dark and black block more than light** — because light text needs a settled ground and a bleeding
wallpaper costs a dark ground its whole promise. Dark and black share one glass recipe: **the tint
is each theme's own panel colour** (warm `rgba(40,40,40,.7)`, neutral `rgba(17,17,17,.7)`), so the
ladder always climbs from the page ground toward the panel colour.
Text is always a solid `--color-text-*`; never a translucent glyph, and never a dimmed tertiary on
glass, which reads as neither theme's ink. Layer 3 is close enough to opaque that content on it
reads as if on paper.
**Floating layers** (menus, popovers — the ones that portal on top of arbitrary content) are the one
exception: they skip the glass ladder for a solid `--color-bg-panel` fill, a hairline `--glass-border`,
and `--shadow-popover` — without blur behind them, a translucent float would let whatever text sits
under it bleed straight through and become unreadable.

**Corners and borders.** 8px base radius: 4/6/8/10px steps, a literal 14px for the user bubble, and
`999px` only for true circles (dots, spinners, the round send button). **Radius follows the surface**:
every glass card takes `--radius-xl` (10px) whatever its layer. **The composer is the one exception**
— it takes `--radius-composer` (14px), matching the user bubble's `--radius-bubble`. It is the surface
the user types into and the only card that travels between screens, and the softer corner is what
distinguishes it from the session cards stacked above it. (Resolved 2026-08-23: this paragraph
previously said the composer was 10px "because radius follows the surface", contradicting
`spacing.css`, which has always specified 14px. The token wins; the rule now names the exception.)
Borders are always 1px hairlines; glass cards border with
`rgba(255,255,255,.55)`, though the app shell and content pane run borderless and rely on the
translucency step alone. No thick rules, no coloured left-border accents.

**Cards.** One recipe: the single `--glass-bg`, 1px light border, `--shadow-composer`
(`0 8px 28px rgba(20,24,31,.08)`), 10px radius. Chat-internal cards (tool, thinking) have **no**
border and **no** fill — they sit directly on the chat surface and are separated by 16px of space.
Process rows live in the quiet tiers: while a row's activity is in progress its head (icon + label)
is the only bright thing at secondary; once the state settles the **whole row** recedes to tertiary —
one flat grey, with failure red as the only exception. Body text never competes with the past.
A run of same-type tool calls gathers under a plain verb header (`读取 · × 4`): it lives expanded
while the turn runs, and folds itself away — every group, every time, without memory — the moment
the turn settles; a failed run keeps a red glyph on the header so failure never folds away silently.
Solid panels (dialogs, drawers, menus, popovers) are white with a hairline and a heavier shadow.

**Shadows.** Four steps, all cool-grey and soft: `--shadow-border` (a 1px inner hairline),
`--shadow-composer` (cards and the input box), `--shadow-popover` (menus, card hover),
`--shadow-modal` (dialogs). Focus is a 2px accent ring at 16% opacity, plus a solid accent outline
on `:focus-visible`.

**Hover, press, disabled.** Hover lays a translucent grey over whatever is underneath
(`--color-bg-hover`: secondary ink at 12% on light — a cool grey that sits with the blue accent —
and 8% on dark) and lifts text from secondary to primary — never a colour change, never a transform.
It is translucent on purpose: a solid "next grey up" was visible on white panels but vanished on the
off-white shell behind the sidebar, so the same hover now reads equally on every ground. Cards lift their shadow from
composer to popover, and nothing moves. Press deepens the fill (`--color-bg-active`); accent buttons
go to `--color-accent-strong` (`#16379c`). Disabled is `opacity: .45–.55` with `cursor: not-allowed`
— and for planned features, a `title` explaining why. **On glass, disable with a solid theme colour
rather than opacity**: a dimmed glyph over translucency reads as neither ink nor wallpaper.

**Motion.** Motion only ever explains where things went. 120ms for hover and row state, 140ms for
the composer's border and shadow, 160ms for chevrons, 220ms for the slogan and session cards fading
up and out, 240ms for the composer gliding to the bottom of the window and becoming the chat
composer. Easing is `cubic-bezier(.22,1,.36,1)` for entrances and `cubic-bezier(.4,0,.6,1)` for that
one travel. Continuous motion exists only for states in progress, and only in two forms: rotation
(loaders, `loader-circle`) and breathing (`orbita-breath`, 1.6s ease-in-out between opacity 1 and
.45) for background maintenance such as context compaction — and for the head of a process row
(thinking, tool, tool group) whose state is still in progress: the head breathes at secondary,
and stops the moment the state settles. Beyond those two there is no idle
animation, no bounce, no parallax; `prefers-reduced-motion` collapses everything to 0.01ms.
Continuous motion also pauses whenever the window is not in front (unfocused or hidden) — a moving
pixel anywhere forces the whole window to recomposite every frame, so a spinner nobody is looking at
still costs GPU. The task row's "running" mark is a static `circle-dot`, not a spinner: it is the one
continuous animation that would otherwise sit on screen unattended, for a background session the user
isn't currently watching.

## Implementation rules

**Stateful styling lives in CSS classes.** Hover, `:focus-visible`, `:active`, `:disabled`,
`[aria-selected]` / `[aria-expanded]`, `:focus-within`, container queries, `prefers-reduced-motion`,
and per-theme differences all belong in CSS (`src/renderer/src/styles.css` or a feature's own
`.css`). Inline `style` carries only one-off layout values — a specific width, a specific position, a
value computed at runtime. Do not paint hover with `useState` + `onMouseEnter`/`onMouseLeave`, and do
not simulate `:focus-visible` in JS. Inline styles cannot express pseudo-classes, so every state turns
into a React re-render, and keyboard focus ends up needing its own JS shim to compensate.

**Keyboard focus is drawn once.** A single global `:focus-visible` rule in `styles.css` paints an
accent outline on every focusable control. Components do not reset their own `outline` unless they
draw their own focus expression (a card's own text field, say, expresses focus for the card).

**Tokens are checked.** `src/renderer/src/design-tokens.test.ts` fails on any `var(--x)` that is
never declared, and on any hex colour outside `tokens/`. A value that serves one feature only lives
next to that feature's CSS, not in `tokens/`. The hex check exempts exactly one file by path,
`src/renderer/src/features/chat/highlight.ts`: it holds shiki's TextMate theme data, which shiki only
accepts as literal colours and converts to inline styles itself — a CSS custom property can't reach
it. The token check does not exempt it.

**Two consumers, one component.** The moment a style object gets copied into a second file, extract a
component instead of duplicating it.

**Control recipes come before new styles.** The shared recipes are CSS classes, not components; a new
control starts from one of them, and a deviation is a local override written right after the recipe
(as Chip and ModeChip do), not a copy:

| Class | Where | What it is |
| --- | --- | --- |
| `.glass-card` | `tokens/glass.css` | The one card: `--glass-bg`, hairline `--glass-border`, `--radius-xl`, `--shadow-composer`. |
| `.glass-float` | `src/renderer/src/styles.css` | Modifier for floating glass (queue strip, approval bar, closing card, menu): lifts the shadow to `--shadow-popover`. The menu also takes `.menu-panel`, a solid `--color-bg-panel`. |
| `.quiet-control` | `styles.css` | Transparent, secondary ink; hover lays `--option-hover-bg` and lifts ink to primary; `aria-pressed` / `aria-selected` take the mode wash (`--color-mode-active-bg` / `-fg`); disabled is solid tertiary. Chip, IconButton, RailButton, ModeChip. |
| `.btn-accent` | `styles.css` | The primary action: accent fill, `--color-accent-fg`, hover `--color-accent-strong`; disabled drops to `--color-bg-hover` + tertiary (the glass rule, no opacity). |
| `.option-row` | `styles.css` | Selection rows (sidebar sessions, settings tabs, menu items): hover `--option-hover-bg`; selected `--option-active-bg` + semibold and wins over hover; disabled solid tertiary. |
| `.text-field` | `styles.css` | Inputs and textareas: panel fill, hairline border, `--radius-md`; focus is an accent border + `--focus-ring`. |

Checkboxes have no recipe: the three in use (Sidebar carryover list, CarryoverChecklist, the Providers
model list) are native `<input type="checkbox">` tinted with `accent-color: var(--color-accent)`.

## Iconography

- **Lucide, and only Lucide.** No runtime package: `assets/icons/lucide/*.svg` are imported at build
  time with Vite's `?raw` and inlined by `src/renderer/src/shell/Icon.tsx`. `design/icons/lucide/`
  holds the full upstream set (2,034 SVGs, `lucide-static@1.33.0`, ISC licence); this system copies a
  working subset into `assets/icons/lucide/`, and only the glyphs registered in `Icon.tsx`'s `ICONS`
  table ship — no CDN, no substitution, no hand-drawn SVG. (No count is kept here: it changes with
  almost every feature and went stale twice; `ls` and the `ICONS` table are the answer.)
- **Sizes**: 16px in the rail, headers and dialogs; 13–14px in chips, list rows and card headers;
  11–12px for inline affordances (locks, filters, counts). **Stroke weight** 1.8 in lists and trees,
  2 for controls, 2.2 for the modal close.
- Icons inherit `currentColor` — tertiary grey at rest, primary on hover, `--color-info` for the
  thinking glyph, the accent inside the send button. The `Icon` component inlines the SVG so this works.
- **Recurring vocabulary**: `bot` = agent mode, `workflow` = orchestration, `folder` = a workspace,
  `plus` = new task, `folder-plus` = new workspace, `archive` = archived tasks,
  `git-branch` = a worktree, and the task-row status slot — `circle-dot` running,
  `check` finished, `triangle-alert` failed, empty when idle,
  `lock` = a field fixed by its preset or identity (Providers), `brain` = thinking,
  `terminal`/`wrench`/`file-text` = tool calls, `panel-left`/`panel-right` = the two sidebars,
  `arrow-up` = send.
- **No emoji, no Unicode glyphs as icons, no icon font, no PNG icons.** The renderer source ships no
  raster images at all.

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `tokens/colors.css` | Surfaces, text, borders, accent, mode selection, status, chat surfaces + the dark and black themes. |
| `tokens/typography.css` | Families, the 11→20px UI scale, line heights, weights, tracking. |
| `tokens/fonts.css` | `@font-face` for Literata, Manrope, Source Han Serif/Sans SC. |
| `tokens/spacing.css` | Space scale, radii, control and row heights, layout widths. |
| `tokens/elevation.css` | Shadows, focus ring, overlay backdrops (all three themes). |
| `tokens/glass.css` | The single glass alpha, border, and the `.glass-card` recipe. |
| `tokens/motion.css` | Durations, easings, the three composed transitions. |
| `guidelines/*.card.html` | 18 foundation specimen cards (Colors, Type, Spacing, Brand). |
| `components/core/` | `Button`, `IconButton`, `Badge`, `TextField`, `SelectField`, `Modal`, `Icon`. |
| `components/surfaces/` | `GlassCard`, `SessionCard`, `Chip`. |
| `components/chat/` | `UserBubble`, `AssistantText`, `ToolCard`, `ThinkingCard`, `RespondingIndicator`. |
| `components/navigation/` | `BrandLockup`, `ModeChip`, `RailButton`, `SessionRow`. |
| `components/composer/` | `Composer` — one glass box, identical on both pages. |
| `ui_kits/orbita-desktop/` | Click-through recreation of the desktop app. See its `README.md`. |
| `assets/fonts/` | Literata, Manrope, Source Han Serif SC Medium, Source Han Sans SC Regular (+ OFL). |
| `assets/icons/lucide/` | The Lucide glyphs copied in from `design/`; only those registered in `Icon.tsx` ship. The ISC licence sits beside it, `assets/icons/LICENSE-lucide.txt`. |
| `SKILL.md` | Agent Skills front matter, for use outside this project. |

`components/**/*.jsx` — together with each one's `.d.ts`, `.prompt.md` and `@dsCard` html — are
**frozen specimens produced by the design tool**: reference pictures, not code. The real components
are the renderer's `.tsx` files under `src/renderer/src/shell/` and `src/renderer/src/features/`.
Where the two disagree, the renderer is right and the specimen is simply stale — **do not port a
specimen's writing style (inline `style`, JS-simulated hover) into the app.**

Each component directory has one `@dsCard`-tagged HTML showing its states, and every component ships
`<Name>.d.ts` (props) and `<Name>.prompt.md` (what & when, with a usage example).

### Intentional additions

- **`Icon`** — a thin wrapper that inlines the copied Lucide SVGs so they inherit `currentColor`.
  The app does the same thing with its own `src/renderer/src/shell/Icon.tsx` (no `lucide-react`
  dependency there either); this specimen mirrors that, not a new design decision.
- **`AssistantText`** and **`Chip`** are extracted from CSS classes in the source
  (`.assistant-text`, `.home-chip` / `.composer .input-chip`) that had no standalone component.

Nothing else was invented: there is no Toast, Tabs, Avatar, Tooltip or Switch here because the
source does not define them.

## 附：中文规范

> 本节是中文补充规范；设计决策的理由写在改动它的 commit 正文里。

### 图标体系（依赖与状态）

| 用途 | 库 | 状态 |
| --- | --- | --- |
| 通用操作图标（按钮/菜单/状态） | 无运行时依赖——`Orbita Design System/assets/icons/lucide/*.svg` 经 Vite `?raw` 静态导入，`src/renderer/src/shell/Icon.tsx` 内联注入 | 在用：以 `Icon.tsx` 的 `ICONS` 表登记为准（`assets/icons/lucide/` 拷进来但未登记的不进产物；不在此记数量，它随功能增减） |
| 文件、文件夹类型图标（文件树/diff/tab） | 同上，仍是 lucide：`src/renderer/src/features/files/tree-view.ts` 的 `fileIcon` 按扩展名分代码 / 配置 / 图片 / 文本四类给形状，不分颜色 | 在用（文件面板 2026-09-23）。曾调研的 [@react-symbols/icons](https://react-symbols.pheralb.dev) 未引入：文件面板设计稿给的理由是彩色库与「颜色各有明确职责」相冲，树的信息密度真不够时再议 |

### UI 组件体系

没有 Radix、没有 shadcn、没有 cva、没有 tailwind——`package.json` 里没有这些依赖。真组件是渲染层的
`.tsx`：可复用的壳层件在 `src/renderer/src/shell/`（`IconButton`、`Menu`、`Icon`、`Chip`、`InlineName`、
`SessionCard`、`RightPanel`、`Drawer`、`Composer`、`Titlebar` 等），feature 专属件在各自的
`src/renderer/src/features/*/` 下。样式写法见上文 *Implementation rules*。新组件先去 `shell/` 找有没有
能复用的件，不新造一套平行组件体系。

#### 字体栈（2026-08-22 定稿；资产收纳于仓库根 `design/fonts/`，全部开源）

| 角色 | 西文 | 中文 |
| --- | --- | --- |
| 标题 / slogan / 品牌 | Literata（可变体，OFL，Google Fonts） | Source Han Serif SC Medium（思源宋体，OFL） |
| 界面 UI | Manrope（可变体，OFL，Google Fonts） | Source Han Sans SC Regular / Medium（思源黑体，OFL） |

- 字体已下载入库 `design/fonts/`，并**已接入应用**：`tokens/fonts.css` 的 `@font-face` 指向
  `assets/fonts/*`（文件均已入库），经 `styles.css` 依次 `@import` 后，`body { font-family:
  var(--font-family-base) }`（Manrope/思源黑体）与两处 `var(--font-family-brand)`（侧栏 titlebar、
  聊天页 slogan，Literata/思源宋体）都在实际加载这些字重。
- 代码等宽与既有 fallback 不变（`--font-family-mono`）。
- （历史：商业字体方案 Galaxie Copernicus / Styrene A 已作废，以本平替定稿。）

### 首页交互（2026-08-22 验收定案）

- **新会话一律先进首页**：全局/工作区内/图标条/新建菜单的「会话、单 agent」入口都先呈现三卡首页（不立即创建 agent），**首条消息提交才 createAgent + prompt**；编排入口除外（保持原子创建）。
- **输入框宽度连续性**：首页中卡宽度 = 聊天页内容区宽度（`settings.contentMaxWidth`，默认 1000px）——首页与聊天页的差别只有 slogan/会话卡消失 + 输入框滑落。
- **首发过渡动画**（R5-05 白名单项）：首条消息发出时 slogan 与会话卡向上淡出、composer 卡向下滑向窗口底部（~240ms），随后聊天页 composer 落位。
- **slogan 规格**：标题字体（见 §2.1 字体栈）+ `--font-size-logo`（36px）品牌级字号。
- **模式选中色**（修正 R4-03 的"绿底"）：明主题蓝、暗主题黄——`--color-mode-active-bg` / `--color-mode-active-fg`，用于模式按钮与图标条当前项。

### 生效规范（摘要）

| 主题 | 规范 |
| --- | --- |
| 密度 | Balanced：默认折叠、按需展开；用户气泡长 prompt 与 agent 消息同宽，短 prompt 自适应 |
| 按钮 | 主操作 accent 实底（`.btn-accent`，一屏一个）；安静控件透明底、hover 铺半透明冷灰、不出边框（`.quiet-control`）；纯图标用 IconButton；危险红字、hover `--color-danger-soft`；卡片本身可为按钮（SessionCard、ThemeCard）。设置页次按钮现有两种写法：Providers 的 `.pv-btn` hover 加 `--color-border-strong` 描边，设置页导入入口（Import 行，其后的 Migration 页沿用）常驻 1px 发丝内描边——尚未统一 |
| 选中态 | 列表选中行铺 `--color-bg-active` 淡底 + semibold（2026-08-25 选定）；模式按钮与安静控件的 pressed 用 `--color-mode-active-*`；hover 只铺中性半透明底 |
| 长信息 | 默认折叠单行摘要，点击展开（tool 输出 / 文档阅读 / 日志统一） |
| 消息形态 | Hybrid：用户指令独立气泡；agent 输出全宽文档式、默认折叠一行 |
| 强调色 | 仅选中 + 主操作，辅以有限语义色；颜色绝不作唯一状态信号 |
| 文字 | 按角色分规则（导航/正文/代码/元数据）；UI 无衬线 + 代码等宽；表达性字体仅品牌标 |
| 动效 | 白名单制：仅解释来源（面板开合/消息到达），无 idle 装饰 |

### 硬规则

- **禁用 emoji**：界面文案与图标一律不用 emoji（含 `⚡` `☰` 等符号字符）——一律 lucide 图标或纯文字。
- 禁裸 hex / 未定义 CSS 变量（ChatPane 死 token 事故教训）。
- 一等设计概念（新卡片语言 / 新组件体系级别）的变更，先改本档与 token，理由写进该 commit 正文里。

## Caveats

- **`--color-text-inverse` actually inverts**: light `#ffffff`, dark `#191c1d`, black `#0a0a0a`
  (`tokens/colors.css`, one per theme block) — each is that theme's own shell ground, the opposite of
  `--color-text-primary`. Text that must stay white on a permanently dark ground (overlays, toasts)
  uses `--color-text-on-dark`; text on a coloured fill uses that fill's `-fg` token.
- No monospace **brand** face was specified, so the mono token falls back to the system mono stack
  (`ui-monospace, SFMono-Regular, Menlo, …`). If Orbita picks a mono, it belongs in `tokens/fonts.css`.
- **Settings secondary buttons come in two spellings** (see *生效规范 › 按钮*): `.pv-btn` borders on
  hover, the import entry's secondary button (the Import row, and the Migration page after it) carries a
  resting hairline. Not yet unified.
