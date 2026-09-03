/**
 * 「这里本来就没有」和「我读不出来」是两件事。
 *
 * 读磁盘失败时最容易写的是 `catch { return [] }`——它把两件事压成同一句话。
 * 代价在用户那边：22 条会话好端端躺在盘上，只因为目录权限坏了，
 * 侧栏说的却是「还没有任务」。用户据此去翻备份、去重装，
 * 而重装可能真的把它们删掉——**软件读不到，不等于用户没有。**
 *
 * 所以 catch 里必须看一眼原因：只有「查无此物」才配返回空。
 */

/** 取 Node 的 errno（ENOENT / EACCES / ...）。不是 errno 错误就返回 null。 */
export function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * 查无此物——文件或目录不存在。**只认 ENOENT。**
 *
 * 特意不含 `ENOTDIR`（该是目录的地方成了文件）和 `EACCES`（没权限）：
 * 它们都说明磁盘上的东西不是我们以为的样子，属于「读不出来」，该让用户看见。
 */
export function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}
