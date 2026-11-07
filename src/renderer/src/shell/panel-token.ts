import { slashTokenAt } from "./slash-trigger.ts";

/**
 * 右栏面板 → 输入框的「token 通道」纯逻辑：
 *
 * 「`/` + 空格」选取：行首或空白后孤立的 `/` 按空格 → 删掉 `/`、打开右栏
 * 插件面板进入选取模式（零散技能 / MCP 在插件页里也是一行插件），选中后把 token 插回原光标位置。**句中同样触发**
 *（2026-10-11 用户裁定：只认消息开头是 bug，句中打 `/` 加空格要和开头完全
 * 一样）；防误触靠 slashTokenAt 自带的前导空白闸门与字符集闸门。
 *（曾有第二条路——面板卡片长按后 HTML5 拖入输入框；2026-10 用户裁决删去。）
 *
 * token 形态由发送端定义：skill → `/skill:<slug> `，MCP → `/mcp:<server> `，插件 → `/plugin:<name> `
 * （`/skill:` 的展开边界在 `@shared/skill` 的 findSkillTokens，同一套 token 语法）。
 * 三种 token 都带尾随空格——尾随空格让 token 天然终止、光标落在继续打字的位置。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */

/** skill 的插入 token：`/skill:<slug> ` */
export function skillToken(slug: string): string {
  return `/skill:${slug} `;
}

/** MCP server 的插入 token：`/mcp:<name> ` */
export function mcpToken(name: string): string {
  return `/mcp:${name} `;
}

/** 插件的插入 token：`/plugin:<name> `（name 是插件标识，不是显示名） */
export function pluginToken(name: string): string {
  return `/plugin:${name} `;
}

/**
 * 在 `position` 处插入 token，前后自动补空格避免与相邻字粘连：
 * - 前面有非空白字 → token 前补一个空格；
 * - token 自带尾随空格，落点后面已是空白才省掉，不叠出双空格（文末保留——
 *   继续打字不用先补间隔）。
 *
 * 返回补好空格后的全文、实际插进_buffer_ 的那段文本（`text`，供
 * `execCommand("insertText")` 原地替换用——那条路保撤销栈）与光标落点
 * （插入文本之后，含保留的尾随空格）。position 越界时夹回 [0, len]。
 */
export function insertToken(
  value: string,
  position: number,
  token: string,
): { value: string; cursor: number; text: string } {
  const pos = Math.max(0, Math.min(position, value.length));
  const before = value.slice(0, pos);
  const after = value.slice(pos);
  const lead = before !== "" && !/\s/.test(before.slice(-1)) ? " " : "";
  const body = token.endsWith(" ") && /^\s/.test(after) ? token.slice(0, -1) : token;
  const text = lead + body;
  return { value: before + text + after, cursor: pos + text.length, text };
}

/**
 * 「`/` + 空格」是否打开右栏插件面板：光标紧跟在孤立 `/` 之后（`/` 之前
 * 是行首或空白，`/` 之后还没打任何字）。与 slash-trigger 的 token 规则同源；
 * **句中同样开**（2026-10-11 用户裁定：只认消息开头是 bug）——防误触由
 * slashTokenAt 的前导空白闸门与字符集闸门把关：`a/ `、`https:/ `、`C:/ `、
 * `/tmp/ `、`//` 都不命中。
 *
 * 命中返回 `/` 的下标（删掉它、并把 token 插回的位置），否则 null。
 */
export function slashSpaceOpensPanel(value: string, cursor: number): number | null {
  if (cursor <= 0 || cursor > value.length) return null;
  if (value.charAt(cursor - 1) !== "/") return null;
  const token = slashTokenAt(value, cursor);
  if (token === null || token.query !== "") return null;
  return token.start;
}

/**
 * 选取模式的受控接口：App 持有（面板开在哪个槽、插入锚点都在那边），面板只管
 * 上报。锚点 = 输入框里被删掉的那个 `/` 的位置——选中后 token 插回原处。
 * ↑↓ ↵ → ← Esc 都在面板内部处理（plugin-picker.ts），只有「选中」与「取消」经这里上报。
 * 候选按哪个工作区筛，由面板自己拿主槽会话的工作区（PluginsView 的 currentWorkspaceId）。
 */
export interface TokenPickerControl {
  /** 选中一条：token 插回锚点、焦点回输入框 */
  onSelect: (token: string) => void;
  /** 取消（Esc）：不插入，焦点回输入框 */
  onCancel: () => void;
  /** 发起号：每次「/ + 空格」递增——面板可能已开着（选取态也在），只看
   * 「在不在选取态」会在第二次 / + 空格时什么也不做，靠它重入选取态（重新
   * 聚焦、重置筛选词） */
  request: number;
}

/** 面板选取的回执：token 为 null 表示取消（只把焦点送回输入框）。nonce 单调递增 */
export interface TokenPickResult {
  token: string | null;
  position: number;
  nonce: number;
}
