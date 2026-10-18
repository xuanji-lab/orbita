/**
 * 更新说明（`UpdateInfo.releaseNotes`）→ 界面逐条渲染的条目。
 *
 * **发布约定**：Release 正文每行一条，行首可选 `[icon:名字]` 前缀指定这一条的图标，
 * 名字是 lucide 图标名（例：`[icon:download] Windows auto-update: ...`）。没有前缀的条目
 * 就没有图标；名字写错了也只是没图标（白名单在 renderer 的 Icon.tsx，见下）。
 * 新功能发布时选当时那个功能的图标——图标只是条目符号，不是每种变更的封闭分类表。
 * 用 markdown 列表写也行：行首的 `-` / `*` / `·` 记号会被剥掉再看前缀。
 *
 * **软件里的说明与 GitHub Release 页分开写**（2026-10-18 用户：「release page 粘贴归粘贴，
 * 软件里的还是更人性化更通俗易懂一些的」——软件里是普通用户，Release 页是专业用户）：
 * - 软件里：打包时从 package.json 的 `build.releaseInfo.releaseNotes` 写进 `latest.yml` 的几行
 *   纯文本（electron-builder 的 updateInfoBuilder）。更新器优先读它（GitHubProvider：yml 里
 *   有 releaseNotes 就不碰 feed），「历史版本」也去下载每一版的 latest.yml 读它；
 * - Release 页正文：随便写的完整文档，**不进软件**。latest.yml 里没写说明时，electron-updater
 *   会退回去拿 Release 页 atom feed 的 HTML（fullChangelog 时是数组）——appNotesOf 看到 HTML
 *   或数组一律当没有说明，宁可不显示也不把整篇文档塞进设置页。
 * 下面仍能剥 HTML 标签与实体，是防御：纯文本里偶尔出现的实体照样解开。
 *
 * 处理顺序：块级标签断行 → 剥掉剩下的标签 → 解实体 → 去空行 → 拆条目（前缀 + 图标名）。
 * **先剥标签再解实体**是有意的：解出来的 `&lt;` 是正文文本，不该再被当成标签；
 * 反过来先解实体的话，「1 &lt; 2 and x &gt; 3」会被当成一个标签吃掉。
 */
import type { UpdateNote } from "../../shared/updater.ts";

/** 条目的字节预算：设置页一张折叠面板，正文是给人扫一眼的，不是拿来读文档的 */
const NOTE_LIMIT = 4000;

/** 块级标签的收尾（`</p>` / `</li>` …）：这些位置在原文里是换行 */
const BLOCK_END_RE = /<\/(?:p|div|li|ul|ol|h[1-6]|tr|table|blockquote|pre)\s*>/gi;

/** 行首的列表记号（markdown 的 `-` / `*`，以及 `<li>` 转出来的 `·`）；可叠多层 */
const BULLET_RE = /^(?:[·•*+-]\s+)+/;

/** 图标前缀。名字限定小写字母 / 数字 / 连字符——lucide 的名字就是这个形状 */
const ICON_PREFIX_RE = /^\[icon:([a-z0-9-]+)\]\s*(.*)$/;

/** 数字实体：超出 Unicode 范围的原样丢掉（不为了解一个实体把整段说明抛掉） */
function numericEntity(_match: string, code: string): string {
  const value = Number(code);
  return Number.isInteger(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** HTML 正文 → 逐行纯文本 */
function toLines(raw: string): string[] {
  return raw
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
}

export function parseReleaseNotes(raw: string | null | undefined): UpdateNote[] | null {
  if (raw === null || raw === undefined) return null;
  const notes: UpdateNote[] = [];
  let budget = NOTE_LIMIT;
  for (const line of toLines(raw)) {
    // 记号先剥掉再认前缀：markdown 列表里写 `- [icon:download] …` 也该认出来
    const bare = line.replace(BULLET_RE, "");
    const match = ICON_PREFIX_RE.exec(bare);
    const icon = match === null ? null : (match[1] ?? null);
    const text = match === null ? bare : (match[2] ?? "");
    // 只有前缀没有正文的行不是一条说明（写错格式时的静默降级：那条不出现）
    if (text === "") continue;
    // 超长截断：截断的是正文总量，后续条目继续按剩余预算收
    if (budget <= 0) break;
    const clipped = text.length > budget ? `${text.slice(0, budget)}…` : text;
    budget -= clipped.length;
    notes.push({ icon, text: clipped });
  }
  return notes.length === 0 ? null : notes;
}

/** 一个 HTML 标签：出现它就说明这份说明来自 Release 页的 feed，不是 latest.yml 里的纯文本 */
const HTML_TAG_RE = /<\/?[a-z][^>]*>/i;

/**
 * `UpdateInfo.releaseNotes`（字段原样传进来）→ 软件里显示的条目。**只认 latest.yml 里的纯文本**：
 * 不是字符串（没写 / fullChangelog 数组）或带 HTML 标签（electron-updater 退回去拿了 Release 页
 * 正文）都返回 null——那份是给专业用户的完整文档，不进软件（见文件头）。
 * 更新器（service.ts）与「历史版本」（recent-releases.ts）共用这一个口子。
 */
export function appNotesOf(releaseNotes: unknown): UpdateNote[] | null {
  if (typeof releaseNotes !== "string" || HTML_TAG_RE.test(releaseNotes)) return null;
  return parseReleaseNotes(releaseNotes);
}
