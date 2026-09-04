/**
 * 金额防误判（docs/plans/2026-09-04-数学公式渲染.md 决定 2）：remark-math 会把
 * `$5 and $10` 认成行内公式「5 and 」——实测 2026-09-04。规则：**定界符贴着空白**
 * （值以空白开头或结尾）的是钱/词边界，不是 TeX——真公式从不写作 `$ x $`——
 * 降级回文本节点。只看行内公式：块级 `$$` 自成一行，不存在金额混淆。
 *
 * 在 remark-math 之后挂（MarkdownBlock 的 remarkPlugins 末位）。
 * ponytail: `$5和$6` 这种无空白 CJK 邻接仍是已知漏网，真遇到再补「后邻是数字」规则。
 */

/** 够用的 mdast 子集：本插件只读 type/value、替换 children */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

export function demoteBoundaryMath(node: MdNode): void {
  const children = node.children;
  if (children === undefined) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    if (child.type === "inlineMath") {
      const value = typeof child.value === "string" ? child.value : "";
      if (/^\s/.test(value) || /\s$/.test(value)) {
        // 还原成它本来的源码形状，作为纯文本继续走渲染
        children[i] = { type: "text", value: `$${value}$` };
        continue;
      }
    }
    demoteBoundaryMath(child);
  }
}

/**
 * unified 插件形状：**工厂返回变换器，且使用处传工厂本身、不要调用**——
 * `.use(remarkDemoteBoundaryMath)`。unified 在首个 parse 冻结时以无参调用插件，
 * 直接塞变换器或提前调用工厂，都会让 tree = undefined 当场崩
 * （2026-09-04 黑屏事故根因）。
 */
export function remarkDemoteBoundaryMath(): (tree: MdNode) => void {
  return (tree) => {
    demoteBoundaryMath(tree);
  };
}
