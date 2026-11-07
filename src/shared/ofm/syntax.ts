/**
 * Obsidian 风格 markdown（OFM）的语法判定 —— 纯函数、零依赖，阅读视图（remark 插件）、
 * 编辑视图（CodeMirror 装饰）、导出（docx / 通用 md）共用同一份口径。
 *
 * 语义参照 Quartz 的 `ofm.ts`（MIT，https://github.com/jackyzha0/quartz/blob/v4/quartz/plugins/transformers/ofm.ts）：
 * wikilink / embed 的正则、tag 不许纯数字、callout 头 `> [!type]± 标题`。这里按本仓需要重写，
 * 没有拷贝其代码；差异：tag 前必须是行首 / 空白 / 开括号（`PR #460` 这类纯数字不是标签），
 * 高亮 `==x==` 允许跨行内节点（`==**粗** 字==`），见 remark-ofm.ts。
 */

/** `[[目标#小节|别名]]` 与 `![[…]]`：1 = 感叹号，2 = 目标，3 = `#小节`（含 `#^块`），4 = `|别名` */
const WIKILINK_SOURCE = String.raw`(!?)\[\[([^\[\]|#\\\n]*)(#[^\[\]|\n]*)?(\\?\|[^\[\]\n]*)?\]\]`;

/** 每次用都新建：带 g 标志的正则有 lastIndex 状态，共用一份会在不同调用间串位 */
export function wikiLinkRe(): RegExp {
  return new RegExp(WIKILINK_SOURCE, "g");
}

export interface WikiLink {
  /** 感叹号开头 = 嵌入（`![[图.png]]`） */
  embed: boolean;
  /** 目标名（不含 `#小节` 与 `|别名`）；`[[#小节]]` 是本页链接，目标为空串 */
  target: string;
  /** `#` 之后的部分，没有 = null */
  fragment: string | null;
  /** `|` 之后的部分，没有 = null */
  alias: string | null;
  /** 命中的原文 */
  raw: string;
}

export function wikiLinkFromGroups(
  raw: string,
  bang: string | undefined,
  target: string | undefined,
  fragment: string | undefined,
  alias: string | undefined,
): WikiLink {
  return {
    embed: bang === "!",
    target: (target ?? "").trim(),
    fragment: fragment === undefined ? null : fragment.slice(1).trim(),
    alias: alias === undefined ? null : alias.replace(/^\\?\|/, "").trim(),
    raw,
  };
}

export function parseWikiLink(match: RegExpExecArray): WikiLink {
  return wikiLinkFromGroups(match[0], match[1], match[2], match[3], match[4]);
}

/** 一段文本里的全部 wikilink / embed（按出现顺序） */
export function findWikiLinks(text: string): (WikiLink & { index: number })[] {
  const out: (WikiLink & { index: number })[] = [];
  const re = wikiLinkRe();
  for (let match = re.exec(text); match !== null; match = re.exec(text)) {
    out.push({ ...parseWikiLink(match), index: match.index });
  }
  return out;
}

/** 链接显示的字：别名优先；`[[页#小节]]` 显示「页 > 小节」；`[[#小节]]` 只显示小节 */
export function wikiLinkLabel(link: Pick<WikiLink, "target" | "fragment" | "alias">): string {
  if (link.alias !== null && link.alias !== "") return link.alias;
  const base = link.target.replace(/\.md$/i, "");
  const fragment = link.fragment === null ? "" : link.fragment.replace(/^\^/, "");
  if (base === "") return fragment;
  return fragment === "" ? base : `${base} > ${fragment}`;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"]);

export function extOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** 图片文件（Chromium 的 <img> 画得了的那几种） */
export function isImageName(name: string): boolean {
  return IMAGE_EXTS.has(extOf(name));
}

/** 文档（文件面板用文档编辑器接管的类型） */
export function isDocumentName(name: string): boolean {
  const ext = extOf(name);
  return ext === "md" || ext === "markdown" || ext === "txt";
}

/**
 * 嵌入的尺寸 / 说明：`![[图.png|300]]`、`![[图.png|300x200]]` 是尺寸，其余别名是图注（alt）
 */
export function parseEmbedHint(alias: string | null): { width?: number; height?: number; alt?: string } {
  if (alias === null || alias === "") return {};
  const size = /^(\d+)(?:x(\d+))?$/.exec(alias);
  if (size !== null) {
    return {
      width: Number(size[1]),
      ...(size[2] === undefined ? {} : { height: Number(size[2]) }),
    };
  }
  return { alt: alias };
}

/**
 * 标签：`#周报`、`#项目/子项`。前面是行首 / 空白 / 开括号；至少含一个非数字字符（`#460` 不是标签）；
 * 1 = 前导字符（要保留），2 = 标签名（不含 `#`）
 */
export function tagRe(): RegExp {
  return /(^|[\s(（>])#((?:[\p{L}\p{N}_/-])*[\p{L}_/-](?:[\p{L}\p{N}_/-])*)/gu;
}

/** 提醒框头：`[!warning]- 标题`（前面的 `> ` 已去掉）。fold：`+` 默认展开、`-` 默认折叠、null 不可折叠 */
export interface CalloutHead {
  type: string;
  fold: "+" | "-" | null;
  title: string;
}

export function parseCalloutHead(line: string): CalloutHead | null {
  const match = /^\[!([A-Za-z][\w-]*)\]([+-])?(?:\s+(.*))?$/.exec(line.trim());
  if (match === null) return null;
  const type = (match[1] as string).toLowerCase();
  const title = (match[3] ?? "").trim();
  return { type, fold: (match[2] as "+" | "-" | undefined) ?? null, title };
}

/** 提醒框标题缺省时的字：类型名首字母大写（Obsidian 同口径） */
export function calloutDefaultTitle(type: string): string {
  return type === "" ? "" : type.charAt(0).toUpperCase() + type.slice(1);
}

/** Obsidian 的提醒框别名：几十个名字归到十来个视觉类型 */
const CALLOUT_ALIASES: Readonly<Record<string, string>> = {
  summary: "abstract",
  tldr: "abstract",
  hint: "tip",
  important: "tip",
  check: "success",
  done: "success",
  help: "question",
  faq: "question",
  caution: "warning",
  attention: "warning",
  fail: "failure",
  missing: "failure",
  error: "danger",
  cite: "quote",
};

/** 提醒框视觉类型：note / abstract / info / todo / tip / success / question / warning / failure / danger / bug / example / quote；不认识的当 note */
export function calloutKind(type: string): string {
  const known = new Set([
    "note",
    "abstract",
    "info",
    "todo",
    "tip",
    "success",
    "question",
    "warning",
    "failure",
    "danger",
    "bug",
    "example",
    "quote",
  ]);
  const t = type.toLowerCase();
  const mapped = CALLOUT_ALIASES[t] ?? t;
  return known.has(mapped) ? mapped : "note";
}

/**
 * 把一段文本切成「代码」与「非代码」两种片段（围栏代码块整行为代码、行内 `…` 为代码）。
 * 用于不走 AST 的字符串级转换（通用 md 降级）：代码里的 `[[` `==` `#` 不转换。
 * 片段拼起来逐字等于原文。
 */
export function splitCode(text: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const push = (code: boolean, piece: string): void => {
    if (piece === "") return;
    const last = out[out.length - 1];
    if (last !== undefined && last.code === code) last.text += piece;
    else out.push({ code, text: piece });
  };
  const lines = text.split("\n");
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const eol = i < lines.length - 1 ? "\n" : "";
    if (fence !== null) {
      push(true, line + eol);
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close !== null && (close[1] as string)[0] === fence[0] && (close[1] as string).length >= fence.length) fence = null;
      return;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open !== null) {
      fence = open[1] as string;
      push(true, line + eol);
      return;
    }
    // 行内代码：反引号串配对（同样长度的收尾串）
    let rest = line;
    while (rest !== "") {
      const start = /`+/.exec(rest);
      if (start === null) {
        push(false, rest);
        rest = "";
        break;
      }
      const run = start[0];
      let close = -1;
      for (let from = start.index + run.length; ; ) {
        const next = rest.indexOf(run, from);
        if (next === -1) break;
        // 收尾串不能是更长反引号串的一部分
        if (rest[next + run.length] !== "`" && rest[next - 1] !== "`") {
          close = next;
          break;
        }
        from = next + 1;
      }
      if (close === -1) {
        push(false, rest.slice(0, start.index + run.length));
        rest = rest.slice(start.index + run.length);
        continue;
      }
      push(false, rest.slice(0, start.index));
      push(true, rest.slice(start.index, close + run.length));
      rest = rest.slice(close + run.length);
    }
    push(false, eol);
  });
  return out;
}

/** 每一行是否在围栏代码块里（含围栏起止行本身）。与 `splitCode` 同一套围栏规则 */
export function fencedLineFlags(lines: readonly string[]): boolean[] {
  const flags: boolean[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (fence !== null) {
      flags.push(true);
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close !== null && (close[1] as string)[0] === fence[0] && (close[1] as string).length >= fence.length) fence = null;
      continue;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (open !== null) {
      fence = open[1] as string;
      flags.push(true);
      continue;
    }
    flags.push(false);
  }
  return flags;
}
