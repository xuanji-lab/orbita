/**
 * 指令面板（/）的触发判定与选中后的文本改写。
 *
 * 触发 = 光标所在的「指令 token」：一个 `/`，其前一个字符是行首或空白（含全角
 * 空格），光标在 token 内（`/` 之后、下一个空白之前），且 `/` 与光标之间已打出的
 * 查询词只含指令名字符集 `[A-Za-z0-9.-]`。三道闸挡文件路径与 URL（竞品调研结论，
 * 见 PR 描述）：
 *   1. 前导空白闸：`C:\Users\x.md`、`https://a/b`（`/` 前是 `:` 或字母）不触发；
 *   2. 字符集闸：`/tmp/notes.md`、`//注释` 打出第二个 `/` 即判非指令；
 *   3. 前缀命中闸（补全模式，见 Composer）：无命中不弹、不渲染空态。
 *
 * token 处于消息开头（之前只有空白）→ **主模式**：面板列动作项 + skill、空态可
 * 显示、Enter 选中（PR #146 已验收的语义，不动）。中途 token → **补全模式**：只列
 * 前缀命中的 skill 行、默认不高亮（Enter 原样落下，打路径时不抢键——Claude Code
 * fullscreen 同款）。
 *
 * `/skill:` / `/mcp:` 的展开边界与这里的 token 语法同源：`src/shared/invocation.ts` 的
 * findInvocationTokens 同样认「行首或空白后的 /」——面板补出来的东西发送时必然被组装。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */

/** 光标所在的指令 token。query 是 `/` 与光标之间已打出的部分（小写）。 */
export interface SlashToken {
  /** `/` 的下标 */
  start: number;
  /** token 终点（下一个空白或文末）——补全选中的替换范围 */
  end: number;
  query: string;
  /** token 之前只有空白 = 消息开头的主模式 */
  atMessageStart: boolean;
}

const QUERY_CHARS = /^[A-Za-z0-9.-]*$/;

/** 光标不在任何指令 token 上时返回 null。 */
export function slashTokenAt(value: string, cursor: number): SlashToken | null {
  if (cursor <= 0 || cursor > value.length) return null;
  // 从光标往回找最近的 "/"，中途撞到空白就出局（光标已越过 token）
  let start = -1;
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = value.charAt(i);
    if (/\s/.test(ch)) break;
    if (ch === "/") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  // "/" 的前一个字符必须是行首或空白：C:/Users、https:// 之类出局
  if (start > 0 && !/\s/.test(value.charAt(start - 1))) return null;
  // 已打出的部分只认指令名字符集：/tmp/…、//注释、/skill:xxx（手打全形态）出局
  const raw = value.slice(start + 1, cursor);
  if (!QUERY_CHARS.test(raw)) return null;
  let end = start + 1;
  while (end < value.length && !/\s/.test(value.charAt(end))) end++;
  return {
    start,
    end,
    query: raw.toLowerCase(),
    atMessageStart: value.slice(0, start).trim() === "",
  };
}

/**
 * 选中指令后只替换 token 本身，前后文（含同行的附加指示）原样保留。
 * 插入串自带的尾随空格遇到 token 后面本来就有的空白时省掉，不叠成双空格——
 * 省掉后 `token.start + insertion.length` 恰好落在原有那个空白之后，光标位置不变。
 */
export function replaceToken(value: string, token: SlashToken, insertion: string): string {
  const after = value.slice(token.end);
  const text = /\s$/.test(insertion) && /^\s/.test(after) ? insertion.slice(0, -1) : insertion;
  return value.slice(0, token.start) + text + after;
}

/**
 * 输入是否可能处于主模式（第一行以 / 开头）。与光标无关——主模式关闭态
 * （esc / insert）的重置跟内容走，不跟光标走。
 */
export function slashMode(value: string): boolean {
  const newline = value.indexOf("\n");
  const firstLine = newline === -1 ? value : value.slice(0, newline);
  const trimmed = firstLine.trimStart();
  return trimmed.startsWith("/") && !trimmed.startsWith("//");
}
