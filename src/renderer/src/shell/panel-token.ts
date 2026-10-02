import { slashTokenAt } from "./slash-trigger.ts";

/**
 * 右栏面板 ↔ 输入框之间的「token 通道」纯逻辑：
 *
 * 1. **拖拽**（Skills / MCP 面板的卡片长按后 HTML5 拖入输入框）：
 *    拖拽源在 dataTransfer 里同时带 `text/plain`（token 文本——落到别处也还是
 *    一段可读文字）与自定义 MIME（结构化负载，输入框一侧按它做空格补齐）；
 * 2. **`/` + 空格选取**：消息开头孤立的 `/` 按空格 → 删掉 `/`、打开右栏 Skills
 *    面板进入选取模式，选中后把 token 插回原光标位置。
 *
 * token 形态由发送端定义：skill → `/skill:<slug> `，MCP → `/mcp:<server> `
 * （`/skill:` 的展开边界在 `@shared/skill` 的 findSkillTokens，同一套 token 语法）。
 * 两个 token 都带尾随空格——`replaceToken`（slash-trigger.ts）插入指令时同款，
 * 尾随空格让 token 天然终止、光标落在继续打字的位置。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */

/** 拖拽负载的自定义 MIME。Chromium 在 dragover/drop 里都能读到非标准类型 */
export const ORBITA_TOKEN_MIME = "application/x-orbita-token";

export interface OrbitaTokenPayload {
  kind: "skill" | "mcp";
  /** 插入文本（带尾随空格），text/plain 与它一致 */
  token: string;
}

/** skill 的插入 token：`/skill:<slug> ` */
export function skillToken(slug: string): string {
  return `/skill:${slug} `;
}

/** MCP server 的插入 token：`/mcp:<name> ` */
export function mcpToken(name: string): string {
  return `/mcp:${name} `;
}

export function encodeTokenPayload(payload: OrbitaTokenPayload): string {
  return JSON.stringify(payload);
}

/** 宽松解码：坏 JSON / 形状不对一律 null，不让拖拽通道把异常带进输入框 */
export function decodeTokenPayload(raw: string | null): OrbitaTokenPayload | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.kind !== "skill" && value.kind !== "mcp") return null;
  if (typeof value.token !== "string" || !value.token.startsWith("/")) return null;
  return { kind: value.kind, token: value.token };
}

/** 拖拽事件里取本应用的 token 负载；不是我们的拖拽返回 null（文件 / 图片照旧走原路） */
export function tokenPayloadOf(transfer: DataTransfer | null): OrbitaTokenPayload | null {
  if (transfer === null) return null;
  return decodeTokenPayload(transfer.getData(ORBITA_TOKEN_MIME));
}

/**
 * 在 `position` 处插入 token，前后自动补空格避免与相邻字粘连：
 * - 前面有非空白字 → token 前补一个空格；
 * - token 自带尾随空格，落点后面已是空白才省掉，不叠出双空格（文末保留——
 *   继续打字不用先补间隔，与 `replaceToken` 的取舍一致）。
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
 * 原生 drop 之后找「浏览器把 text/plain 插到了哪」：对 drop 前后的值做
 * 前后缀比对，切出的插入段必须恰好等于期望的 token——对不上（drop 被拦、
 * 只读框没插进去、或下一次正常输入撞上残留的等待态）返回 null，调用方按
 * 普通输入处理。这让「等待 drop 的 input 事件」天然自愈，不会误伤后续打字。
 */
export function diffInsertion(
  before: string,
  after: string,
  expected: string,
): { start: number; end: number } | null {
  if (after.length !== before.length + expected.length) return null;
  let prefix = 0;
  while (prefix < before.length && before.charAt(prefix) === after.charAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    before.charAt(before.length - 1 - suffix) === after.charAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  const inserted = after.slice(prefix, after.length - suffix);
  if (inserted !== expected) return null;
  return { start: prefix, end: after.length - suffix };
}

/**
 * 「`/` + 空格」是否打开右栏 Skills 面板：光标紧跟在消息开头的孤立 `/` 之后
 * （`/` 之前只有空白，`/` 之后还没打任何字）。与 slash-trigger 的 token 规则
 * 同源；**只认消息开头**——句中的 `/ ` 是普通文字（「a / b」），中途的插入
 * 走拖拽或句中补全面板，不该被空格劫持。
 *
 * 命中返回 `/` 的下标（删掉它、并把 token 插回的位置），否则 null。
 */
export function slashSpaceOpensPanel(value: string, cursor: number): number | null {
  if (cursor <= 0 || cursor > value.length) return null;
  if (value.charAt(cursor - 1) !== "/") return null;
  const token = slashTokenAt(value, cursor);
  if (token === null || !token.atMessageStart || token.query !== "") return null;
  return token.start;
}

/** 长按进入可拖状态的等待时长（毫秒） */
export const LONG_PRESS_MS = 300;
/** 等待期允许的手抖位移（像素）——超过就算点选 / 滚动，不再武装拖拽 */
export const LONG_PRESS_MOVE_TOLERANCE_PX = 6;

/** 长按判定：按住够久且没移出容差，才算进入可拖状态 */
export function longPressArmed(heldMs: number, movedPx: number): boolean {
  return heldMs >= LONG_PRESS_MS && movedPx <= LONG_PRESS_MOVE_TOLERANCE_PX;
}

/**
 * 选取模式的受控接口：App 持有（面板开在哪个槽、插入锚点都在那边），面板只管
 * 上报。锚点 = 输入框里被删掉的那个 `/` 的位置——选中后 token 插回原处。
 */
export interface TokenPickerControl {
  /** 选中一条：token 插回锚点、焦点回输入框 */
  onSelect: (token: string) => void;
  /** 取消（Esc）：不插入，焦点回输入框 */
  onCancel: () => void;
  /** Tab：切到另一边（skills ↔ MCP），锚点保留 */
  onSwitch: () => void;
}

/** 面板选取的回执：token 为 null 表示取消（只把焦点送回输入框）。nonce 单调递增 */
export interface TokenPickResult {
  token: string | null;
  position: number;
  nonce: number;
}
