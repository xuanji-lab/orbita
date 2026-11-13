/** 草稿路径的最后一段（文件夹名）：不依赖 node:path（renderer 里没有），两种分隔符都认，忽略结尾的斜杠。 */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== "" && part !== ".");
  return parts[parts.length - 1] ?? "";
}
