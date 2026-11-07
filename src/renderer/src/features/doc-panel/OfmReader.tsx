import { memo, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeCallouts from "rehype-callouts";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkCjkFriendly from "remark-cjk-friendly";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { PluggableList } from "unified";
import "katex/dist/katex.min.css";
import type { OfmResolved } from "../../../../shared/doc.ts";
import { rehypeCalloutKind } from "../../../../shared/ofm/rehype-callout-kind.ts";
import { rehypeSourceLines } from "../../../../shared/ofm/rehype-source-lines.ts";
import { plainParagraphs } from "./read-quote.ts";
import { remarkOfm } from "../../../../shared/ofm/remark-ofm.ts";
import { normalizeEmphasisInnerSpace } from "../chat/emphasis-space.ts";
import { MdPre } from "../chat/CodeBlock";
import { dominantScript } from "../chat/dominant-script";
import { remarkDemoteBoundaryMath } from "../chat/math-guard";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { loadImageUrl } from "./ofm-images.ts";
import type { OfmEnv } from "./ofm-env.ts";
import { OfmEnvContext, useOfmEnv } from "./ofm-context.ts";

/**
 * 文档的阅读视图：remark → rehype 渲染 Obsidian 风格 markdown。
 *
 * 管线：remark-frontmatter（属性表）→ gfm → CJK 加粗 → 数学 → 单换行成 `<br>`（Obsidian 默认也是这样，
 * 纯文本风格的笔记才好看）→ 自写 OFM 插件（双链 / 嵌入 / 高亮 / 标签）；rehype：raw + sanitize（只放行
 * `<details>`/`<summary>` 与 OFM 自己的 class / data-ofm-*，其它标签剥掉）→ rehype-callouts（提醒框，
 * 可折叠）→ 补 data-kind → KaTeX。代码块 / 行内代码里的 `[[` `==` `#` 不转换（它们不是文本节点）。
 *
 * 图片与双链的目标由环境里的解析器问主进程（同目录优先 → 工作区同名文件）；远程图不自动加载
 * （隐私：和聊天同一条规矩），画成点了才去内置浏览器的链接。
 */

/** 超过这个字数的文档，阅读视图退回纯文本（DOM 代价：和文件预览的 markdown 上限同一个考虑，只是文档面板放宽） */
export const READ_VIEW_LIMIT = 300_000;

const OFM_TAGS = ["a", "span", "mark", "img", "div"];
const withOfmAttributes = (tag: string) => [
  // 默认的 className 项带取值限制（脚注回链等），这里换成放行任意 class
  ...(defaultSchema.attributes?.[tag] ?? []).filter((attr) => !(Array.isArray(attr) && attr[0] === "className") && attr !== "className"),
  "className",
  "data*",
];

const SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary", "mark"],
  attributes: {
    ...defaultSchema.attributes,
    ...Object.fromEntries(OFM_TAGS.map((tag) => [tag, withOfmAttributes(tag)])),
  },
};

const KATEX: [typeof rehypeKatex, { throwOnError: boolean; strict: boolean; trust: boolean }] = [
  rehypeKatex,
  { throwOnError: false, strict: false, trust: false },
];

const REMARK: PluggableList = [
  [remarkFrontmatter, ["yaml"]],
  remarkGfm,
  remarkCjkFriendly,
  remarkMath,
  remarkBreaks,
  remarkDemoteBoundaryMath,
  [remarkOfm, { properties: true }],
];
const REHYPE: PluggableList = [rehypeRaw, [rehypeSanitize, SCHEMA], rehypeCallouts, rehypeCalloutKind, KATEX, rehypeSourceLines];

type Props<T extends keyof React.JSX.IntrinsicElements> = ComponentPropsWithoutRef<T> & { node?: unknown };

function OfmAnchor(props: Props<"a"> & { "data-ofm-target"?: string; "data-ofm-fragment"?: string }) {
  const { href, children, node: _node, className, ...rest } = props;
  const target = props["data-ofm-target"];
  if (target !== undefined) {
    return <WikiLink target={target} fragment={props["data-ofm-fragment"]} className={className}>{children}</WikiLink>;
  }
  const external = href !== undefined && /^(https?:|mailto:)/i.test(href);
  return (
    <a
      className={className}
      href={external ? href : undefined}
      onClick={
        external
          ? (event) => {
              event.preventDefault();
              window.open(href);
            }
          : undefined
      }
    >
      {children}
    </a>
  );
}

/** 解析一个目标：undefined = 还在问，null = 找不到 */
function useResolved(env: OfmEnv | null, target: string, kind: "link" | "image"): OfmResolved | undefined {
  const [state, setState] = useState<OfmResolved | undefined>(undefined);
  useEffect(() => {
    if (env === null || target === "") {
      setState(null);
      return undefined;
    }
    let alive = true;
    void env.resolver.resolve(target, kind).then((result) => {
      if (alive) setState(result);
    });
    return () => {
      alive = false;
    };
  }, [env, target, kind]);
  return state;
}

function WikiLink(props: { target: string; fragment?: string | undefined; className?: string | undefined; children?: ReactNode }) {
  const t = useT();
  const env = useOfmEnv();
  const resolved = useResolved(env, props.target, "link");
  const label = typeof props.children === "string" ? props.children : props.target;
  const missing = resolved === null && props.target !== "";
  return (
    <a
      className={`${props.className ?? ""}${missing ? " ofm-missing-link" : ""}`}
      data-state={resolved === undefined ? "pending" : missing ? "missing" : "found"}
      title={missing ? t.doc.linkMissing(props.target) : props.target}
      href={undefined}
      role="link"
      tabIndex={0}
      onClick={() => {
        if (env === null) return;
        if (resolved === null || resolved === undefined) {
          if (props.target !== "") env.onMissing(props.target);
          return;
        }
        env.onOpen(resolved);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.currentTarget as HTMLElement).click();
      }}
    >
      {props.children ?? label}
    </a>
  );
}

function OfmImage(props: Props<"img"> & { "data-ofm-embed"?: string }) {
  const t = useT();
  const env = useOfmEnv();
  const embed = props["data-ofm-embed"];
  const src = typeof props.src === "string" ? props.src : "";
  const remote = /^https?:/i.test(src);
  const target = embed ?? (remote || src === "" ? "" : src);
  const resolved = useResolved(env, target, "image");
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (env === null || resolved === undefined || resolved === null) {
      setUrl(resolved === null ? null : undefined);
      return undefined;
    }
    let alive = true;
    void loadImageUrl(env.scope, resolved).then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [env, resolved]);

  const name = embed ?? (typeof props.alt === "string" && props.alt !== "" ? props.alt : src);
  if (remote) {
    // 远程图不自动加载（隐私）：占位链接，点了才在内置浏览器里看
    return (
      <a
        className="chat-img-placeholder"
        href={src}
        onClick={(event) => {
          event.preventDefault();
          window.open(src);
        }}
      >
        {typeof props.alt === "string" && props.alt !== "" ? props.alt : src}
      </a>
    );
  }
  if (url === undefined && resolved === undefined) {
    return <span className="ofm-img-pending" aria-hidden="true" />;
  }
  if (url === null || resolved === null) {
    return (
      <span className="ofm-img-missing" role="img" aria-label={t.doc.imageMissing(name)}>
        <Icon name="image" size={14} strokeWidth={1.8} />
        <span>{t.doc.imageMissing(name)}</span>
      </span>
    );
  }
  if (url === undefined) return <span className="ofm-img-pending" aria-hidden="true" />;
  return (
    <img
      className="ofm-img"
      src={url}
      alt={typeof props.alt === "string" ? props.alt : name}
      {...(props.width === undefined ? {} : { width: props.width })}
      {...(props.height === undefined ? {} : { height: props.height })}
      loading="lazy"
    />
  );
}

const COMPONENTS: Components = {
  a: OfmAnchor as Components["a"],
  img: OfmImage as Components["img"],
  pre: (preProps: { children?: ReactNode }) => <MdPre {...preProps} highlight />,
};

/** 阅读视图。`text` 是 markdown 全文（含 frontmatter）；`.txt` 由调用方走纯文本 */
export const OfmReader = memo(function OfmReader(props: { text: string; env: OfmEnv }) {
  const t = useT();
  const normalized = useMemo(() => normalizeEmphasisInnerSpace(props.text), [props.text]);
  const tooLong = props.text.length > READ_VIEW_LIMIT;
  return (
    <OfmEnvContext.Provider value={props.env}>
      <div className="chat-md ofm-doc" data-script={dominantScript(props.text)}>
        {tooLong ? (
          <>
            <p className="ofm-note">{t.doc.readTooLong}</p>
            <pre className="ofm-plain">{props.text}</pre>
          </>
        ) : (
          <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
            {normalized}
          </ReactMarkdown>
        )}
      </div>
    </OfmEnvContext.Provider>
  );
});

/** `.txt`：不当 markdown 解析——保留换行与缩进，按段落排版 */
export function PlainTextReader(props: { text: string }) {
  return (
    <div className="chat-md ofm-doc ofm-plain-text" data-script={dominantScript(props.text)}>
      {plainParagraphs(props.text).map((paragraph, index) => (
        <p key={index} data-sl={paragraph.sl} data-el={paragraph.el}>
          {paragraph.text}
        </p>
      ))}
    </div>
  );
}
