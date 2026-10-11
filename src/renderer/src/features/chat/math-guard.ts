/**
 * 公式误判降级（docs/plans/2026-09-04-数学公式渲染.md 决定 2 起步）：remark-math
 * 会把不像 TeX 的 `$…$` 认成行内公式，两类都在这里降回文本节点：
 *
 * 1. **金额/词边界**（2026-09-04 实测）：`$5 and $10` 被认成「5 and 」。
 *    规则：定界符贴着空白（值以空白开头或结尾）不是 TeX——真公式从不写作
 *    `$ x $`。
 * 2. **代码/命令特征**（2026-10 实测）：用户气泡里的 shell 命令
 *    `… for i in $(seq 1 12); do echo '<html></html>' > x/$i.html; done` 被配成
 *    行内公式「(seq 1 12); do echo '<html></html>' > x/」。规则：值含下列任一特征——
 *    - 裸 `;`（不带 `\` 前缀）：shell 语句分隔符；LaTeX 里 `\;` 是厚空格、必带反斜杠，
 *      裸 `;` 在行内公式里几乎不出现；
 *    - 直引号 `'` `"` 或反引号：LaTeX 排版用弯引号，这三个是 shell 字符串与
 *      markdown 代码的标志；
 *    - `&&` / `||`：shell 逻辑运算符；LaTeX 对齐符 `&` 只在块级环境里单个出现。
 *      代价：`$||v||$` 这种把范数写成双竖线的濫用会被误降级——正式写法是
 *      `$\lVert v\rVert$`，而聊天文本里 `||` 几乎只能是 shell。
 *
 * 常见 LaTeX 不得误伤（remark-math 6.0.0 实测锚点）：`$x^2$`、`$a<b$`、
 * `$\frac{a}{b}$`、`$(a+b)^2$`——以 `(` 开头不是降级信号（与 `$(` 命令替换的区分
 * 就靠值里的 `;`/引号），都不含上述特征、保持公式。
 *
 * 只看行内公式：块级 `$$` 自成一行，不存在金额混淆，代码该走围栏而不是 `$$`。
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

/** 行内公式的值里像代码/命令而不像 TeX 的特征（见上方注释的理由与代价） */
const CODE_SIGNAL = /(?:^|[^\\]);|['"`]|&&|\|\|/;

export function demoteBoundaryMath(node: MdNode): void {
  const children = node.children;
  if (children === undefined) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i]!;
    if (child.type === "inlineMath") {
      const value = typeof child.value === "string" ? child.value : "";
      if (/^\s/.test(value) || /\s$/.test(value) || CODE_SIGNAL.test(value)) {
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
