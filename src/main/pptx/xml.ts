/**
 * 够用就好的 XML 树（只服务 `read.ts` 的 pptx 解析，没有第二个消费者）。
 *
 * 为什么自写而不是引 XML 库：pptx 里我们要读的只有 OOXML 的一小撮元素（`a:p`、
 * `a:t`、`a:tbl`、`p:ph` 与几个 rels），结构规整、没有 DTD；为它引一个完整 XML
 * 解析器（或 31 MB 的 office 全家桶）不划算。这里按标签切、栈式建树，不认识的
 * 标签原样保留——解析器的职责只是把树摆出来，语义判定在 `read.ts`。
 *
 * 边界：**不处理 DTD 实体定义**（OOXML 不用）、不校验标签闭合（坏 XML 由调用方
 * 的 try/catch 兜成「文件坏了」）。`&amp;` 这类实体按 XML 规则解码，`&#x20;` 这类
 * 数字实体一并处理——否则标题里的 `&` 会以 `&amp;` 出现在预览里。
 */

export interface XmlElement {
  /** 带前缀的标签名，如 `a:p` / `p:sp` */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** 直接文本（不含子元素里的文字）；只有 `a:t` 这类叶子会有内容 */
  text: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** 实体解码；未知实体原样保留（比吞掉安全） */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity.startsWith("#x") || entity.startsWith("#X")
          ? parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity] ?? whole;
  });
}

const TAG_PATTERN =
  /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;

const ATTR_PATTERN = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_PATTERN.exec(raw)) !== null) {
    const value = match[2] ?? match[3] ?? "";
    attrs[match[1] ?? ""] = decodeEntities(value);
  }
  return attrs;
}

export function parseXml(xml: string): XmlElement {
  const document: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [document];
  TAG_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_PATTERN.exec(xml)) !== null) {
    const top = stack[stack.length - 1] ?? document;
    const text = match[6];
    if (text !== undefined) {
      top.text += decodeEntities(text);
      continue;
    }
    const cdata = match[1];
    if (cdata !== undefined) {
      top.text += cdata;
      continue;
    }
    const name = match[3];
    if (name === undefined) continue; // 注释 / PI / DOCTYPE，不建节点
    if (match[2] === "/") {
      // 从栈顶往下找同名元素再弹：坏 XML 里多出来的闭合标签不该把整棵树带偏
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index]?.name === name) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const element: XmlElement = {
      name,
      attrs: parseAttrs(match[4] ?? ""),
      children: [],
      text: "",
    };
    top.children.push(element);
    // 自闭合标签不入栈（`<a:br/>` 是最常见的一个）
    if (match[5] !== "/") stack.push(element);
  }
  return document;
}

/** 子树里所有同名元素（深度优先、文档顺序） */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) found.push(child);
      walk(child);
    }
  };
  walk(element);
  return found;
}

export function firstDescendant(element: XmlElement, name: string): XmlElement | undefined {
  for (const child of element.children) {
    if (child.name === name) return child;
    const nested = firstDescendant(child, name);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** 元素的直接子元素（按名字过滤；不给名字就是全部子元素） */
export function childrenNamed(element: XmlElement, name?: string): XmlElement[] {
  return name === undefined ? element.children : element.children.filter((child) => child.name === name);
}
