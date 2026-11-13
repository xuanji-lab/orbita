/**
 * 论文工作台的**两种布局**（原型 paper-workbench-scenarios.html 场景「13 寸屏的
 * 两种布局」，用户已裁决）。独立成模块的理由同 latex-workbench.ts / panel-layout.ts：
 * 组件连着 React 与 IPC，`node --test` 没法加载；这里全是输入 → 输出。
 *
 * - 布局 A「对话为主」（默认）：对话占主位，右栏是文件面板，**一次只放一个标签**。
 * - 布局 B「稿件为主」：文件面板（稿件工作台）铺满左侧，源码与 PDF 并排；对话收进
 *   右侧 340 的一栏；侧栏自动收起。
 * - 外接大屏：窗口 ≥ 1800 时，布局 A 的右栏里也自动并排源码 + PDF，不用切布局。
 *
 * 边界纪律：这里只裁决**状态与档位**（哪个布局生效、要不要并排、面板要不要加宽），
 * 不碰 DOM、不量宽度、不存盘。宽度几何在 shell/window-tools.ts（工具栏胶囊）与
 * styles.css（`.pane[data-layout="paper"]`）里，各自读这里导出的常量。
 */

/** 布局 A「对话为主」/ 布局 B「稿件为主」 */
export type PaperLayout = "chat" | "paper";

/** 新会话的布局（原型：对话为主是默认） */
export const PAPER_LAYOUT_DEFAULT: PaperLayout = "chat";

/**
 * 布局 B 的对话栏宽（px，原型 340）。对话一栏不跟窗口缩放——它是「一边看稿一边
 * 跟 agent 说话」的最小可用宽，再窄工具行与气泡就开始挤。
 */
export const PAPER_CHAT_WIDTH = 340;

/**
 * 布局 B 生效的最小窗口宽（px）。
 *
 * 为什么不是 960：960 是本仓既有的窄窗断点（侧栏自动收起、右栏转覆盖层），但 B 在
 * 960 时 pane 只剩约 900——扣掉 340 的对话栏，稿件工作台 560，源码与 PDF 各 280，
 * 正是原型里被否掉的「三块都读不了」。所以 B 在 1200 以下**退回对话为主**：这个宽度
 * 能保证 340 的对话栏之外，并排的两边各有约 400（原型对 1440 屏的测算是每边 522）。
 * 960 断点本身照旧：布局 A 在那里转成单栏 + 右栏覆盖层，这一条不属于本模块。
 */
export const PAPER_MIN_WINDOW = 1200;

/**
 * 布局 A 自动并排的窗口宽（px，原型「外接大屏」）。**不加设置项**：窗口够宽时
 * 右栏里并排就是更好的形态，窄回去自然回到单栏。
 */
export const PAPER_AUTO_SPLIT_WIDTH = 1800;

/**
 * 布局 A 自动并排时右栏的**下限宽**（px）：并排的两边各约 450。只在下限触发的那一刻
 * 把面板拉宽一次（之后用户拖动照常覆盖），不是持续夹取——持续夹取会让「把面板拖窄」
 * 这个动作失效。
 */
export const PAPER_SPLIT_PANEL_MIN = 900;

/** 切一次布局（同一个按钮 / 同一个快捷键，两态之间只有一个动作） */
export function nextPaperLayout(layout: PaperLayout): PaperLayout {
  return layout === "paper" ? "chat" : "paper";
}

/** 每个会话记住的布局：只存内存（与右栏宽度同一条纪律，本 PR 不新增落盘协议） */
export type PaperLayoutMemory = ReadonlyMap<string, PaperLayout>;

/** 记下一条会话离开时的布局。返回新 Map，不改传入值 */
export function rememberPaperLayout(
  memory: PaperLayoutMemory,
  sessionKey: string,
  layout: PaperLayout,
): Map<string, PaperLayout> {
  const next = new Map(memory);
  next.set(sessionKey, layout);
  return next;
}

/**
 * 取一条会话记着的布局。没记过（新会话 / 还没切过）一律是默认的对话为主——
 * 「新会话默认 A」不靠调用方记得，是这个函数的返回值。
 */
export function recallPaperLayout(memory: PaperLayoutMemory, sessionKey: string): PaperLayout {
  return memory.get(sessionKey) ?? PAPER_LAYOUT_DEFAULT;
}

/**
 * 此刻**真正生效**的布局。用户的选择（wanted）原样记着，窗口 / 面板状态跟不上时
 * 降级成对话为主，但不清掉选择——窗口再宽回来、工作台重新打开时 B 自己回来。
 *
 * - 没有打开文件面板：布局 B 的主位是稿件工作台，工作台不在就没有 B；
 * - 窗口窄于 PAPER_MIN_WINDOW：见该常量的注释（三块都读不了）。
 */
export function effectivePaperLayout(input: {
  wanted: PaperLayout;
  windowWidth: number;
  workbenchOpen: boolean;
}): PaperLayout {
  if (input.wanted !== "paper") return "chat";
  if (!input.workbenchOpen) return "chat";
  if (input.windowWidth < PAPER_MIN_WINDOW) return "chat";
  return "paper";
}

/**
 * 文件面板里要不要把源码与 PDF **并排**：
 * - 布局 B：项目有 PDF 就并排（B 的主位就是这两块）；
 * - 布局 A：窗口 ≥ PAPER_AUTO_SPLIT_WIDTH 时自动并排，窄回去自动回到单标签。
 *
 * 没有 PDF 时不并排——右半边空着比单标签更浪费。布局 A 的并排也只在文件面板开着
 * 时成立（并排发生在右栏里，工作台没开就无从谈起）。
 */
export function shouldSplitPaper(input: {
  layout: PaperLayout;
  windowWidth: number;
  hasPdf: boolean;
  workbenchOpen: boolean;
}): boolean {
  if (!input.hasPdf || !input.workbenchOpen) return false;
  return input.layout === "paper" || input.windowWidth >= PAPER_AUTO_SPLIT_WIDTH;
}

/**
 * 布局 A 自动并排那一刻右栏应有的宽度（px）；0 = 不干预，用用户记着的宽度。
 *
 * 只在「自动并排」这一档给下限：默认右栏 320 里并排两块，每块 160——那就是原型里
 * 被否掉的形态。布局 B 的面板位铺满主区，宽度由 CSS 决定，这里不参与。
 */
export function autoSplitPanelWidth(input: {
  layout: PaperLayout;
  windowWidth: number;
  hasPdf: boolean;
  workbenchOpen: boolean;
}): number {
  if (input.layout !== "chat") return 0;
  if (!shouldSplitPaper(input)) return 0;
  return PAPER_SPLIT_PANEL_MIN;
}
