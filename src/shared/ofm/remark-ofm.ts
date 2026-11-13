/**
 * remark 插件：把 Obsidian 风格 markdown 里 CommonMark / GFM 不认识的几样东西变成 mdast 节点。
 *
 * - `[[页]]` `[[页#小节|别名]]` → `ofmWikiLink`（渲染成 `<a class="ofm-wikilink" data-ofm-target=…>`）
 * - `![[图.png|300]]` → `ofmEmbed`（图片 = `<img data-ofm-embed=…>`；其它嵌入 = 带图标的链接胶囊）
 * - `==高亮==` → `ofmHighlight`（`<mark>`；可跨行内节点：`==**粗** 字==`）
 * - `#标签` → `ofmTag`（`<span class="ofm-tag">`；纯数字不是标签）
 * - `%%注释%%` → 整段拿掉（同一行内）
 * - frontmatter（remark-frontmatter 给的 `yaml` 节点）→ `ofmProperties`（属性表）
 *
 * 只动文本节点，所以**代码块 / 行内代码 / 公式里的 `[[` `==` `#` 天然不转换**（它们不是 text 节点）。
 * 链接文字内部不转换（嵌套 `<a>` 是非法 HTML）。
 *
 * 节点带 `data.hName` / `data.hProperties`，mdast-util-to-hast 据此直接出 hast，
 * 渲染端（react-markdown 的 components）按 `data-ofm-*` 属性认领、解析目标文件。
 * 提醒框（`> [!warning]`）在 hast 层由 rehype-callouts 处理，不在这里。
 * 不引 unist-util-visit：递归 40 行，不值得多一条依赖。
 */
import { calloutDefaultTitle, isKnownCalloutType, parseCalloutHead, parseEmbedHint, tagRe, wikiLinkLabel, wikiLinkRe, parseWikiLink, isImageName } from "./syntax.ts";
import { parseProperties } from "./properties.ts";

/** 够用的 mdast 子集：本插件只读 type / value / children，写入自己的节点 */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** 不往里走的节点：链接里不嵌套链接 */
const SKIP_CHILDREN = new Set(["link", "linkReference", "ofmProperties", "ofmWikiLink", "ofmEmbed", "ofmTag", "ofmHighlight"]);

const text = (value: string): MdNode => ({ type: "text", value });

function wikiLinkNode(link: ReturnType<typeof parseWikiLink>): MdNode {
  const label = wikiLinkLabel(link);
  return {
    type: "ofmWikiLink",
    data: {
      hName: "a",
      hProperties: {
        className: ["ofm-wikilink"],
        "data-ofm-target": link.target,
        ...(link.fragment === null ? {} : { "data-ofm-fragment": link.fragment }),
      },
    },
    children: [text(label)],
  };
}

function embedNode(link: ReturnType<typeof parseWikiLink>): MdNode {
  const hint = parseEmbedHint(link.alias);
  if (isImageName(link.target)) {
    return {
      type: "ofmEmbed",
      data: {
        hName: "img",
        hProperties: {
          src: "",
          alt: hint.alt ?? link.target,
          "data-ofm-embed": link.target,
          ...(hint.width === undefined ? {} : { width: hint.width }),
          ...(hint.height === undefined ? {} : { height: hint.height }),
        },
      },
      children: [],
    };
  }
  // 非图片嵌入（笔记 / pdf / 音视频）：不展开内容，按链接胶囊显示，点击打开目标
  return {
    type: "ofmEmbed",
    data: {
      hName: "a",
      hProperties: {
        className: ["ofm-wikilink", "ofm-embed-note"],
        "data-ofm-target": link.target,
        ...(link.fragment === null ? {} : { "data-ofm-fragment": link.fragment }),
      },
    },
    children: [text(link.alias !== null && link.alias !== "" ? link.alias : wikiLinkLabel(link))],
  };
}

function tagNode(name: string): MdNode {
  return {
    type: "ofmTag",
    data: { hName: "span", hProperties: { className: ["ofm-tag"], "data-ofm-tag": name } },
    children: [text(`#${name}`)],
  };
}

/** 一个文本节点 → 若干节点（wikilink / embed / tag / 注释），没有命中就原样一个 */
function splitText(value: string): MdNode[] {
  // 1) 行内注释
  const withoutComments = value.includes("%%") ? value.replace(/%%[^\n]*?%%/g, "") : value;
  // 2) wikilink / embed
  const pieces: MdNode[] = [];
  const re = wikiLinkRe();
  let last = 0;
  const pushPlain = (plain: string): void => {
    if (plain === "") return;
    // 3) 标签只在非 wikilink 的普通文字里找
    const tags = tagRe();
    let from = 0;
    for (let m = tags.exec(plain); m !== null; m = tags.exec(plain)) {
      const lead = m[1] as string;
      const start = m.index + lead.length;
      if (start > from) pieces.push(text(plain.slice(from, start)));
      pieces.push(tagNode(m[2] as string));
      from = m.index + m[0].length;
    }
    if (from < plain.length) pieces.push(text(plain.slice(from)));
  };
  for (let m = re.exec(withoutComments); m !== null; m = re.exec(withoutComments)) {
    const link = parseWikiLink(m);
    pushPlain(withoutComments.slice(last, m.index));
    pieces.push(link.embed ? embedNode(link) : wikiLinkNode(link));
    last = m.index + m[0].length;
  }
  pushPlain(withoutComments.slice(last));
  return pieces;
}

/** 同一个父节点的子节点里配对 `==`：把两个标记之间的节点包进 `ofmHighlight` */
function pairHighlights(children: MdNode[]): MdNode[] {
  // 先把含 `==` 的文本切成「文字 / 标记」
  const MARK = "ofmMarker";
  const flat: MdNode[] = [];
  for (const child of children) {
    if (child.type !== "text" || child.value === undefined || !child.value.includes("==")) {
      flat.push(child);
      continue;
    }
    const parts = child.value.split(/(?<!=)==(?!=)/);
    parts.forEach((part, i) => {
      if (i > 0) flat.push({ type: MARK });
      if (part !== "") flat.push(text(part));
    });
  }
  if (!flat.some((node) => node.type === MARK)) return children;

  const out: MdNode[] = [];
  let open = -1; // out 里开标记的位置
  for (const node of flat) {
    if (node.type !== MARK) {
      out.push(node);
      continue;
    }
    if (open === -1) {
      out.push(node);
      open = out.length - 1;
      continue;
    }
    const inner = out.slice(open + 1);
    // 开标记后不能是空白、收标记前不能是空白；里面至少要有内容
    const first = inner[0];
    const lastNode = inner[inner.length - 1];
    const startsBlank = first?.type === "text" && /^\s/.test(first.value ?? "");
    const endsBlank = lastNode?.type === "text" && /\s$/.test(lastNode.value ?? "");
    if (inner.length === 0 || startsBlank || endsBlank) {
      // 不成对：上一个标记当字面 `==`，这一个作为新的开标记
      out[open] = text("==");
      out.push(node);
      open = out.length - 1;
      continue;
    }
    out.splice(open, out.length - open, {
      type: "ofmHighlight",
      data: { hName: "mark", hProperties: { className: ["ofm-mark"] } },
      children: inner,
    });
    open = -1;
  }
  // 没配上的标记还原成字面 `==`
  return out.map((node) => (node.type === MARK ? text("==") : node));
}

/** 合并相邻文本节点（拆分后留下的碎片），免得渲染出一串空 span */
function mergeText(children: MdNode[]): MdNode[] {
  const out: MdNode[] = [];
  for (const child of children) {
    const prev = out[out.length - 1];
    if (child.type === "text" && prev?.type === "text") prev.value = (prev.value ?? "") + (child.value ?? "");
    else out.push(child);
  }
  return out;
}

/**
 * 不认识的提醒框类型（`> [!custom]`）：rehype-callouts 不当提醒框画（原样留下 `[!custom]` 文字），
 * 而 Obsidian 当 note 画、标题写类型名——这里改写头行成 `[!note] Custom`，下游就一致了
 */
function normalizeCalloutHead(node: MdNode): void {
  const lead = node.children?.[0]?.children?.[0];
  if (node.children?.[0]?.type !== "paragraph" || lead?.type !== "text" || lead.value === undefined) return;
  const nl = lead.value.indexOf("\n");
  const headLine = nl === -1 ? lead.value : lead.value.slice(0, nl);
  const head = parseCalloutHead(headLine);
  if (head === null || isKnownCalloutType(head.type)) return;
  const title = head.title === "" ? calloutDefaultTitle(head.type) : head.title;
  lead.value = `[!note]${head.fold ?? ""} ${title}${nl === -1 ? "" : lead.value.slice(nl)}`;
}

function walk(node: MdNode): void {
  const children = node.children;
  if (node.type === "blockquote") normalizeCalloutHead(node);
  if (children === undefined || SKIP_CHILDREN.has(node.type)) return;
  const next: MdNode[] = [];
  for (const child of children) {
    if (child.type === "text" && child.value !== undefined) next.push(...splitText(child.value));
    else {
      walk(child);
      next.push(child);
    }
  }
  node.children = mergeText(pairHighlights(mergeText(next)));
}

/** frontmatter → 属性表节点：tags 画成标签胶囊，其余列表逗号连起来，值里的 `[[链接]]` 照样可点 */
function propertiesNode(yaml: string): MdNode | null {
  const props = parseProperties(yaml);
  if (props.length === 0) return null;
  const rows = props.map<MdNode>((prop) => {
    const isTags = prop.key.toLowerCase() === "tags" || prop.key.toLowerCase() === "tag";
    const valueChildren: MdNode[] = isTags
      ? prop.values.flatMap((value) => [tagNode(value.replace(/^#/, ""))])
      : prop.values.flatMap((value, i) => [...(i > 0 ? [text(", ")] : []), ...splitText(value)]);
    return {
      type: "ofmProperty",
      data: { hName: "div", hProperties: { className: ["ofm-prop"] } },
      children: [
        { type: "ofmPropertyKey", data: { hName: "span", hProperties: { className: ["ofm-prop-key"] } }, children: [text(prop.key)] },
        { type: "ofmPropertyValue", data: { hName: "span", hProperties: { className: ["ofm-prop-val"] } }, children: valueChildren },
      ],
    };
  });
  return {
    type: "ofmProperties",
    data: { hName: "div", hProperties: { className: ["ofm-properties"] } },
    children: rows,
  };
}

export interface RemarkOfmOptions {
  /** 把 frontmatter 画成属性表（阅读视图）；关 = 丢掉 yaml 节点（导出 docx 自己处理） */
  properties?: boolean;
}

export function remarkOfm(options: RemarkOfmOptions = {}): (tree: MdNode) => void {
  return (tree) => {
    const showProperties = options.properties !== false;
    const children = tree.children ?? [];
    tree.children = children.flatMap((child) => {
      if (child.type !== "yaml") return [child];
      const node = showProperties && child.value !== undefined ? propertiesNode(child.value) : null;
      return node === null ? [] : [node];
    });
    walk(tree);
  };
}
