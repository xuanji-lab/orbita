/**
 * 右栏显示文档 / 演示文稿时的宽度规则（纯函数，单测钉）。
 *
 * 写东西的面板在 320px 里太局促，所以默认占 pane（chat 主区 + 右栏）的 0.58；但聊天列有
 * 它自己的底线——再窄输入框按钮互相压住、引用芯片没有正文、「1 个文件已更改」一字一行
 * （2026-11-07 独立验收：1200 窗口聊天列 293–370px）。所以：
 *   宽 = clamp(下限 420, 想要的, min(pane × 2/3, pane − 聊天列首选 480))
 * 聊天列 480 是首选；面板已经缩到下限 420 还放不下时，聊天列可以再让到硬底线 410（1200 窗口实测：
 * 输入框按钮不重叠、引用芯片有正文）；还不够就把面板挤窄到 300 为止（聊天输入框完整可用）；
 * 连「面板 300 + 聊天 410」都放不下才转右侧覆盖层（覆盖层会盖住输入框右半，发送键在那边）。
 * 覆盖层会盖住聊天列右侧——所以打开面板时 App 先自动收起左侧栏（见 App 的 docSidebar 逻辑），收完还放不下才到这一步。
 * 其它右栏页不走这里（它们的规则在 clampRightPanelWidth）。
 */
export const DOC_PANEL_FRACTION = 0.58;
export const DOC_CHAT_MIN = 480;
export const DOC_CHAT_HARD_MIN = 410;
export const DOC_PANEL_FLOOR = 420;
/** 窗口再窄时面板可以被挤到的最窄宽（聊天列守硬底线 410 不动）；再窄才转覆盖层 */
export const DOC_PANEL_SQUEEZE = 300;
export const DOC_OVERLAY_MAX = 640;
/** 覆盖层态下聊天输入框要露出来的最小宽（输入框按钮不重叠的实测下限）+ 右栏图标条与边距 */
export const DOC_INPUT_MIN = 410;
export const DOC_OVERLAY_MARGIN = 56;
export const DOC_OVERLAY_FLOOR = 300;

/** 覆盖层宽 = min(640, 窗口 − 输入框最小可用宽 − 边距)：输入框必须露出来可用（2026-11-07 验收：640 宽的覆盖层把输入框整个盖住） */
export function docOverlayWidth(windowWidth: number): number {
  return Math.max(DOC_OVERLAY_FLOOR, Math.min(DOC_OVERLAY_MAX, Math.round(windowWidth - DOC_INPUT_MIN - DOC_OVERLAY_MARGIN)));
}

export interface DocPanelLayout {
  overlay: boolean;
  width: number;
  /** 并排但被挤得比下限 420 还窄 */
  tight?: boolean;
}

/**
 * @param pane 量到的 pane 宽（0 = 还没量到：先按想要的宽并排）
 * @param wanted 用户拖过的宽度；null = 没拖过，按比例
 * @param windowWidth 窗口宽，覆盖层宽度用
 */
export function docPanelLayout(pane: number, wanted: number | null, windowWidth: number): DocPanelLayout {
  const overlayWidth = docOverlayWidth(windowWidth);
  if (!Number.isFinite(pane) || pane <= 0) {
    return { overlay: false, width: Math.round(wanted ?? DOC_PANEL_FLOOR) };
  }
  // 聊天列守住硬底线后，面板最宽能有多少
  const room = pane - DOC_CHAT_HARD_MIN;
  if (room < DOC_PANEL_SQUEEZE) return { overlay: true, width: overlayWidth };
  // 放不下 420 的下限：面板被挤窄（工具栏会折行，但聊天输入框完整可用）——比覆盖层盖住输入框强
  if (room < DOC_PANEL_FLOOR) return { overlay: false, width: Math.round(room), tight: true };
  const ceiling = Math.max(DOC_PANEL_FLOOR, Math.min(Math.round((pane * 2) / 3), pane - DOC_CHAT_MIN));
  const want = wanted ?? Math.round(pane * DOC_PANEL_FRACTION);
  return { overlay: false, width: Math.max(DOC_PANEL_FLOOR, Math.min(ceiling, Math.round(want))) };
}
