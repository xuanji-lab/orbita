# Orbita Design System

Orbita is a desktop agent workbench — an Electron app whose primary surface is a single-agent
conversation. The character it aims for is a **quiet, editorial workbench with brand-grade craft**:
not a dashboard, not a cockpit. Opening the app lands directly in Agent mode, where a brand-serif
slogan and one input box carry the entire home screen. Multi-agent complexity is deliberately
hidden inside the (not yet shipped) orchestration mode.

The interface is built from **frosted-glass cards with unified, stacking translucency**. The whole
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

> 自用户口述提炼（2026-08-22）。本节自 `docs/orbita-design.md` 迁入（2026-08-23 真源交接），
> 是整份设计系统的意图源头；下文所有具体规则都应能回溯到这段话。

**中文**：Orbita 的界面应该是一个**安静的、有品牌质感的编辑工作台**，而不是仪表盘或驾驶舱。核心视觉语言是"毛玻璃卡片的透明度叠加"：整个应用是一张半透明的大卡（app 的边界），聊天面是浮在其上的中卡，输入框和会话卡是再浮一层的小卡——统一透明度，层级越高越实，最里层刚好近纯白；同一个卡片配方改宽高即可复用到侧栏图标等一切表面。打开软件即进入 Agent 模式：品牌衬线体的 slogan「璇玑运转，诸事得序」与输入框构成首页的全部重心，新建会话永远先落在这个页面，首条消息发出时 slogan 与会话卡淡出、输入框丝滑滑落到窗口底部成为聊天页的输入框——输入框宽度跨页面保持一致，动效只用来解释"东西去哪了"，绝不做装饰。信息呈现的总原则是**简洁为默认、细节可展开**：agent 的思考、工具调用、文件阅读都折叠成一行、点击才展开，用户需要的是"知道 agent 在干嘛"与可追溯，而不是被过程淹没。克制是这个界面的纪律：**不用 emoji、不堆彩色和计数器**（那是幼稚和噪音），颜色各有明确职责——accent 只给主操作，模式选中明主题用蓝、暗主题用黄，状态优先用图标和文字；密度 balanced，不做 IDE 式拥挤。结构上左右双栏对称、可折叠成纯图标条；右侧永远默认收起，不自动弹出抢注意力。主工作面是单 agent 对话，多 agent 的复杂性要藏进编排模式而不是铺成驾驶舱。整体气质是**极简的 composer 首页 + 编辑器级的秩序感：安静、透亮、层级分明，让用户的注意力只落在"下一步要做什么"上**。

**English**: Orbita should feel like a **quiet, editorial workbench with brand-grade craft** — not a dashboard, not a cockpit. The core visual language is **frosted-glass cards with unified, stacking translucency**: the whole app is one large semi-transparent card (the boundary of the application); the chat surface floats on it as a medium card; the input box and session cards float one level higher as small cards — one unified opacity per layer, each level more solid than the last, the innermost cards landing almost pure white. The same card recipe is reused everywhere (sidebar icons, future surfaces) by changing only width and height. Opening the app lands directly in Agent mode: the brand-serif slogan and the input box carry the entire weight of the home screen. Every new session starts on this page; when the first message is sent, the slogan and session cards fade away while the input box glides smoothly to the bottom of the window and becomes the chat composer — the input keeps the same width across pages, and **motion only ever explains where things went, never decorates**. Information follows one rule: **simple by default, expandable on demand** — thinking, tool calls, and file reads collapse to a single line until clicked; the user needs to know what the agent is doing and be able to trace it, not drown in process. **Restraint is the discipline of this interface**: no emoji, no piles of color and counters (that is noise and childishness). Every color has exactly one job — accent is reserved for the primary action; the selected mode reads blue on the light theme and yellow on the dark theme; status prefers icons and words over color. Density is balanced, never IDE-crowded. Structurally, the left and right sidebars are symmetric and collapse into slim icon-only strips; the right side stays closed by default and never pops open to steal attention. The primary work surface is a single-agent conversation; the complexity of multi-agent work hides inside the orchestration mode instead of spreading into a cockpit. The overall character: **a minimalist composer-first home with editor-grade order — quiet, translucent, clearly layered — so the user's attention lands only on "what do I do next."**

## Status: this file is the 真源

**As of 2026-08-23 this document is the single source of truth for the Orbita design language.**
`docs/orbita-design.md` — which previously held that role — is now a forwarding stub pointing here,
mirroring the repo's existing `CLAUDE.md` → `AGENTS.md` pattern. Everything the old spec carried that
this file did not already cover has been migrated verbatim into *附：中文规范* below.

What did **not** move, and must not be duplicated here:

| Concern | Where it lives | Rule |
| --- | --- | --- |
| Why a decision was made, and when | `docs/orbita-ui-decision-interview.md` → Decision Record | A design change is recorded there **first**, then synced into this file. Never the reverse. |
| Raw brand assets | `design/` at the repo root | `design/` is the asset 真源: 2,034 Lucide SVGs in `design/icons/lucide/svg/`, five font files in `design/fonts/`. This system's `assets/` is a working **subset** (46 glyphs, 4 faces) — copy from `design/`, never the other way. |
| Live token values | `orbita-desktop/src/renderer/src/styles.css` | `tokens/*.css` here is the authored spec; the renderer is where it ships. When they diverge, this file wins and the renderer is the bug. |

Adding or removing a first-class design concept (a new card language, a new component system) still
requires going through the decision record first — see `AGENTS.md` 铁律 5.

## Sources this system was built from

Both were attached as read-only local codebases; paths are as they were mounted.

| Source | What was read |
| --- | --- |
| `renderer/` — the app's React renderer (Electron + Vite + Tailwind v4 + shadcn primitives) | `src/styles.css` (23,470 lines: all tokens, the glass system, home/chat/composer/sidebar/tool-card CSS), `src/components/ui/*` (Button, IconButton, Badge, TextField, SelectField, Modal), `src/components/app/HomeView.tsx`, `AppParts.tsx`, `src/features/agent/components/AgentSidebar.tsx`, `src/i18n/enUS.ts` |
| `design/` — the brand asset source folder | `README.md` (font inventory and licence status), `fonts/*`, `icons/lucide/*` (2,034 static SVGs, `lucide-static@1.33.0`, ISC), `logos/` (**empty**) |

`docs/orbita-design.md` was **not** mounted when this system was first built, which is why the
original draft deferred to it. That gap is now closed: the spec was read on 2026-08-23, reconciled
against this file, and folded in — see *Status* above and *附：中文规范* below. The decision IDs the
codebase cites (`R1-01`, `R2-05`, `R5-02`, `R5-06`, `R8-01`, `R8-02`, and the 2026-08-23 `R9-*` rows)
resolve in `docs/orbita-ui-decision-interview.md`.

No Figma file, no slide deck and no marketing site were provided, so this system covers exactly one
product surface: **the desktop app**.

### No logo

`design/logos/` is empty and the codebase's only mark is a leftover π glyph from an earlier
Pi-inspired theme, plus a text wordmark. **Orbita has no finalised logo.** Wherever a mark would go,
the product renders the name in plain type: lowercase `orbita` in the brand serif (`BrandLockup`).
Nothing in this system draws or approximates a mark. When a logo is finalised, drop
`SVG + PNG + usage rules` into `assets/` and update `BrandLockup`.

## Content fundamentals

The product ships bilingual (`src/i18n/enUS.ts` / `zhCN.ts`). English UI copy is the reference below;
brand copy — the slogan — stays in Chinese and is deliberately **not** run through i18n.

- **Voice: flat, mechanical, unhurried.** Labels are nouns or bare verbs: "New Session", "Search",
  "Start Agent", "Model", "Files", "Confirm". Toasts state what happened, nothing more:
  "Session opened", "Agent created", "Project refreshed", "Share link copied".
- **Sentence case everywhere.** "New workspace name", "Remove workspace", "Main workspace". No
  Title Case, no ALL CAPS except acronyms. `ORBITA` appears capitalised only inside prose that names
  the app ("It may have been removed outside ORBITA."); the wordmark itself is lowercase.
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

**Colour.** Two themes only: **white + blue** and **black + yellow**. A warm off-white shell (`#f3f4f1`) with
pure-white panels, three text greys, three hairline greys. Every colour has exactly one job: the
accent is blue `#1d4ed8` on light and yellow `#e3c25a` on dark, and it means the single primary
action (the send button, "New task", "Start Agent") plus the selected mode — nothing else; amber
`#b7791f` means running; info blue `#2563eb` marks the thinking glyph; red `#b42318` is failure;
green `#1a7f37` (dark `#56d364`) is success — git additions, passed validation, editor badges.
**A filled status surface carries its own foreground token** (`--color-danger-fg`, `--color-info-fg`,
`--color-accent-fg`): the plain `--color-danger` / `--color-info` values are tuned to read as *text*
on the theme ground, and as a fill they leave white text at 2.5:1. Filled danger therefore uses
`--color-danger-solid`, which is darker.
Status prefers icons and words over colour — a spinner, a check, a lock glyph. List rows never tint:
hover and active share one neutral fill and active is marked by weight. Max two
background colours per screen. The dark theme is a cool near-black (`#111315` shell,
`#1d2024` panel) with the yellow accent (`#e3c25a`) on dark glyph colour (`--color-accent-fg`).

**Type.** Two families do everything. Brand serif **Literata** (variable, with Source Han Serif SC
for CJK) appears exactly twice: the home slogan and the sidebar wordmark. UI sans **Manrope**
(variable, with Source Han Sans SC) runs the whole interface on a tight 11 → 20px scale, with a
separate 15px/1.68 track for transcript prose and a mono/tabular face for machine facts. Weights:
400 body, 500 controls, 600 titles, 650 for tool and card names, 700 for the chat header. Model and
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

**Transparency and blur.** Blur is *only* for surfaces: `blur(20px)` over a single `--glass-bg`.
One alpha, applied at every level; nesting produces the ladder (`1-(1-a)ⁿ`), so light reads
`.60 / .84 / .936` and dark `.70 / .91 / .973`. The two themes are deliberately unequal — **dark
blocks more** — because light text needs a settled ground and a bleeding wallpaper costs more there.
Text is always a solid `--color-text-*`; never a translucent glyph, and never a dimmed tertiary on
glass, which reads as neither theme's ink. Layer 3 is close enough to opaque that content on it
reads as if on paper.

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
Solid panels (dialogs, drawers) are white with a hairline and a heavier shadow.

**Shadows.** Four steps, all cool-grey and soft: `--shadow-border` (a 1px inner hairline),
`--shadow-composer` (cards and the input box), `--shadow-popover` (menus, card hover),
`--shadow-modal` (dialogs). Focus is a 2px accent ring at 16% opacity, plus a solid accent outline
on `:focus-visible`.

**Hover, press, disabled.** Hover fills with the next grey up (`--color-bg-hover`) and lifts text
from secondary to primary — never a colour change, never a transform. Cards lift their shadow from
composer to popover, and nothing moves. Press deepens the fill (`--color-bg-active`); accent buttons
go to `--color-accent-strong` (`#16379c`). Disabled is `opacity: .45–.55` with `cursor: not-allowed`
— and for planned features, a `title` explaining why. **On glass, disable with a solid theme colour
rather than opacity**: a dimmed glyph over translucency reads as neither ink nor wallpaper.

**Motion.** Motion only ever explains where things went. 120ms for hover and row state, 140ms for
the composer's border and shadow, 160ms for chevrons, 220ms for the slogan and session cards fading
up and out, 240ms for the composer gliding to the bottom of the window and becoming the chat
composer. Easing is `cubic-bezier(.22,1,.36,1)` for entrances and `cubic-bezier(.4,0,.6,1)` for that
one travel. There is no idle animation, no bounce, no parallax; `prefers-reduced-motion` collapses
everything to 0.01ms.

## Iconography

- **Lucide, and only Lucide.** The app uses `lucide-react` at runtime; `design/icons/lucide/` holds
  the matching static set (2,034 SVGs, `lucide-static@1.33.0`, ISC licence). The 46 glyphs this
  system uses are copied into `assets/icons/lucide/` — no CDN, no substitution, no hand-drawn SVG.
- **Sizes**: 16px in the rail, headers and dialogs; 13–14px in chips, list rows and card headers;
  11–12px for inline affordances (locks, filters, counts). **Stroke weight** 1.8 in lists and trees,
  2 for controls, 2.2 for the modal close.
- Icons inherit `currentColor` — tertiary grey at rest, primary on hover, `--color-info` for the
  thinking glyph, the accent inside the send button. The `Icon` component inlines the SVG so this works.
- **Recurring vocabulary**: `bot` = agent mode, `workflow` = orchestration, `folder` = a workspace,
  `plus` = new task, `folder-plus` = new workspace, `gauge` = usage, `archive` = archived tasks,
  `git-branch` = a worktree, and the task-row status slot — `loader-circle` running,
  `check` finished, `triangle-alert` failed, empty when idle,
  `lock`/`lock-open` = read-only, `brain` = thinking, `terminal`/`wrench`/`file-text` = tool calls,
  `hat-glasses` = anonymous chat, `panel-left`/`panel-right` = the two sidebars, `arrow-up` = send.
- **No emoji, no Unicode glyphs as icons, no icon font, no PNG icons.** The only raster assets in the
  source are third-party editor logos (VS Code, Cursor, Zed, JetBrains) used in the editor picker;
  they are not part of the brand and are not copied here.

## Index

| Path | What it is |
| --- | --- |
| `styles.css` | The single entry point consumers link. `@import` lines only. |
| `tokens/colors.css` | Surfaces, text, borders, accent, mode selection, status, chat surfaces + the dark theme. |
| `tokens/typography.css` | Families, the 11→20px UI scale, line heights, weights, tracking. |
| `tokens/fonts.css` | `@font-face` for Literata, Manrope, Source Han Serif/Sans SC. |
| `tokens/spacing.css` | Space scale, radii, control and row heights, layout widths. |
| `tokens/elevation.css` | Shadows, focus ring, overlay backdrops (both themes). |
| `tokens/glass.css` | The single glass alpha, blur, border, and the `.glass-card` recipe. |
| `tokens/motion.css` | Durations, easings, the three composed transitions. |
| `guidelines/*.card.html` | 18 foundation specimen cards (Colors, Type, Spacing, Brand). |
| `components/core/` | `Button`, `IconButton`, `Badge`, `TextField`, `SelectField`, `Modal`, `Icon`. |
| `components/surfaces/` | `GlassCard`, `SessionCard`, `Chip`. |
| `components/chat/` | `UserBubble`, `AssistantText`, `ToolCard`, `ThinkingCard`, `RespondingIndicator`. |
| `components/navigation/` | `BrandLockup`, `ModeChip`, `RailButton`, `SessionRow`. |
| `components/composer/` | `Composer` — one glass box, identical on both pages. |
| `ui_kits/orbita-desktop/` | Click-through recreation of the desktop app. See its `README.md`. |
| `assets/fonts/` | Literata, Manrope, Source Han Serif SC Medium, Source Han Sans SC Regular (+ OFL). |
| `assets/icons/lucide/` | The 46 Lucide glyphs used, plus the ISC licence. |
| `SKILL.md` | Agent Skills front matter, for use outside this project. |

Each component directory has one `@dsCard`-tagged HTML showing its states, and every component ships
`<Name>.d.ts` (props) and `<Name>.prompt.md` (what & when, with a usage example).

### Intentional additions

- **`Icon`** — a thin wrapper that inlines the copied Lucide SVGs so they inherit `currentColor`.
  The app gets this from `lucide-react`, which is not available here; the wrapper is the closest
  equivalent, not a new design decision.
- **`AssistantText`** and **`Chip`** are extracted from CSS classes in the source
  (`.assistant-text`, `.home-chip` / `.composer .input-chip`) that had no standalone component.

Nothing else was invented: there is no Toast, Tabs, Avatar, Tooltip or Switch here because the
source does not define them.

## 附：中文规范（自 docs/orbita-design.md 迁入）

> 2026-08-23 真源交接：`docs/orbita-design.md` 已降为指向本文件的转发 stub（沿用 CLAUDE.md → AGENTS.md
> 的既有模式）。原文中**本文件未覆盖的**章节整体迁入此处，一字未删。
>
> **已被上文取代、故未迁入的部分**：原 §3 的毛玻璃层级表（明 0.60 / 暗 0.50）——暗色单层透明度已于
> 2026-08-23 改为 **0.70**（阶梯 .70 / .91 / .973），理由见上文 *Transparency and blur*，决策行 R9-02。
> 原 §2.1 字体栈已随 §2 一并迁入（与上文 *Type* 及 `tokens/fonts.css` 一致，无冲突）。
>
> 决策的产生与理由仍记录在 `docs/orbita-ui-decision-interview.md` 的 Decision Record 表；
> 维护规则不变：**任何设计决策变更 → 先在访谈文档决策记录加行/改状态 → 再同步本档**。

### 图标体系（依赖与状态）

| 用途 | 库 | 状态 |
| --- | --- | --- |
| 通用操作图标（按钮/菜单/状态） | [lucide-react](https://lucide.dev) | 在用（`lucide-react@^1`） |
| 文件、文件夹类型图标（文件树/diff/tab） | [@react-symbols/icons](https://react-symbols.pheralb.dev)（开源文件类型图标 400+，Miguel Solorio） | 已调研入册，**待右栏文件系统 slice 引入**（先调研再新增依赖，调研结论 2026-08-22） |

### UI 组件体系（Radix + shadcn 基座）

**Radix UI + shadcn/ui 风格**，叠加本产品的磨砂玻璃卡片式风格。依据：`@radix-ui/react-dialog`、
`@radix-ui/react-select`、`class-variance-authority`、`tailwind-merge` 已在 `orbita-desktop/package.json`；
`src/renderer/src/components/ui/` 下已有 Button / Badge / Modal / SelectField / IconButton 等件。
新组件优先复用该体系（cva 变体 + token 消费），不自造平行组件。

#### 字体栈（2026-08-22 定稿；资产收纳于仓库根 `design/fonts/`，全部开源）

| 角色 | 西文 | 中文 |
| --- | --- | --- |
| 标题 / slogan / 品牌 | Literata（可变体，OFL，Google Fonts） | Source Han Serif SC Medium（思源宋体，OFL） |
| 界面 UI | Manrope（可变体，OFL，Google Fonts） | Source Han Sans SC Regular / Medium（思源黑体，OFL） |

- 字体已下载入库 `design/fonts/`；**尚未接入应用**（应用仍用系统栈 + 既有品牌衬线），接入时机与加载策略（打包 vs 子集化）另行决定。
- 代码等宽与既有 fallback 不变（`--font-family-mono`）。
- （历史：商业字体方案 Galaxie Copernicus / Styrene A 已作废，以本平替定稿。）

### 首页交互（R8-01，2026-08-22 验收定案）

- **新会话一律先进首页**：全局/工作区内/图标条/新建菜单的「会话、单 agent」入口都先呈现三卡首页（不立即创建 agent），**首条消息提交才 createAgent + prompt**；编排入口除外（保持原子创建）。
- **输入框宽度连续性**：首页中卡宽度 = 聊天页内容区宽度（`settings.contentMaxWidth`，默认 1000px）——首页与聊天页的差别只有 slogan/会话卡消失 + 输入框滑落。
- **首发过渡动画**（R5-05 白名单项）：首条消息发出时 slogan 与会话卡向上淡出、composer 卡向下滑向窗口底部（~240ms），随后聊天页 composer 落位。
- **slogan 规格**：标题字体（见 §2.1 字体栈）+ `--font-size-logo`（36px）品牌级字号。
- **模式选中色**（修正 R4-03 的"绿底"）：明主题蓝、暗主题黄——`--color-mode-active-bg` / `--color-mode-active-fg`，用于模式按钮与图标条当前项。

### 从决策记录同步的生效规范（摘要）

| 主题 | 规范 | 决策行 |
| --- | --- | --- |
| 密度 | Balanced：默认折叠、按需展开；用户气泡长 prompt 与 agent 消息同宽，短 prompt 自适应 | R4-01 |
| 按钮 | 卡片式语言下 2-3 类：ghost（icon+text，hover 出边框）/ 黑线边框（设置类）/ 纯图标（ghost 或带边框）；卡片本身可为按钮 | R4-02 |
| 选中态 | 近乎无额外信号，界面自然切换即上下文；仅最轻量文字加重 | R4-03 |
| 长信息 | 默认折叠单行摘要，点击展开（tool 输出 / 文档阅读 / 日志统一） | R4-04 |
| 消息形态 | Hybrid：用户指令独立气泡；agent 输出全宽文档式、默认折叠一行 | R4-05 |
| 强调色 | 仅选中 + 主操作，辅以有限语义色；颜色绝不作唯一状态信号 | R5-02 |
| 文字 | 按角色分规则（导航/正文/代码/元数据）；UI 无衬线 + 代码等宽；表达性字体仅品牌标 | R5-04 |
| 动效 | 白名单制：仅解释来源（面板开合/消息到达），无 idle 装饰 | R5-05 |

### 硬规则

- **禁用 emoji**：界面文案与图标一律不用 emoji（含 `⚡` `☰` 等符号字符）——一律 lucide 图标或纯文字。
- 禁裸 hex / 未定义 CSS 变量（ChatPane 死 token 事故教训）。
- 一等设计概念（新卡片语言 / 新组件体系级别）变更需先过访谈决策记录。

## Caveats

- **`--color-text-inverse` now actually inverts** (dark `#1b1a15`, was `#ffffff` in both themes).
  It means "the opposite of `--color-text-primary`", and a dark-theme `primary` fill is itself
  near-white, so white text on it was invisible — the Button `primary` specimen showed the bug.
  Text that must stay white on a permanently dark ground (overlays, toasts, the logo) uses
  `--color-text-on-dark`; text on a coloured fill uses that fill's `-fg` token.
- **The renderer has not fully caught up with this file.** Reconciled on 2026-08-23: the accent
  (`#238636` / `#35c45a` green) and the dark glass alpha (0.50) were updated in
  `renderer/src/styles.css` to match this system. Still outstanding: the renderer authors three glass
  values (`--glass-bg-l1/l2/l3`) where this system authors **one** `--glass-bg` and lets DOM nesting
  produce the ladder. The two are equivalent only where those surfaces are genuinely nested, so
  collapsing them is a refactor with visual risk, not a rename — it has not been done.
- **Token coverage is partial by design.** This system defines 124 custom properties; the renderer
  defines 197. The ~114 it does not model are shadcn bridge variables and feature-local families
  (git panel, right drawer, image preview, file tree, terminal, logo gradients). Those are
  implementation surface, not brand — do not treat their absence here as a deletion.
- **One light theme, one dark theme.** The shipping app also offers five light-background variants
  (`data-light-background`: white / warm / paper / blue / green) and `data-ui-font-size` /
  `data-chat-font-size` / `data-font-base` scales. This system models the default pair only; a new
  variant must not break the token contract, but its values are not specified here.
- The webfonts are shipped **not yet wired into the app**: `renderer/src/styles.css` still runs a
  system font stack and still declares an older commercial-substitute set (`PlantinNowVariable`,
  `CommitMono`, `DepartureMono`) left over from a previous theme. This system follows
  `design/README.md`, which supersedes those with Literata + Manrope + Source Han.
- No monospace **brand** face was specified, so the mono token falls back to the system mono stack
  (`ui-monospace, SFMono-Regular, Menlo, …`). If Orbita picks a mono, it belongs in `tokens/fonts.css`.
- The renderer contains large unshipped or legacy areas — orchestration (`atom`), Feishu, the browser
  panel, the terminal dock, the desktop pet, the Monaco editor and the config tabs. They are named
  here but not recreated, because their current visuals are explicitly in flux.
