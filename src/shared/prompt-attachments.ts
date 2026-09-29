/**
 * 用户消息附带的文件引用与粘贴文本块——契约、阈值与组装/解析。
 *
 * 与图片（`prompt-images.ts`，base64 进模型）不同，文件**不发内容只发路径**：
 * pi 协议的用户块只有 text | image（0.84.3，没有 document / file 块），二进制
 * 根本没有可发的形态；而引用的文件本来就在用户磁盘上，模型用 read 工具自己读。
 * 「把一段正文直接给模型」的场景由粘贴文本块承载——全文、永不截断（wafo 裁决：
 * 用户复制进来的一大段可能正是要紧内容，截断等于静默改写他的话）。
 *
 * 三类附件在模型与转录里是**同一条 user 消息**：正文在前，粘贴块与文件清单依次
 * 跟在后面（`composePromptText`），块与块之间以 XML 标签为界。agent 进程组装出的
 * 回显块（transcript-adapter）用的就是这些带标签的文本，显示时解析回 chip——
 * 与 quote 同一个先例：块标签是给模型与转录的共同语言，显示层负责拆回来。
 */

/**
 * 发送载荷里的文件引用（renderer → 主进程）。`origin` 决定主进程要不要落盘复制：
 * workspace = 文件面板引用的、本来就在根里，原位置引用；external = 按钮 / 拖拽 /
 * 粘贴进来的，发送时复制进会话附件目录、引用指向副本——副本必在 agent read 的
 * 边界内，原文件挪走也不断，回放不依赖原位置。
 */
export interface PromptFileRef {
  path: string;
  name: string;
  kind: "file" | "dir";
  origin: "workspace" | "external";
}

/**
 * 主进程 → agent 进程的文件引用。external 的已复制进会话目录、`path` 已换成副本；
 * `kind` 已按盘上事实修正（renderer 分不清拖进来的是文件还是目录）；
 * `path` 都 realpath 成本机规范形——模型读到的是一条能直接用的干净路径。
 */
export interface SentFileRef {
  path: string;
  name: string;
  kind: "file" | "dir";
}

/** 一条消息最多几个文件引用。与图片各 10 个、互不挤占（wafo 裁决：槽位不按类型合并） */
export const PROMPT_FILE_MAX_COUNT = 10;

/** 粘贴文本折叠阈值：超过任一即从输入框抽出成折叠块（未超过照常留在输入框里） */
export const PASTED_TEXT_MAX_LINES = 10;
export const PASTED_TEXT_MAX_CHARS = 2000;

/** 行数按去尾换行后算——粘贴末尾带的换行不该数出一个幻影行 */
export function pastedTextSize(text: string): { lines: number; chars: number } {
  const body = text.replace(/\n+$/, "");
  return { lines: body === "" ? 0 : body.split("\n").length, chars: Array.from(body).length };
}

/** 这段粘贴文字要不要抽成折叠块。按码点计字（quote 的 countChars 同一口径） */
export function isPastedTextLarge(text: string): boolean {
  const { lines, chars } = pastedTextSize(text);
  return lines > PASTED_TEXT_MAX_LINES || chars > PASTED_TEXT_MAX_CHARS;
}

/** 粘贴正文里出现闭合标签会提前截断整块——改写掉（quote 的 sanitizeBody 同一招） */
function sanitizePastedBody(text: string): string {
  return text.replace(/<\/pasted-text>/gi, "</pasted-text_>");
}

/** 一段粘贴文本 → 带标签的块（模型与转录回显看到的就是它） */
export function pastedBlockOf(text: string): string {
  return `<pasted-text>\n${sanitizePastedBody(text)}\n</pasted-text>`;
}

/** 文件清单块里的一行。路径里按理没有换行，有也压成空格——一行一个路径是解析的前提 */
function fileLine(ref: { path: string; kind: "file" | "dir" }): string {
  const clean = ref.path.replace(/\r?\n/g, " ");
  return ref.kind === "dir" ? `- ${clean}${clean.endsWith("/") ? "" : "/"}` : `- ${clean}`;
}

/**
 * 文件引用 → 带标签的清单块。给模型的一句话说清这是什么、该怎么用——
 * 没有它，模型看到一串路径不知道是附件还是散文。目录行补尾斜杠（约定俗成的目录记号）。
 * PDF 单独点名 read_pdf：pi 的 read 对 PDF 只会吐二进制乱码，文本层归 read_pdf 提取
 * （见 agent/pdf-tools.ts）——不点名，模型多半拿 read 去撞。
 */
export function filesBlockOf(files: readonly { path: string; kind: "file" | "dir" }[]): string {
  return [
    "<attached-files>",
    "The user attached these files from their disk. Read them with the read tool when you need their contents. " +
      "PDF files: use the read_pdf tool instead of read. Word (.docx) files: use the read_docx tool instead of read.",
    ...files.map(fileLine),
    "</attached-files>",
  ].join("\n");
}

/**
 * 正文 + 粘贴块 + 文件清单 → 发给模型的一整段文字。正文在前（quote 的编号块也已在
 * 其中），粘贴块按加入顺序、文件清单殿后；空段跳过——纯图消息与以前一字不差。
 */
export function composePromptText(
  text: string,
  pasted: readonly string[],
  files: readonly { path: string; kind: "file" | "dir" }[],
): string {
  return [text, ...pasted.map(pastedBlockOf), ...(files.length > 0 ? [filesBlockOf(files)] : [])]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * 正文之后的回显块列表：与 composePromptText 的分段一致（正文除外）。adapter 的
 * user item 用它造独立 text 块——转录保留块边界，显示层按块解析回 chip；
 * 块与块之间用 \n\n 接起来正好是 composePromptText 的结果。
 */
export function attachmentBlocks(
  pasted: readonly string[],
  files: readonly { path: string; kind: "file" | "dir" }[],
): string[] {
  return [...pasted.map(pastedBlockOf), ...(files.length > 0 ? [filesBlockOf(files)] : [])];
}

const PASTED_BLOCK = /^<pasted-text>\r?\n([\s\S]*?)\r?\n<\/pasted-text>$/;
const FILES_BLOCK = /^<attached-files>\r?\n.*\r?\n([\s\S]*\n)?<\/attached-files>$/;
const FILE_LINE = /^- (.+)$/;

/**
 * 转录回显块 → 粘贴正文。整个块就是一段粘贴（agent 进程组装时保证），不匹配返回
 * null——旧会话与手打的多块没有这个标签，调用方按普通文本渲染。
 */
export function parsePastedBlock(block: string): string | null {
  if (!block.startsWith("<pasted-text>")) return null;
  const match = PASTED_BLOCK.exec(block);
  return match?.[1] ?? null;
}

/**
 * 转录回显块 → 文件引用清单。行尾的 `/` 还原成 kind；不匹配返回 null（同上）。
 */
export function parseFilesBlock(block: string): { path: string; kind: "file" | "dir" }[] | null {
  if (!block.startsWith("<attached-files>")) return null;
  const match = FILES_BLOCK.exec(block);
  if (match === null) return null;
  const refs: { path: string; kind: "file" | "dir" }[] = [];
  for (const line of (match[1] ?? "").split("\n")) {
    const hit = FILE_LINE.exec(line.trimEnd());
    if (hit === null || hit[1] === undefined || hit[1] === "") continue;
    const path = hit[1];
    const isDir = path.endsWith("/");
    refs.push({ path: isDir ? path.slice(0, -1) : path, kind: isDir ? "dir" : "file" });
  }
  return refs;
}

/**
 * 一条 user 消息的文本块 → 正文 + 附件块。**按内容识别，不按位置猜**：每块先试
 * 粘贴块 / 文件清单块，都不是才算正文——「只发附件不打字」的消息第一块就是
 * `<pasted-text>`，按「第一块恒是正文」猜会把裸标签渲染进气泡（review #90 指出）。
 * 正文可能多于一块（正文块与附件块交错时各归各类，正文以 \n\n 连接——与
 * composePromptText 的拼法互逆）。
 */
export function splitUserTextBlocks(
  blocks: readonly string[],
): { body: string; pasted: string[]; files: { path: string; kind: "file" | "dir" }[] } {
  const bodyParts: string[] = [];
  const pasted: string[] = [];
  let files: { path: string; kind: "file" | "dir" }[] = [];
  for (const block of blocks) {
    const pastedText = parsePastedBlock(block);
    if (pastedText !== null) {
      pasted.push(pastedText);
      continue;
    }
    const fileRefs = parseFilesBlock(block);
    if (fileRefs !== null) {
      files = [...files, ...fileRefs];
      continue;
    }
    bodyParts.push(block);
  }
  return { body: bodyParts.join("\n\n"), pasted, files };
}
