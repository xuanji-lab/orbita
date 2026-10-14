/**
 * 强调定界内侧空白的规整（2026-10-14 用户报：`**标题一般是加粗对象： **` 渲染不出）。
 *
 * CommonMark 的右侧定界规则要求收尾 `**` 前不能是空白——`**… **` 整段不算强调、
 * 原样显示星号；开口侧同理。remark-cjk-friendly 修的是 CJK 标点那条，不管空白。
 * 修法（用户裁决「把 `** 文本 **` 内侧的空白收掉」）：解析前对**非代码区域**做一次
 * 规整——把 `**…**` 定界内侧的首尾空白收掉。代码围栏与行内代码里的内容原样不动。
 */
/** 对非代码片段应用 fn：围栏代码块与行内代码整段跳过。 */
function mapNonCode(text: string, fn: (segment: string) => string): string {
  const fenceParts = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
  return fenceParts
    .map((part) =>
      part.startsWith("```") || part.startsWith("~~~")
        ? part
        : part.split(/(`[^`\n]*`)/g).map((piece) => (piece.startsWith("`") ? piece : fn(piece))).join(""),
    )
    .join("");
}

/**
 * 收掉 `**…**` 定界内侧的首尾空白（单行内、两侧至少有一个非 * 字符的内容）。
 * 只动定界内侧的空白，内容里的空白保留（正文中段的空白不受影响）。
 */
export function normalizeEmphasisInnerSpace(text: string): string {
  return mapNonCode(text, (segment) =>
    segment
      // 收尾侧：`**内容 ␣**` → `**内容**`（`**` 前的空白让右侧定界失效）
      .replace(/\*\*([^\n*]+?)[ \t]+\*\*/g, (_all, inner: string) => `**${inner}**`)
      // 开口侧：`**␣ 内容**` → `**内容**`（`**` 后的空白让左侧定界失效）
      .replace(/\*\*[ \t]+([^\n*]+?)\*\*/g, (_all, inner: string) => `**${inner.trimStart()}**`),
  );
}
