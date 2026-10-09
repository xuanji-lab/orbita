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

UI copy is English first, and **all Chinese under the Copybook theme** (小学作业). There is no language
setting: the language follows the resolved theme (`localeOfTheme` in `src/renderer/src/locale.ts` —
`copybook` → Chinese, every other theme, including what `system` lands on, → English). The
reason is that orbita has no language picker and Copybook is the Chinese edition by design;
Typescript is its English counterpart. A separate switch would only add the one combination users
asked to remove — green grid, English letters that don't sit in the squares. `<html lang>` follows
too (`zh-CN` / `en`), which drives CJK glyph selection and line breaking.

Copy lives in one typed table, not in the components: `messages-en.ts` is the source of truth,
`messages-zh.ts` is typed from it (a missing key fails typecheck). Components read it with
`useT()`; pure functions take the table as a parameter. The Chinese table is **pure Chinese** —
Latin words are allowed only for the brand (orbita), protocol / format names (MCP, API, URL, JSON),
model and provider names, file names and paths, and key names; `messages.test.ts` enforces this with
a whitelist. Chinese copy uses full-width punctuation, one space between CJK and digits / Latin
(「2 个子会话」「编辑 mcp.json」), and a single `…` for menu items and in-flight states. Brand copy —
the slogan 璇玑运转，诸事得序 — stays in Chinese under every theme except Typescript, whose home
page is the English face of the Copybook page: "Set in motion, kept in order."  The rules below are written for
the English copy; the Chinese copy follows the same voice.

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
  serif at 36px, letter-spaced, centred. Nothing else on the home screen competes with it. The two
  paper themes restage it (see *Paper themes*) and add one teacher's mark beneath it in red pen
  (「字迹工整」/ "Neat."); that mark is decoration, not copy — screen readers skip it.

## Visual foundations

**Colour.** Themes: **white + blue** (light), the two dark tiers **黛 Slate + yellow** and
**玄 Onyx + yellow**, and the two paper faces (below). A warm off-white shell (`#f3f4f1`) with
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
`#e7eefd`; the dark tiers share a `.08` yellow wash), plus semibold weight — chosen 2026-08-25 over a
neutral ink fill, trade-off recorded beside `--option-active-bg` in `src/renderer/src/styles.css`. Max two
background colours per screen.

**Filetype colours** (`--color-filetype-doc / -slides / -sheet`, added 2026-10): one job only —
telling Word-ish docs, slide decks and spreadsheets apart **at a glance in their 13–14px icons**
(files tree, composer pills, sent-attachment list; filenames stay in ink). Not the accent or any
status colour; ≥ 3:1 on every theme's panel / muted / app grounds, hues ≥ 40° apart, guarded by
`filetype-colors.test.ts`.

**Two dark tiers** (re-cut 2026-09-30, values lifted from the packaged colour systems of the
user's two comfort apps — DeepSeek Harness and ZCode — not eyeballed): the layering grammar is
unchanged — **the shell (the ground the left rail and right icon strip sit on) is the lighter
step, the chat panel is the well, cards and the composer float back up; hairlines are white at
low translucency; grounds paint solid** (`.layer` / `.pane` overrides in
`src/renderer/src/styles.css`; glass is reserved for floating layers, whose `--glass-bg` is the
tier's card colour). What moved is where each tier's contrast lives: the two wells now sit at the
same depth (`#151517` / `#161616`), and the split is in the shell — **but both shells must clear the
well by a step the eye can see.** **黛 Slate** (id `graphite`, the DeepSeek Harness palette) draws
in: blue-gray shell `#202021`, well `#151517`, cards `#2c2c2e`, and the brightest grey ink of the
set `#f9fafb / #cfd3d6 / #adb2b8` — timestamps and tool captions read clearly. The well, cards and
ink are DeepSeek's own values; **the shell is not**: DeepSeek's own shell sits only ΔL\* 3.0 above
its well — the same murk this re-cut exists to remove, and worse than the retired 石墨's ΔL\* 5.0 —
so it was lifted to `#202021` (ΔL\* 5.5). **玄 Onyx** (id `black`, ZCode zai-dark's real structure)
opens up: the shell floats at `#2b2b2b` — a full step above the well `#161616` (ΔL\* 10.3) — cards
`#262626`, ink `#e5e5e5 / #b8b8b8 / #808080`. ZCode derives its greys by alpha (0.90 / 0.72 / 0.50
white); this tier pins them solid, because the 30%-white tertiary fails the 4.5 floor on the well,
and the second step has to clear 7 on the **lighter shell**, where the rail's section labels and
empty-state hints sit (there it read 5.82:1 until it was lifted from `#a6a6a6`) — `dark-contrast.test.ts`
guards both grounds.
The retired 石墨/Ink pairing had its shell only a hair above the well — shell and well read as one
murk, which is why it was replaced. **玄 stays the dark landing of `system`**; both are manual
choices too, and both keep the yellow accent (`#d6c245`) on `--color-accent-fg`; selection washes
at `.08` — carried by weight and ink, not fill. Tier ids remain `graphite`/`black` (they are the
settings/IPC contract); the display names 黛/Slate and 玄/Onyx live in the message catalogues.
(The 2026-09-27 ZCode-transcribed 石墨/墨 pairing and its own history — Warm's one-day life, the
2026-09-03 true-black/GitHub/neutral bounces — live in those days' commits.)

**Paper themes** (added 2026-09-25): **Copybook** (小学作业) and **Typescript** (打字稿) are the two
faces of the 稿纸 era from the 璇玑载体谱 skin study — the Chinese and English versions — loaded
as two manual themes, and the interface language follows them: Copybook shows all-Chinese copy,
Typescript English (see *Content fundamentals*). Both are **light only** (`system` never
lands on them; the native layer runs light) and share one paper: `#e6e4dc` desk, near-opaque
panels (glass `.92` — paper, not glass), ink `#1f1f1d / #52524e / #6e6e68` (the prototype's
`#e2e0d8` desk and `#8a8a84` third ink fell to 2.6:1 on the desk; raised for WCAG). Copybook takes the
grid's green as its accent (`#3b7a55`), the teacher's red pen (`#cc3a2e`) as danger and as the
wavy underline on bold transcript text, a double green frame round the main pane, a green square
grid in the composer (one Chinese character per cell; every Latin run sits on a white
correction-fluid strip, `--color-paper-whiteout`, and a mostly-English draft drops the per-cell
tracking), and serif text (Literata + Source Han Serif SC). Typescript takes typewriter
ribbon blue (`#2f4f7f`), Courier Prime for text and Special Elite for the wordmark and slogan,
ruled lines plus a red margin line in the composer only, and upper-cased transcript headings.
On the home page Copybook sets the slogan one character per red 田字格 cell in Ma Shan Zheng,
Typescript types the English slogan in Special Elite on a ruled line with a red margin, and both
add the teacher's red-pen mark in Long Cang. The two hand faces ship as **subsets** — only the
nine slogan characters (7 KB) and the mark's characters plus printable ASCII (20 KB) — so changing
either line means re-subsetting (command in `tokens/fonts.css`).
Tokens live in `tokens/colors.css` (the `--color-paper-*` group), `glass.css` and
`typography.css`; the decoration layer is `src/renderer/src/paper-themes.css`. They are the only
themes that change type, and the only place the accent is not blue or yellow.
Copybook was named Manuscript / 稿纸 on the day it landed and renamed the same day: the green grid
with the teacher's red pen is a primary-school exercise book (作业本) of that era, not manuscript
paper. Its theme id is `copybook`; a stored `"manuscript"` still parses to it (`parseTheme` in
`src/shared/settings.ts`).

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
`.60 / .84 / .936` and the paper faces `.92`. The two dark tiers left the ladder on 2026-09-27:
their glass is now **solid** (`--glass-alpha: 1`, `--glass-bg` = the tier's card colour) — dark
grounds must block, not transmit, and Windows' opaque light window base turned translucent dark
grounds to mud; solid is the endpoint of **dark blocks more than light**.
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
(`0 8px 28px rgba(20,24,31,.08)`), 10px radius. Chat-internal process cards (tool, thinking) have **no**
border and **no** fill — they sit directly on the chat surface and are separated by 16px of space.
External-capability events (skill use, MCP calls) render as **chip rows**: their identity (icon +
kind word + name) sits in one pill chip — 1px hairline, fully rounded, no fill — the same language
as the composer's attachment pills, so an "external object" looks alike everywhere; the
row itself stays a process row. Within the family the skill name sets in the text face (a
human-written instruction) while server/tool sets in mono (a machine service) (2026-09-27).
**The composer's materials never enter the input card** (2026-10-03, the "stacked" ruling):
screenshots, file/directory references, pasted-text blocks and quotes stack *above* the card,
in that order — screenshots as one row of square thumbs; references and pasted text as one row
of the same pill chips, single-row, horizontally scrolled, fading at the right edge; quotes as a
floating-glass card of queue-strip rows, at most two visible and the rest folded behind
"N more quotes…". Only the quote card takes a card; the other layers sit directly on the chat
surface, each chip carrying its own `--glass-bg` and `--shadow-border`. Pasted text shows its
full content in a floating popover above the row, never by growing the input area. The slash
panel stays out of the flow the same way: it opens *downward* from the `/` line as a solid
popover positioned inside the input card's bounds — it may cover the bottom bar (attach, model,
send) but never leaves the card.
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
| 界面语言 | 跟主题走，不设语言开关：Copybook（小学作业）全中文，其余主题英文。文案只在 `messages-en.ts` / `messages-zh.ts` 两张表里；中文表纯中文，拉丁字母词只允许白名单（`messages.test.ts` 把关） |

### 硬规则

- **禁用 emoji**：界面文案与图标一律不用 emoji（含 `⚡` `☰` 等符号字符）——一律 lucide 图标或纯文字。
- 禁裸 hex / 未定义 CSS 变量（ChatPane 死 token 事故教训）。
- 一等设计概念（新卡片语言 / 新组件体系级别）的变更，先改本档与 token，理由写进该 commit 正文里。

## Caveats

- **`--color-text-inverse` actually inverts**: light `#ffffff`, graphite `#202021`, black `#2b2b2b`
  (`tokens/colors.css`, one per theme block) — each is that theme's own shell ground, the opposite of
  `--color-text-primary`. Text that must stay white on a permanently dark ground (overlays, toasts)
  uses `--color-text-on-dark`; text on a coloured fill uses that fill's `-fg` token.
- No monospace **brand** face was specified, so the mono token falls back to the system mono stack
  (`ui-monospace, SFMono-Regular, Menlo, …`). If Orbita picks a mono, it belongs in `tokens/fonts.css`.
- **Settings secondary buttons come in two spellings** (see *生效规范 › 按钮*): `.pv-btn` borders on
  hover, the import entry's secondary button (the Import row, and the Migration page after it) carries a
  resting hairline. Not yet unified.
