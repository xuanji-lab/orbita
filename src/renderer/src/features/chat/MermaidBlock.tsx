/**
 * ```mermaid 代码块 → pele 画成图（对话与文件面板的 Markdown 预览共用，两处都走 MdPre）。
 *
 * - **pele/lazy 按需加载**：主入口把 36 种图表全打进来，lazy 只在第一次遇到某种图时
 *   拉那一种的 chunk（体积数字见 PR 描述）。
 * - **流式不重画**：尾块的围栏还没闭合（MarkdownBlock 经 context 告知 `pending`）时按普通
 *   代码显示，闭合那一帧或消息落定后才画——半截语法每个 token 重画一次只会连环报错。
 * - **失败退回**：语法错 / 超限 / 复核不过，上方一行灰字说明原因，下面是原来的代码块。
 * - **安全**：选项固定、SVG 插入前过 svgViolation（见 mermaid-render.ts 顶部信任模型）。
 * - 没有「复制源码」键：现有代码块（CodeBlock.tsx）本来就没有这个键，保持一致；
 *   源码可直接划选复制（失败退回的代码块也是）。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { mountAsync } from "pele/lazy";
import { useT } from "../../locale.ts";
import { MERMAID_OPTIONS, PELE_THEME_VARS, failureReason, svgViolation } from "./mermaid-render.ts";

/** 当前这个块是否还在流式写入（围栏没闭合）。MarkdownChunk 提供，缺省 false。 */
export const MermaidPendingContext = createContext(false);

const THEME_STYLE = PELE_THEME_VARS as CSSProperties;

/** pele 的 SVG 字符串 → DOM 节点；复核不过就抛，mount 会走 onError，不会插进页面 */
function sanitizeSvg(svg: string): Node {
  const violation = svgViolation(svg);
  if (violation !== null) throw new Error(violation);
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  return document.importNode(doc.documentElement, true);
}

/**
 * 图容器此刻的字号（继承正文字号）。界面字号（`--ui-font-size`）在根元素的 style 上改，字号变了要重画——
 * pele 把字号烘进 SVG，不重画图就停在旧字号。没读到（0）= 还没量过，调用方先别画。
 */
function useHostFontSize(host: RefObject<HTMLElement | null>): number {
  const [size, setSize] = useState(0);
  useLayoutEffect(() => {
    const el = host.current;
    if (el === null) return;
    const read = (): void => {
      const value = Number.parseFloat(getComputedStyle(el).fontSize);
      if (Number.isFinite(value) && value > 0) setSize((previous) => (previous === value ? previous : value));
    };
    read();
    const observer = new MutationObserver(read);
    // style 是 --ui-font-size 等运行时覆盖；class / data-theme 的切换（纸面主题换字体档）也可能改字号
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class", "data-theme", "lang"] });
    return () => observer.disconnect();
  }, [host]);
  return size;
}

type Phase = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; reason: string };

export function MermaidBlock(props: { source: string }) {
  const t = useT();
  const pending = useContext(MermaidPendingContext);
  const host = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const fontSize = useHostFontSize(host);

  useEffect(() => {
    const el = host.current;
    if (pending || el === null || fontSize === 0) return;
    let cancelled = false;
    setPhase({ kind: "loading" });
    const fail = (error: unknown): void => {
      if (cancelled) return;
      el.replaceChildren();
      setPhase({ kind: "failed", reason: failureReason(error) });
    };
    let destroy: (() => void) | undefined;
    // 字号跟随容器（继承正文字号）；用户调 --ui-font-size 时 fontSize 变，这个 effect 重跑、图重画
    mountAsync(el, props.source, {
      ...MERMAID_OPTIONS,
      fontSize,
      sanitize: sanitizeSvg,
      onRender: () => {
        if (!cancelled) setPhase({ kind: "ready" });
      },
      onError: fail,
    }).then(
      (mounted) => {
        if (cancelled) mounted.destroy();
        else destroy = () => mounted.destroy();
      },
      fail,
    );
    return () => {
      cancelled = true;
      destroy?.();
      el.replaceChildren();
    };
  }, [props.source, pending, fontSize]);

  const showCode = pending || phase.kind === "failed";
  return (
    <div className="mermaid-block" data-phase={pending ? "pending" : phase.kind}>
      {phase.kind === "failed" && !pending ? (
        <p className="mermaid-fail">
          {t.chat.mermaidFailed}
          {phase.reason}
        </p>
      ) : null}
      {/* 图容器始终在 DOM 里（mount 要量宽度），失败 / 未闭合时折叠为空 */}
      <div ref={host} className="mermaid-diagram" style={THEME_STYLE} hidden={showCode} />
      {showCode ? (
        <pre>
          <code>{props.source}</code>
        </pre>
      ) : null}
    </div>
  );
}
