/**
 * 右栏显示文档 / 演示文稿时的宽度规则（纯函数，单测钉）。
 *
 * 写东西的面板在 320px 里太局促，所以默认占 pane（chat 主区 + 右栏）的 0.58；但聊天列有
 * 它自己的底线——再窄输入框按钮互相压住、引用芯片没有正文、「1 个文件已更改」一字一行
 * （2026-11-07 独立验收：1200 窗口聊天列 293–370px）。所以：
 *   宽 = clamp(下限 420, 想要的, min(pane × 2/3, pane − 聊天列底线 480))
 * pane 连「聊天 480 + 面板下限 420」都放不下时不再并排，转右侧覆盖层，宽 = min(640, 窗口 − 48)。
 * 其它右栏页不走这里（它们的规则在 clampRightPanelWidth）。
 */
export const DOC_PANEL_FRACTION = 0.58;
export const DOC_CHAT_MIN = 480;
export const DOC_PANEL_FLOOR = 420;
export const DOC_OVERLAY_MAX = 640;
export const DOC_OVERLAY_MARGIN = 48;

export interface DocPanelLayout {
  overlay: boolean;
  width: number;
}

/**
 * @param pane 量到的 pane 宽（0 = 还没量到：先按想要的宽并排）
 * @param wanted 用户拖过的宽度；null = 没拖过，按比例
 * @param windowWidth 窗口宽，覆盖层宽度用
 */
export function docPanelLayout(pane: number, wanted: number | null, windowWidth: number): DocPanelLayout {
  const overlayWidth = Math.max(280, Math.min(DOC_OVERLAY_MAX, windowWidth - DOC_OVERLAY_MARGIN));
  if (!Number.isFinite(pane) || pane <= 0) {
    return { overlay: false, width: Math.round(wanted ?? DOC_PANEL_FLOOR) };
  }
  if (pane < DOC_CHAT_MIN + DOC_PANEL_FLOOR) return { overlay: true, width: overlayWidth };
  const ceiling = Math.min(Math.round((pane * 2) / 3), pane - DOC_CHAT_MIN);
  const want = wanted ?? Math.round(pane * DOC_PANEL_FRACTION);
  return { overlay: false, width: Math.max(DOC_PANEL_FLOOR, Math.min(ceiling, Math.round(want))) };
}
