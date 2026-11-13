/**
 * rehype 插件：给 rehype-callouts 产出的 `.callout` 补一个 `data-kind`（归一后的视觉类型：
 * `caution` → `warning`、`error` → `danger`…），样式只需要写十来条，不必为几十个别名各写一份。
 * 必须排在 rehype-callouts 之后。阅读视图与 PDF 导出共用。
 */
import { calloutKind } from "./syntax.ts";

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function visit(node: HastNode): void {
  if (node.type === "element" && node.properties !== undefined) {
    const raw = node.properties["data-callout"];
    if (typeof raw === "string") node.properties["data-kind"] = calloutKind(raw);
  }
  for (const child of node.children ?? []) visit(child);
}

export function rehypeCalloutKind(): (tree: HastNode) => void {
  return (tree) => visit(tree);
}
