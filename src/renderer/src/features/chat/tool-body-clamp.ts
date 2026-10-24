/**
 * 工具结果展开体的读时投影（head + 提示行 + tail）——纯常量 + 纯函数，
 * `tool-body-clamp.test.ts` 锚定阈值与切口。
 *
 * **为什么在渲染层截**：实测 8 万条工具结果共 127MB 文本，其中 bash 占 57MB
 * （单条最大 479KB / 单行最大 51KB，minified 输出就是一行）；read / read_file / Read
 * 合计 39MB；p99 是 18968 字 / 371 行。展开一条 5 万字的 bash 输出 = 5 万个字符
 * 全进 DOM 文本节点 + 逐行 div，而展开体只是 320px 的滚动区——用户看不到的那部分
 * 是纯重量。**会话记录（JSONL）一个字节不动**：这是渲染前的投影，不是落盘时的裁剪，
 * 换台机器 / 换条路径读同一份记录，原文仍在。
 *
 * **口径（双阈值 + 首尾）**：
 * - 两端各按「行 + 字符」双预算取：任一预算先到就停，两条阈值各自都真的管用
 *   （只按行会给 minified 的一行 5 万字放行，只按字符会给 8 千行空行放行）；
 * - 首尾都留（ZCode `projection-rows.ts` 同款）：bash 的结果与报错在尾巴，
 *   read 的文件头在开头，砍掉任一端都会把用户真正在找的东西藏起来；
 * - 切口**尽量落回整行边界**：半截的行是噪音（grep 行的解析按整行来），而且
 *   ``` fence 行必须整行保留或整行丢掉。单行本身就超预算时（minified JSON）
 *   没有边界可用，只能硬切——这是唯一会劈开行的情形，末尾不给省略号（原文本来
 *   就没有换行，加了反而撒谎）。
 *
 * 工具展开体是**纯文本**（PlainToolBody 逐行 div / McpToolBody 的 pre），不走
 * markdown，所以没有 conv-window.ts 那种「窗口劈开 fence 要补闭合符」的问题；
 * 这里要保证的只是不在行中间下刀。
 *
 * 模块只放阈值与投影逻辑（纯数据进、纯数据出），提示行长什么样留在 ChatView
 * 的 BODY_LINE 旁——那里才是行的几何真源。
 */

/**
 * 保留的视觉行数：首 240 + 尾 160 = 400 行。依据——实测行数 p99 = 371 行，
 * 400 行刚好放行 99% 的结果；320px 的滚动区一屏约 16 行，400 行已约 25 屏，
 * 再多的行用户也不会滚到。
 */
export const BODY_HEAD_LINES = 240;
export const BODY_TAIL_LINES = 160;

/**
 * 保留的字符数：首 12000 + 尾 8000 = 20000 字（文本节点 2 万个 UTF-16 码元）。
 * 依据——实测字符 p99 = 18968 字，20000 刚好放行 99% 的结果（全量 81042 条里
 * 1002 条被截 = 1.24%；其中光字符超线的 744 条 = 0.9% 就握着 25.4MB / 127.3MB
 * = 20% 的文本量——巨物的分布是极端长尾，阈值卡在 p99 正好只切尾）。
 * **为什么取在 p99 而不是更狠**：本 PR 没有「查看全文」入口（明写在范围外），
 * 被截的就是真丢了——阈值贴着 p99 等于「只有本来就没人从头读到尾的巨物才动」。
 * 单条最坏从 479KB 收到 ≤20KB。尾巴多留（行预算 240/160 = 6:4，字符预算同比例）。
 */
export const BODY_HEAD_CHARS = 12000;
export const BODY_TAIL_CHARS = 8000;

export interface ClampedToolBody {
  /** 头部整行 */
  head: readonly string[];
  /** 尾部整行（未截断时为空——正文全在 head 里，渲染路径只有一条） */
  tail: readonly string[];
  /** null = 没截断；有值 = **原文**总行数 / 总字符数（提示行的数字） */
  omitted: { lines: number; chars: number } | null;
}

/**
 * 工具结果正文的投影。未截断时 `head` 就是原文的每一行（与 `text.split("\n")`
 * 逐字相同），渲染路径不因截断与否分叉。
 */
export function clampToolBody(text: string): ClampedToolBody {
  const lines = text.split("\n");
  if (lines.length <= BODY_HEAD_LINES + BODY_TAIL_LINES && text.length <= BODY_HEAD_CHARS + BODY_TAIL_CHARS) {
    return { head: lines, tail: [], omitted: null };
  }
  return {
    head: clipHead(lines.slice(0, BODY_HEAD_LINES).join("\n"), BODY_HEAD_CHARS).split("\n"),
    tail: clipTail(lines.slice(-BODY_TAIL_LINES).join("\n"), BODY_TAIL_CHARS).split("\n"),
    omitted: { lines: lines.length, chars: text.length },
  };
}

/**
 * 头部收口到 maxChars。切口尽量落回整行边界（切在换行符上，那条半截行整个丢掉）；
 * 预算内一个换行都没有（第一行就超预算）或是换行就在第 0 位时硬切——宁可留半行，
 * 也不能把整段内容丢掉。
 */
function clipHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  return cut <= 0 ? text.slice(0, maxChars) : text.slice(0, cut);
}

/** 尾部同理：从切口往后找第一个换行，从它后面接上（把半截行丢掉）。 */
function clipTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const start = text.length - maxChars;
  const cut = text.indexOf("\n", start);
  return cut === -1 ? text.slice(start) : text.slice(cut + 1);
}
