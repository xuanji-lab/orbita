/**
 * rehype 插件：给阅读视图的块级元素（段落 / 列表项 / 标题 / 代码块 / 引用 / 表格行…）标上它在 markdown 源码里的
 * 起止行（`data-sl` / `data-el`，1 起）。阅读视图划选后据此把渲染出来的文字映射回源码行——
 * 引用拿到的是源码里的原文与行号，agent 用 edit 才能逐字对上。
 * 必须排在会重建节点的插件（raw / sanitize / callouts）之后；元素没有 position（OFM 自己生成的属性表等）就不标。
 */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  position?: { start?: { line?: number }; end?: { line?: number } };
  children?: HastNode[];
}

const BLOCKS: ReadonlySet<string> = new Set([
  "p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "tr", "summary",
]);

function visit(node: HastNode): void {
  if (node.type === "element" && node.tagName !== undefined && BLOCKS.has(node.tagName)) {
    const start = node.position?.start?.line;
    const end = node.position?.end?.line;
    if (typeof start === "number" && typeof end === "number") {
      node.properties = { ...(node.properties ?? {}), "data-sl": start, "data-el": end };
    }
  }
  for (const child of node.children ?? []) visit(child);
}

export function rehypeSourceLines(): (tree: HastNode) => void {
  return (tree) => visit(tree);
}
