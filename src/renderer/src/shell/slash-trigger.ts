/**
 * 「指令 token」的判定（slashTokenAt）：一个 `/`，其前一个字符是行首或空白
 * （含全角空格），光标在 token 内（`/` 之后、下一个空白之前），且 `/` 与光标之间
 * 已打出的查询词只含指令名字符集 `[A-Za-z0-9.-]`。三道闸挡文件路径与 URL：
 *   1. 前导空白闸：`C:\Users\x.md`、`https://a/b`（`/` 前是 `:` 或字母）不命中；
 *   2. 字符集闸：`/tmp/notes.md`、`//注释` 打出第二个 `/` 即判非指令；
 *   3. 消费方自定：`/skill:` `/mcp:` 手打全形态因 `:` 不在字符集而出局。
 *
 * 唯一消费者是「`/` + 空格」开右栏选取（panel-token.ts 的 slashSpaceOpensPanel）：
 * 命中必须是消息开头、还没打任何字的孤立 `/`。
 *
 * `/skill:` / `/mcp:` 的展开边界与这里的 token 语法同源：`src/shared/invocation.ts` 的
 * findInvocationTokens 同样认「行首或空白后的 /」——右栏插进来的东西发送时必然被组装。
 *
 * 纯函数：不 import React，可被 `node --test` 直接加载。
 */

/** 光标所在的指令 token。query 是 `/` 与光标之间已打出的部分（小写）。 */
export interface SlashToken {
  /** `/` 的下标 */
  start: number;
  /** token 终点（下一个空白或文末） */
  end: number;
  query: string;
  /** token 之前只有空白 = 消息开头 */
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
