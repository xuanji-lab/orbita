/**
 * 编辑视图（实时预览）里的 Obsidian 语法外观（CodeMirror 6 扩展），与 `cm-live-markdown.ts` 的
 * 「光标不在的地方收起符号」同一个规矩：
 * - `[[页|别名]]` 只显示别名（找不到的灰色）；⌘ / Ctrl + 点击打开；
 * - `![[图.png]]` 与 `![](相对路径)` 显示成图片（光标在这一行时露出源码）；
 * - `> [!warning]- 标题` 提醒框：整块色条 + 底色，头行换成图标 + 标题；
 * - `==高亮==`、`#标签`、frontmatter（属性区）。
 * 只做装饰，不改文档内容；代码里的 `[[` `==` `#` 不处理（按语法树的 code 节点跳过）。
 * 语义与阅读视图共用 `shared/ofm/syntax.ts`。
 */
import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { renderToStaticMarkup } from "react-dom/server";
import {
  calloutDefaultTitle,
  calloutKind,
  isImageName,
  parseCalloutHead,
  parseEmbedHint,
  tagRe,
  wikiLinkFromGroups,
  wikiLinkRe,
} from "../../../../shared/ofm/syntax.ts";
import { splitFrontmatter } from "../../../../shared/ofm/properties.ts";
import { Icon, type IconName } from "../../shell/Icon";
import type { OfmEnv } from "./ofm-env.ts";
import { loadImageUrl } from "./ofm-images.ts";

const hidden = Decoration.replace({});
const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "CodeInfo", "HTMLBlock", "HTMLTag", "CommentBlock", "URL"]);

const CALLOUT_ICONS: Readonly<Record<string, IconName>> = {
  note: "pencil-line",
  abstract: "clipboard-list",
  info: "info",
  todo: "list-todo",
  tip: "lightbulb",
  success: "circle-check",
  question: "circle-help",
  warning: "triangle-alert",
  failure: "octagon-x",
  danger: "zap",
  bug: "octagon-x",
  example: "list",
  quote: "quote",
};

function iconHtml(name: IconName): string {
  return renderToStaticMarkup(<Icon name={name} size={14} strokeWidth={1.8} />);
}

class CalloutHeadWidget extends WidgetType {
  private readonly kind: string;
  private readonly title: string;
  constructor(kind: string, title: string) {
    super();
    this.kind = kind;
    this.title = title;
  }
  eq(other: CalloutHeadWidget): boolean {
    return other.kind === this.kind && other.title === this.title;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-callout-title";
    const icon = document.createElement("span");
    icon.className = "cm-callout-icon";
    icon.innerHTML = iconHtml(CALLOUT_ICONS[this.kind] ?? "pencil-line");
    const text = document.createElement("span");
    text.textContent = this.title;
    span.append(icon, text);
    return span;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 嵌入图片：异步解析目标 + 读成 data URL；找不到画一行灰字（图名） */
class ImageWidget extends WidgetType {
  private readonly target: string;
  private readonly alt: string;
  private readonly width: number | undefined;
  private readonly env: OfmEnv;
  private readonly missingText: (name: string) => string;
  constructor(target: string, alt: string, width: number | undefined, env: OfmEnv, missingText: (name: string) => string) {
    super();
    this.target = target;
    this.alt = alt;
    this.width = width;
    this.env = env;
    this.missingText = missingText;
  }
  eq(other: ImageWidget): boolean {
    return other.target === this.target && other.width === this.width && other.alt === this.alt && other.env === this.env;
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-ofm-img";
    wrap.dataset["state"] = "pending";
    const finish = (url: string | null): void => {
      if (url === null) {
        wrap.dataset["state"] = "missing";
        wrap.textContent = this.missingText(this.target);
      } else {
        wrap.dataset["state"] = "ready";
        const img = document.createElement("img");
        img.alt = this.alt;
        if (this.width !== undefined) img.width = this.width;
        img.addEventListener("load", () => view.requestMeasure());
        img.src = url;
        wrap.replaceChildren(img);
      }
      view.requestMeasure();
    };
    void this.env.resolver.resolve(this.target, "image").then((resolved) => {
      if (resolved === null) {
        finish(null);
        return;
      }
      void loadImageUrl(this.env.scope, resolved).then(finish);
    });
    return wrap;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

/** 解析状态变化（找到 / 找不到）后让装饰重算 */
const refresh = StateEffect.define<null>();

function codeRanges(state: EditorState, from: number, to: number): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (CODE_NODES.has(node.name)) {
        out.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return out;
}

const inAny = (ranges: readonly { from: number; to: number }[], from: number, to: number): boolean =>
  ranges.some((range) => from < range.to && to > range.from);

export interface OfmLive {
  extension: Extension;
  /** 文档变了 / 外部改过：忘掉双链「找到没找到」的记忆并重画 */
  reset(view: EditorView): void;
}

export function ofmLive(env: OfmEnv, missingText: (name: string) => string): OfmLive {
  // 双链目标 → 是否存在（异步问到之后记下，并让装饰重算）
  const known = new Map<string, boolean>();
  const asked = new Set<string>();

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private readonly view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        this.decorations = this.build(view);
      }
      update(update: ViewUpdate): void {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.focusChanged ||
          update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh)))
        ) {
          this.decorations = this.build(update.view);
        }
      }

      ask(target: string): void {
        if (asked.has(target)) return;
        asked.add(target);
        void env.resolver.resolve(target, "link").then((resolved) => {
          known.set(target, resolved !== null);
          // 视图可能已销毁：dispatch 前看一眼是否还连着
          if (this.view.dom.isConnected) this.view.dispatch({ effects: refresh.of(null) });
        });
      }

      build(view: EditorView): DecorationSet {
        const { state } = view;
        const doc = state.doc;
        const out: Range<Decoration>[] = [];
        const focused = view.hasFocus;
        const sel = state.selection.ranges;
        const near = (from: number, to: number): boolean => focused && sel.some((s) => s.from <= to && s.to >= from);
        const activeLine = (n: number): boolean => {
          if (!focused) return false;
          const line = doc.line(n);
          return sel.some((s) => s.from <= line.to && s.to >= line.from);
        };

        // frontmatter：文首的 --- 块
        const fm = splitFrontmatter(doc.sliceString(0, Math.min(doc.length, 4000)));
        const fmEnd = fm.yaml === null ? 0 : fm.bodyStart;
        if (fmEnd > 0) {
          const lastLine = doc.lineAt(Math.min(fmEnd, doc.length)).number;
          const lastFmLine = doc.sliceString(fmEnd - 1, fmEnd) === "\n" ? lastLine - 1 : lastLine;
          for (let n = 1; n <= Math.min(lastFmLine, doc.lines); n += 1) {
            out.push(Decoration.line({ class: "cm-frontmatter" }).range(doc.line(n).from));
          }
        }

        for (const { from, to } of view.visibleRanges) {
          const code = codeRanges(state, from, to);
          // 提醒框：引用块的首行是 [!type]
          syntaxTree(state).iterate({
            from,
            to,
            enter: (node) => {
              if (node.name !== "Blockquote") return undefined;
              const first = doc.lineAt(node.from);
              const head = /^\s{0,3}>\s?(\[![A-Za-z][\w-]*\][+-]?(?:\s+.*)?)$/.exec(first.text);
              const callout = head === null ? null : parseCalloutHead(head[1] as string);
              if (head === null || callout === null) return undefined;
              const kind = calloutKind(callout.type);
              const last = doc.lineAt(Math.min(node.to, doc.length)).number;
              for (let n = first.number; n <= last; n += 1) {
                const line = doc.line(n);
                const classes = ["cm-callout", `cm-callout-${kind}`];
                if (n === first.number) classes.push("cm-callout-head");
                if (n === last) classes.push("cm-callout-last");
                out.push(Decoration.line({ class: classes.join(" "), attributes: { "data-callout": kind } }).range(line.from));
              }
              if (!activeLine(first.number)) {
                // `> [!type]± 标题` → 图标 + 标题（空标题用类型名）
                const markEnd = first.from + first.text.length;
                const tokenStart = first.from + first.text.indexOf("[!");
                const title = callout.title === "" ? calloutDefaultTitle(callout.type) : callout.title;
                out.push(
                  Decoration.replace({ widget: new CalloutHeadWidget(kind, title) }).range(tokenStart, markEnd),
                );
              }
              return undefined;
            },
          });

          for (let pos = from; pos <= to; ) {
            const line = doc.lineAt(pos);
            pos = line.to + 1;
            if (line.number <= 0 || line.length === 0) continue;
            if (fmEnd > 0 && line.from < fmEnd) continue; // frontmatter 里不处理
            const text = line.text;
            if (!text.includes("[[") && !text.includes("==") && !text.includes("#") && !text.includes("![")) continue;
            const lineCode = code.filter((range) => range.from < line.to + 1 && range.to > line.from);

            // [[双链]] / ![[嵌入]]
            const re = wikiLinkRe();
            for (let m = re.exec(text); m !== null; m = re.exec(text)) {
              const start = line.from + m.index;
              const end = start + m[0].length;
              if (inAny(lineCode, start, end)) continue;
              const link = wikiLinkFromGroups(m[0], m[1], m[2], m[3], m[4]);
              if (link.embed && isImageName(link.target)) {
                if (near(start, end)) {
                  out.push(Decoration.mark({ class: "cm-wikilink cm-embed-src" }).range(start, end));
                } else {
                  const hint = parseEmbedHint(link.alias);
                  out.push(
                    Decoration.replace({
                      widget: new ImageWidget(link.target, hint.alt ?? link.target, hint.width, env, missingText),
                    }).range(start, end),
                  );
                }
                continue;
              }
              const labelFrom =
                link.alias !== null && link.alias !== "" ? start + m[0].lastIndexOf(link.alias) : start + (link.embed ? 3 : 2);
              const labelTo = link.alias !== null && link.alias !== "" ? labelFrom + link.alias.length : end - 2;
              if (link.target !== "") this.ask(link.target);
              const missing = link.target !== "" && known.get(link.target) === false;
              const cls = `cm-wikilink${link.embed ? " cm-embed-note" : ""}${missing ? " cm-wikilink-missing" : ""}`;
              if (near(start, end) || labelTo <= labelFrom) {
                out.push(Decoration.mark({ class: cls, attributes: { "data-ofm-target": link.target } }).range(start, end));
              } else {
                out.push(hidden.range(start, labelFrom));
                out.push(Decoration.mark({ class: cls, attributes: { "data-ofm-target": link.target } }).range(labelFrom, labelTo));
                out.push(hidden.range(labelTo, end));
              }
            }

            // ![](相对路径) 标准图片
            const stdImage = /!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s\n]+)(?:\s+"[^"\n]*")?\)/g;
            for (let m = stdImage.exec(text); m !== null; m = stdImage.exec(text)) {
              const start = line.from + m.index;
              const end = start + m[0].length;
              if (inAny(lineCode, start, end)) continue;
              const url = (m[2] as string).replace(/^<|>$/g, "");
              if (/^[a-z][a-z0-9+.-]*:/i.test(url) || near(start, end)) continue;
              out.push(Decoration.replace({ widget: new ImageWidget(url, m[1] as string, undefined, env, missingText) }).range(start, end));
            }

            // ==高亮==
            const mark = /(?<!=)==(?!=)(?=\S)([^\n=]*?\S)==(?!=)/g;
            for (let m = mark.exec(text); m !== null; m = mark.exec(text)) {
              const start = line.from + m.index;
              const end = start + m[0].length;
              if (inAny(lineCode, start, end)) continue;
              if (near(start, end)) {
                out.push(Decoration.mark({ class: "cm-ofm-mark" }).range(start, end));
              } else {
                out.push(hidden.range(start, start + 2));
                out.push(Decoration.mark({ class: "cm-ofm-mark" }).range(start + 2, end - 2));
                out.push(hidden.range(end - 2, end));
              }
            }

            // #标签
            const tags = tagRe();
            for (let m = tags.exec(text); m !== null; m = tags.exec(text)) {
              const start = line.from + m.index + (m[1] as string).length;
              const end = line.from + m.index + m[0].length;
              if (inAny(lineCode, start, end)) continue;
              // 标题行的 `# ` 不会走到这里（# 后是空格，不匹配）；`#标签` 前面是行首也认
              out.push(Decoration.mark({ class: "cm-ofm-tag" }).range(start, end));
            }
          }
        }
        return Decoration.set(out, true);
      }
    },
    {
      decorations: (plugin) => plugin.decorations,
      eventHandlers: {
        // ⌘ / Ctrl + 点击双链打开（编辑视图里普通点击是放光标）
        mousedown(event, view) {
          if (!(event.metaKey || event.ctrlKey)) return false;
          const el = (event.target as HTMLElement).closest<HTMLElement>("[data-ofm-target]");
          const target = el?.dataset["ofmTarget"];
          if (target === undefined || target === "") return false;
          event.preventDefault();
          void env.resolver.resolve(target, "link").then((resolved) => {
            if (resolved === null) env.onMissing(target);
            else env.onOpen(resolved);
          });
          view.focus();
          return true;
        },
      },
    },
  );
  return {
    extension: plugin,
    reset(view) {
      known.clear();
      asked.clear();
      view.dispatch({ effects: refresh.of(null) });
    },
  };
}
