/**
 * 文档 → .docx：把 `.md` 的块（标题 / 列表 / 引用 / 代码块 / 分隔线 / 段落）和行内
 * （加粗 / 斜体 / 删除线 / 行内代码 / 链接文字）映射成 Word 的段落与文字 run。
 *
 * 只认文档面板能编辑出来的那一小撮 markdown（第一期不做表格、图片）：认不出的行当普通段落
 * 原样落文字，不丢内容。纯函数 + `docx`（MIT）的 `Packer.toBuffer`，不碰 electron。
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";

type Heading = (typeof HeadingLevel)[keyof typeof HeadingLevel];

const HEADINGS: readonly Heading[] = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

const ORDERED = "orbita-ordered";
const MONO = "Courier New";

interface Style {
  bold?: boolean;
  italics?: boolean;
  strike?: boolean;
  code?: boolean;
}

/** 行内标记 → run。按「最先出现的标记」逐段吃，不嵌套求解（粗斜体 `***x***` 走粗 + 斜叠加） */
export function inlineRuns(text: string, base: Style = {}): TextRun[] {
  const runs: TextRun[] = [];
  const push = (value: string, style: Style): void => {
    if (value === "") return;
    runs.push(
      new TextRun({
        text: value,
        bold: style.bold,
        italics: style.italics,
        strike: style.strike,
        ...(style.code ? { font: MONO } : {}),
      }),
    );
  };
  let rest = text;
  while (rest !== "") {
    const match = /(\*\*\*|\*\*|__|~~|`|\*|_|\[)/.exec(rest);
    if (match === null) {
      push(rest, base);
      break;
    }
    const at = match.index;
    const marker = match[1] as string;
    // 词内的单下划线（snake_case）不是斜体
    const prev = at > 0 ? (rest[at - 1] as string) : "";
    if (marker === "_" && /[A-Za-z0-9]/.test(prev)) {
      push(rest.slice(0, at + 1), base);
      rest = rest.slice(at + 1);
      continue;
    }
    if (marker === "[") {
      const link = /^\[([^\]]+)\]\(([^)\s]+)[^)]*\)/.exec(rest.slice(at));
      if (link === null) {
        push(rest.slice(0, at + 1), base);
        rest = rest.slice(at + 1);
        continue;
      }
      push(rest.slice(0, at), base);
      runs.push(...inlineRuns(link[1] as string, base));
      push(` (${link[2] as string})`, base);
      rest = rest.slice(at + link[0].length);
      continue;
    }
    const close = rest.indexOf(marker, at + marker.length);
    // 没有收尾的标记就是普通字符
    if (close === -1 || close === at + marker.length) {
      push(rest.slice(0, at + marker.length), base);
      rest = rest.slice(at + marker.length);
      continue;
    }
    push(rest.slice(0, at), base);
    const inner = rest.slice(at + marker.length, close);
    if (marker === "`") push(inner, { ...base, code: true });
    else {
      const style: Style = { ...base };
      if (marker === "***") {
        style.bold = true;
        style.italics = true;
      } else if (marker === "**" || marker === "__") style.bold = true;
      else if (marker === "~~") style.strike = true;
      else style.italics = true;
      runs.push(...inlineRuns(inner, style));
    }
    rest = rest.slice(close + marker.length);
  }
  return runs;
}

/** 多行（同一段里的软换行）→ 带换行的 run 序列：编辑器里看见的换行，Word 里也是换行 */
function lineRuns(lines: readonly string[]): TextRun[] {
  const runs: TextRun[] = [];
  lines.forEach((rawLine, i) => {
    // 行尾的硬换行标记（两个空格或反斜杠）不是文字
    const part = inlineRuns(rawLine.replace(/( {2,}|\\)$/, ""));
    if (i > 0 && part.length > 0) {
      // docx 的 break 挂在 run 上：给下一行首个 run 一个前置换行
      runs.push(new TextRun({ text: "", break: 1 }));
    }
    runs.push(...part);
  });
  return runs;
}

/** 导出时用的块（也供测试数「应该有几段」） */
export type DocBlock =
  | { type: "heading"; level: number; text: string }
  | { type: "bullet"; level: number; text: string }
  | { type: "ordered"; level: number; text: string }
  | { type: "quote"; text: string }
  | { type: "code"; lines: string[] }
  | { type: "rule" }
  | { type: "paragraph"; lines: string[] };

/** markdown → 块序列（纯函数，行级状态机） */
export function parseBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) blocks.push({ type: "paragraph", lines: paragraph });
    paragraph = [];
  };
  let fence: { marker: string; lines: string[] } | null = null;
  for (const line of lines) {
    if (fence !== null) {
      if (line.trimStart().startsWith(fence.marker)) {
        blocks.push({ type: "code", lines: fence.lines });
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    const open = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (open !== null) {
      flush();
      fence = { marker: (open[1] as string).slice(0, 3), lines: [] };
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      flush();
      blocks.push({ type: "heading", level: (heading[1] as string).length, text: heading[2] as string });
      continue;
    }
    if (/^\s{0,3}(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flush();
      blocks.push({ type: "rule" });
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      flush();
      blocks.push({ type: "bullet", level: Math.min(Math.floor((bullet[1] as string).length / 2), 4), text: bullet[2] as string });
      continue;
    }
    const ordered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    if (ordered !== null) {
      flush();
      blocks.push({ type: "ordered", level: Math.min(Math.floor((ordered[1] as string).length / 2), 4), text: ordered[2] as string });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (quote !== null) {
      flush();
      blocks.push({ type: "quote", text: quote[1] as string });
      continue;
    }
    paragraph.push(line);
  }
  if (fence !== null) blocks.push({ type: "code", lines: fence.lines });
  flush();
  return blocks;
}

function paragraphOf(block: DocBlock): Paragraph[] {
  switch (block.type) {
    case "heading":
      return [new Paragraph({ heading: HEADINGS[block.level - 1] as Heading, children: inlineRuns(block.text) })];
    case "bullet":
      return [new Paragraph({ bullet: { level: block.level }, children: inlineRuns(block.text) })];
    case "ordered":
      return [new Paragraph({ numbering: { reference: ORDERED, level: block.level }, children: inlineRuns(block.text) })];
    case "quote":
      return [
        new Paragraph({
          indent: { left: 480 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, space: 8, color: "BBBBBB" } },
          children: inlineRuns(block.text, { italics: true }),
        }),
      ];
    case "code":
      // 代码块一行一段（等宽），保住缩进
      return block.lines.length === 0
        ? [new Paragraph({ children: [new TextRun({ text: "", font: MONO })] })]
        : block.lines.map((line) => new Paragraph({ children: [new TextRun({ text: line, font: MONO, size: 20 })] }));
    case "rule":
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: "999999" } } })];
    case "paragraph":
      return [new Paragraph({ children: lineRuns(block.lines) })];
  }
}

/** 一份 markdown 要导出成几个 Word 段落（测试与导出共用同一个口径） */
export function expectedParagraphCount(markdown: string): number {
  return parseBlocks(markdown).reduce(
    (sum, block) => sum + (block.type === "code" ? Math.max(block.lines.length, 1) : 1),
    0,
  );
}

export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const children = parseBlocks(markdown).flatMap(paragraphOf);
  const doc = new Document({
    creator: "Orbita",
    numbering: {
      config: [
        {
          reference: ORDERED,
          levels: Array.from({ length: 5 }, (_, level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 + level * 360, hanging: 360 } } },
          })),
        },
      ],
    },
    styles: { default: { document: { run: { size: 22 } } } },
    sections: [{ children: children.length > 0 ? children : [new Paragraph({})] }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}
