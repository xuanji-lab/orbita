/**
 * 更新说明（`UpdateInfo.releaseNotes`）→ 界面能直接显示的纯文本。
 *
 * 为什么要在边界上转一次：GitHub provider 的 releaseNotes 取自 Release atom feed 的
 * `<content>`，也就是**发布正文的 HTML**（我们自己的 Release 正文是一整份功能总览，
 * 而不是几行 changelog）。在设置页那一行里渲染 HTML，要么引一条 sanitize 管线、要么把
 * 「更新」这一行变成文档阅读器；回答「这次更新带来了什么」，纯文本够了。
 *
 * 处理顺序：块级标签断行 → 剥掉剩下的标签 → 解实体 → 收敛空行 → 超长截断。
 * **先剥标签再解实体**是有意的：解出来的 `&lt;` 是正文文本，不该再被当成标签；
 * 反过来先解实体的话，「1 &lt; 2 and x &gt; 3」会被当成一个标签吃掉。
 */

/** 说明文本的字节预算：设置页一张折叠面板，正文是给人扫一眼的，不是拿来读文档的 */
const NOTE_LIMIT = 4000;

/** 块级标签的收尾（`</p>` / `</li>` …）：这些位置在原文里是换行 */
const BLOCK_END_RE = /<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre)\s*>/gi;

/** 数字实体：超出 Unicode 范围的原样丢掉（不为了解一个实体把整段说明抛掉） */
function numericEntity(raw: string, code: string): string {
  const value = Number(code);
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

export function releaseNotesText(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const lines = raw
    // 列表项先变成「· 」开头的行，`<br>` 与块级收尾变换行——否则整篇挤成一行
    .replace(/<li[^>]*>/gi, "\n· ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(BLOCK_END_RE, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&#(\d+);/g, numericEntity)
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    // `&amp;` 最后解：先解的话 `&amp;lt;` 会解出半个标签
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    // 空行整个丢掉：块级标签之间本来就有换行，剥完标签会多出一批空行；
    // 折在面板里的说明按「一行一条」扫，比按段落读更合用
    .filter((line) => line !== "");
  const text = lines.join("\n").trim();
  if (text === "") return null;
  return text.length > NOTE_LIMIT ? `${text.slice(0, NOTE_LIMIT)}…` : text;
}
