/**
 * markdown 顶层分块（性能）：把一条消息的 markdown 按顶层块边界切成若干块，
 * 交给 MarkdownBlock 逐块 memo 渲染。流式期间 transcript 每帧都产生新文本，但
 * **前面已完成的块字符串逐字不变**——memo 命中，每帧只有仍在增长的尾块重跑
 * remark → rehype 整条链（最贵的 KaTeX / shiki 另见 stream-render.ts）。
 *
 * 正确性优先于切得碎（Proma #1673 的教训）：**切开必须与整篇解析等价**，
 * 拿不准就并回一块、甚至整体退回单块。逐条守住的口径（都在测试里钉住）：
 *
 * - **代码围栏**（``` / ~~~，含 info string）配对优先，中间的空行不是切点；
 *   反引号围栏的 info string 里再出现反引号不算围栏（行内代码开头的 ``` 场景）。
 * - **块级公式 `$$…$$`** 同理：mathFlow 允许中间有空行（`$$\na\n\nb\n$$` 是一块
 *   公式），逐块切会把它劈成两段文本——按 micromark-extension-math 的口径开闭。
 * - **缩进续行**（列表项 / 引用的续段、嵌套列表）并回它所属的块：4 空格缩进被单独
 *   切开会被当成缩进代码块，列表也会被拆散。
 * - **松散列表**：相邻两个列表块属于同一个 loose list（`- a\n\n- b` 是一个两项列表），
 *   之间有空行也不能切。
 * - **链接引用定义 / 脚注定义**（`[id]: url`）：定义与使用分处两块时使用处会渲染成
 *   字面量 `[x]`，**整篇退回单块**。
 * - **块级 HTML 标签**（`<details>` / `<div>` …）：rehype-raw 是整篇一起重解析的，
 *   未闭合的标签会把后面所有节点吞进自己里面；逐块解析则各块独立。所以这类标签
 *   还开着时（含跨空行的 `<!-- -->`）不切。另外，**HTML 块内部的行不是 markdown**
 *   （CommonMark 的 HTML 块一直持续到下一个空行）：跟在 `<details>` 行后粘着写的
 *   ``` / $$ / 表格行都是原始 HTML 文本，那里开的围栏不算围栏。HTML 块**不能打断
 *   段落**——它只在空行（或串首）之后才算开，粘在段落后面的一行是段落内容。
 *
 * 切出来的每块是原文的**连续子串**，`blocks.join("") === text`——空行（可能是连续的
 * 好几行）原样留在前一块里，不做归一化：缩进代码块里的空行数量也是内容。
 *
 * 纯模块：不 import React、不 import CSS，`node --test` 直接加载。
 */

/** 列表项行：≤3 空格缩进 + `-` / `*` / `+` 或 `1.` / `1)` 前缀（后面必须是空白或行尾） */
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** 引用行（`>` 开头，≤3 空格缩进） */
const BLOCKQUOTE_RE = /^ {0,3}>/;

/** 引用前缀（`> ` 可叠加）：引用里的列表 / 缩进续行与外层是同一套规则 */
const QUOTE_PREFIX_RE = /^(?: {0,3}>[ \t]?)+/;

/** 去掉引用前缀，看剩下的内容（`> - a` 的剩余是 `- a`） */
function stripQuotes(line: string): string {
  return line.replace(QUOTE_PREFIX_RE, "");
}

/** 围栏开启行：≤3 空格缩进 + 3 个及以上反引号或波浪线，其余是 info string */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** 围栏关闭行：≤3 空格缩进 + 同种围栏字符，行尾只剩空白 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * 块级公式开启行：`$$`（2 个及以上）起手，**行尾余下部分不含 `$`**。
 * 与 micromark-extension-math 的 mathFlow 一致：`$$x$$` 是同行的行内公式（不算块级），
 * `$$asciimath` 这种「开围栏 + 元信息」的写法也算块级，元信息与内容无关。
 */
const MATH_OPEN_RE = /^ {0,3}(\$+)([^$]*)$/;

/** 块级公式关闭行：同种 `$` 且不少于开启时的个数，行尾只剩空白 */
const MATH_CLOSE_RE = /^ {0,3}(\$+)[ \t]*$/;

/** ATX 标题行（段落到它为止；它后面可以接 HTML 块） */
const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

/** 链接引用定义 / 脚注定义：定义与使用被切开就渲染不出链接 */
const DEFINITION_RE = /^ {0,3}\[(?:\^[^\]]*|[^\]]+)\]:/;

/**
 * 能跨空行吞掉后续内容的块级 HTML 标签（CommonMark 的 type 1 与 type 6 里去掉空元素）。
 * 只认这些：行内的 `<span>` / `<b>` 之类不出现在顶层 HTML 块里，不必为它们放弃分块。
 */
const HTML_BLOCK_TAG: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "center", "colgroup", "dd", "details",
  "dialog", "dir", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "frameset",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "html", "iframe", "legend", "li", "main", "menu",
  "nav", "noframes", "ol", "optgroup", "option", "p", "pre", "script", "search", "section", "style",
  "summary", "table", "tbody", "td", "textarea", "tfoot", "th", "thead", "title", "tr", "ul",
]);

/** 空元素：没有闭合标签，不入栈（标签白名单里的 base / col / hr / link / param / track 等） */
const HTML_VOID_TAG: ReadonlySet<string> = new Set([
  "area", "base", "basefont", "br", "col", "embed", "frame", "hr", "img", "input", "link", "menuitem",
  "meta", "param", "source", "track", "wbr",
]);

/** HTML 标签（含属性里的引号内容，避免把属性里的 `>` 当成标签结束） */
const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;

/** 行内代码：讲 HTML 语法的消息里 `` `<div>` `` 不是真的标签 */
const INLINE_CODE_RE = /`[^`]*`/g;

/**
 * 这一行是否开启一个块级 HTML 块（CommonMark 的 type 6 / type 7 开头条件）。
 * 从这一行到下一个空行之间是**原始 HTML**：里面根本不是 markdown 语法。
 * 调用方还得满足「上一行结束时没有开着段落」——HTML 块不能打断段落。
 * 它不影响「能不能切」——空行本来就结束 HTML 块，也是合法的切点。
 */
function startsHtmlBlock(line: string): boolean {
  const blockTag = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:[ \t]|\/?>|$)/.exec(line);
  if (blockTag !== null && HTML_BLOCK_TAG.has(blockTag[1]!.toLowerCase())) return true;
  // type 7：整行只有一个完整的开 / 闭标签（<br> / <span class="x"> 这类也算）
  return /^ {0,3}<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[ \t][^<>]*)?\/?>[ \t]*$/.test(line);
}

/** 跨空行的 HTML 注释状态 */
interface CommentState {
  open: boolean;
}

/**
 * 去掉行内代码与注释段，返回这一行里「看得见」的 HTML 部分，并顺手更新注释状态。
 * 注释跨空行也是 HTML 块（type 2），底下全是注释内容、不构成切点。
 */
function withoutComments(line: string, comment: CommentState): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (comment.open) {
      const end = line.indexOf("-->", i);
      if (end < 0) return out;
      comment.open = false;
      i = end + 3;
      continue;
    }
    const start = line.indexOf("<!--", i);
    if (start < 0) return out + line.slice(i);
    out += line.slice(i, start);
    comment.open = true;
    i = start + 4;
  }
  return out;
}

/** 把这一行里的块级 HTML 开闭标签记到栈上（`</div>` 弹出它以及它上面还没闭合的） */
function trackHtml(line: string, stack: string[], comment: CommentState, raw: boolean): void {
  // HTML 块里的行是原始 HTML：反引号不会让它变成「行内代码」，`` `<div>` `` 里的 div 是真标签
  // ——同理，里面的 `<!--` 也不开注释块（注释块只在顶层开头），不跟后面的 `-->` 配对
  const body = raw ? line.replace(/<!--[\s\S]*?-->/g, "") : withoutComments(line, comment);
  const code = raw ? body : body.replace(INLINE_CODE_RE, "");
  HTML_TAG_RE.lastIndex = 0;
  for (let hit = HTML_TAG_RE.exec(code); hit !== null; hit = HTML_TAG_RE.exec(code)) {
    const name = hit[2]!.toLowerCase();
    if (!HTML_BLOCK_TAG.has(name)) continue;
    if (hit[1] === "/") {
      const at = stack.lastIndexOf(name);
      if (at >= 0) stack.length = at;
      continue;
    }
    if (hit[4] === "/" || HTML_VOID_TAG.has(name)) continue;
    stack.push(name);
  }
}

/**
 * 后一块是否必须并回前一块（并回去 = 用原文切片拼在一起，等于没切）。
 * 只有「切开会改变渲染」的情形才并：
 * - **前一块里有列表项 + 后一块是列表项**：列表项会把后面不缩进的段落行当惰性续行吞下，
 *   中间空行隔开的两个列表也会并成同一个列表（`- a\n\n- b` 是一个两项列表）。
 *   只要前一块里有列表项行就并——列表是个能吃后续行的容器，宁可多并（多并只损性能）。
 * - **缩进开头**：缩进内容是前一块的容器（列表项 / 缩进代码）里的东西时，切开就断了
 *   归属关系。前一块只是普通段落时不并——缩进代码块与松散段落本来就自成一块，
 *   切开渲染与整篇等价（缩进代码的后续行会被下面那条重新并起来）。
 * 引用里的列表按同样规则看（`> - a\n\n> - b` 也是同一个 loose list）。
 */
function shouldMergeWithPrevious(previous: string, next: string): boolean {
  const previousLines = previous.split("\n");
  // 末行可能只是块尾带下来的空行（空行归前一块），要看的是最后一行**内容**
  let lastIndex = previousLines.length - 1;
  while (lastIndex > 0 && previousLines[lastIndex]!.trim() === "") lastIndex -= 1;
  const rawLast = previousLines[lastIndex]!;
  const hasList = previousLines.some((line) => LIST_ITEM_RE.test(stripQuotes(line)));
  const lastIndented = /^[ \t]/.test(stripQuotes(rawLast));
  const nextLine = stripQuotes(next);
  if (/^[ \t]/.test(nextLine)) {
    return hasList || lastIndented || BLOCKQUOTE_RE.test(rawLast);
  }
  return LIST_ITEM_RE.test(nextLine) && hasList;
}

/**
 * 按顶层块边界切 markdown。返回的各块是原文的连续子串，拼接逐字等于原文
 * （空行留在前一块里）；`[text]` 表示「不值得切 / 切开不安全，整体一块渲染」。
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (text === "") return [];

  const lines = text.split("\n");
  // 每行在原文里的起点：切块用偏移量取原文，保证拼回去逐字相等
  const starts: number[] = new Array<number>(lines.length);
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    starts[i] = offset;
    offset += lines[i]!.length + 1;
  }
  /** 第 i 行的结束偏移（含换行；最后一行到串尾） */
  const lineEnd = (i: number): number =>
    i === lines.length - 1 ? text.length : starts[i]! + lines[i]!.length + 1;
  const slice = (from: number, to: number): string => text.slice(starts[from]!, lineEnd(to));

  let fence: { char: string; size: number } | null = null;
  /** >0 表示在块级公式里，值是开启围栏的 `$` 个数 */
  let mathSize = 0;
  /** 还没闭合的块级 HTML 标签 */
  const htmlStack: string[] = [];
  const comment: CommentState = { open: false };
  /** 上一行开了 HTML 块（type 6 / type 7）：到下一个空行之间都是原始 HTML */
  let inHtmlBlock = false;
  /** 上一行结束时段落还开着：HTML 块不能打断段落，只有段落没开时才可能开头 */
  let paragraphOpen = false;
  let crossBlock = false;

  const ranges: Array<[number, number]> = [];
  let start = 0;
  let hasContent = false;
  /** 撞到过顶层空行：下一行非空时就在它前面切 */
  let pendingCut = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // HTML 块不能打断段落：只有「段落没开着」时这一行才可能是 HTML 块的开头
    const previousParagraphOpen = paragraphOpen;

    if (fence !== null) {
      const close = FENCE_CLOSE_RE.exec(line);
      if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.size) fence = null;
      hasContent = true;
      paragraphOpen = false;
      continue;
    }
    if (mathSize > 0) {
      const close = MATH_CLOSE_RE.exec(line);
      if (close !== null && close[1]!.length >= mathSize) mathSize = 0;
      hasContent = true;
      paragraphOpen = false;
      continue;
    }
    if (line.trim() === "") {
      // 顶层空行是切点；HTML 标签还开着时不切（整篇解析会把后面吞进标签里）
      inHtmlBlock = false;
      paragraphOpen = false;
      if (hasContent && htmlStack.length === 0 && !comment.open) pendingCut = true;
      continue;
    }
    if (pendingCut) {
      ranges.push([start, i - 1]);
      start = i;
      pendingCut = false;
    }
    hasContent = true;

    // HTML 块里的行与注释里的行都不是 markdown（CommonMark 口径）
    if (!inHtmlBlock && !comment.open) {
      const open = FENCE_OPEN_RE.exec(line);
      if (open !== null) {
        const marker = open[1]!;
        // CommonMark：反引号围栏的 info string 里不许再出现反引号
        if (!(marker[0] === "`" && (open[2] ?? "").includes("`"))) {
          fence = { char: marker[0]!, size: marker.length };
          paragraphOpen = false;
          continue;
        }
      }
      const mathOpen = MATH_OPEN_RE.exec(line);
      if (mathOpen !== null && mathOpen[1]!.length >= 2) {
        mathSize = mathOpen[1]!.length;
        paragraphOpen = false;
        continue;
      }
      if (DEFINITION_RE.test(line)) crossBlock = true;
      if (!previousParagraphOpen && startsHtmlBlock(line)) inHtmlBlock = true;
      paragraphOpen = !ATX_HEADING_RE.test(line);
    }
    // raw = 这一行属于一个 HTML 块（注释块里的行仍要走 withoutComments 才能认出并收尾）
    trackHtml(line, htmlStack, comment, inHtmlBlock);
  }
  ranges.push([start, lines.length - 1]);

  // 定义与使用分处两块会渲染成字面量——整篇退回单块（LLM 输出里极少见）
  if (crossBlock) return [text];

  // 并回不能独立渲染的相邻块（缩进续行 / 松散列表）
  const blocks: string[] = [];
  let from = ranges[0]![0];
  let to = ranges[0]![1];
  for (let k = 1; k < ranges.length; k += 1) {
    const next = ranges[k]!;
    if (shouldMergeWithPrevious(slice(from, to), slice(next[0], next[1]))) {
      to = next[1];
    } else {
      blocks.push(slice(from, to));
      from = next[0];
      to = next[1];
    }
  }
  blocks.push(slice(from, to));
  return blocks;
}
