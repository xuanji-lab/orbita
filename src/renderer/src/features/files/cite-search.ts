/**
 * 检索回包的「还算不算数」判定 —— 从面板里抽出来只为能单测（评审 F1）。
 *
 * 面板里发生过的事：输入 A 点查找 → 还没回来就改成 B → A 的回包把列表填成 A 的结果，
 * 输入框显示的是 B，回车把 **A** 写进 .bib 并插进正文。两条判据一起用：
 * 1. **请求序号**：每次查找 / 每次改输入都 +1，旧回包的序号对不上就作废；
 * 2. **查询快照**：回包带的 query 与此刻输入框里的字（规范化后）不同，也作废——
 *    序号只能防「更新的请求已经发出」，快照还能防「只是改了字、没再查」。
 */
export function isStaleResponse(
  currentQuery: string,
  requestedQuery: string,
  requestSeq: number,
  latestSeq: number,
): boolean {
  if (requestSeq !== latestSeq) return true;
  return normalizeQuery(currentQuery) !== normalizeQuery(requestedQuery);
}

/** 比较口径：首尾空白、连续空白、大小写都不算「改了查询」 */
export function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}
