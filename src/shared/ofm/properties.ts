/**
 * Frontmatter（文档属性）：切出头部 `---` YAML 块，并把常见的扁平写法解析成「属性表」的行。
 *
 * 不引 YAML 库：属性表只需要 Obsidian 属性面板认得的那几种值——标量、`[a, b]` 行内列表、
 * `- a` 块列表；嵌套映射 / 多行字符串当原文显示（不丢内容，也不假装解析了）。
 */

export interface FrontmatterSplit {
  /** YAML 原文（不含两条 `---`）；没有 frontmatter = null */
  yaml: string | null;
  /** 正文起点（在 `text` 里的偏移） */
  bodyStart: number;
}

/** 文首的 `---` … `---`（或 `...`）块。必须从第一行开始，且要有收尾行 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (open === null) return { yaml: null, bodyStart: 0 };
  const rest = text.slice(open[0].length);
  const close = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (close === null) return { yaml: null, bodyStart: 0 };
  return { yaml: rest.slice(0, close.index).replace(/\r?\n$/, ""), bodyStart: open[0].length + close.index + close[0].length };
}

export interface Property {
  key: string;
  /** 值的各项：标量只有一项；列表按项；解析不了的复杂值是整段原文一项 */
  values: string[];
  /** 值是列表（tags / aliases 这类，界面画成一排胶囊） */
  list: boolean;
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** `[a, "b, c", d]` → 项（引号内的逗号不拆） */
function splitInline(inner: string): string[] {
  const items: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote !== null) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      items.push(cur);
      cur = "";
    } else cur += ch;
  }
  items.push(cur);
  return items.map(unquote).filter((item) => item !== "");
}

export function parseProperties(yaml: string): Property[] {
  const out: Property[] = [];
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const kv = /^([^\s:#][^:]*?):(?:\s+(.*))?$/.exec(line);
    if (kv === null) continue; // 缩进行（嵌套内容）由上一个键收走；孤立的认不出，跳过
    const key = (kv[1] as string).trim();
    const value = (kv[2] ?? "").trim();
    if (value === "" || value === "|" || value === ">") {
      // 块列表 / 嵌套：吃掉后面缩进（或 `- `）的行
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|-\s)/.test(lines[i + 1] as string) && (lines[i + 1] as string).trim() !== "") {
        i += 1;
        block.push(lines[i] as string);
      }
      if (block.length > 0 && block.every((l) => /^\s*-\s+/.test(l))) {
        out.push({ key, values: block.map((l) => unquote(l.replace(/^\s*-\s+/, ""))), list: true });
      } else if (block.length > 0) {
        out.push({ key, values: [block.map((l) => l.trim()).join("\n")], list: false });
      } else {
        out.push({ key, values: [], list: false });
      }
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      out.push({ key, values: splitInline(value.slice(1, -1)), list: true });
      continue;
    }
    out.push({ key, values: [unquote(value)], list: false });
  }
  return out;
}
