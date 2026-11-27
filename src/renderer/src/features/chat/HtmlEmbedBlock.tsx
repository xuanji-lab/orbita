/**
 * ```html-embed 围栏 → 回答里的一张可交互的图（逐步演示的流程图、架构图、对比）。纯逻辑与文档拼装在 html-embed.ts。
 *
 * - **沙箱**：`sandbox="allow-scripts"` 的 iframe，文档来自一次性 `orbita-panel://` 地址（CSP 走响应头：不能联网、
 *   不能读本地文件、不能嵌框架、不能提交表单；没有 same-origin，拿不到我们的 DOM、preload 与 window.top）。
 *   收消息只认**这只 iframe 的 contentWindow**、来源必须是 `"null"`（沙箱不透明来源）。
 * - **宽度**随对话列（100%），**高度**由 iframe 里的引导脚本量好发回来，钳在 [48, 720]，超了图在 iframe 里自己滚。
 *   量过的高度按源码记在内存里：离开视口卸掉、回来重挂，或流式结束换了一次组件，占位都用上次的高，对话不跳。
 * - **流式**：围栏没闭合（MermaidPendingContext）时只画一块固定高的占位（「正在画图 · N 行」），闭合那一帧才挂。
 * - **性能**：视口上下各一屏之内才挂 iframe，离开三屏之外才卸（两道边界，滚动在边界上来回不反复挂卸）；
 *   不在视口里或窗口不在前台时，告诉 iframe 暂停（rAF 回调攒着、CSS 动画暂停）。
 * - **出错**：脚本异常 / 外链被拦 / 5 秒没就绪 → 上方一行原因，下面是源码；仍可切回去看图。
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { HTML_EMBED_MAX_BYTES, utf8Bytes } from "../../../../shared/chat-embed.ts";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { usePanelTheme } from "../plugins/BoardGrid.tsx";
import { MermaidPendingContext } from "./MermaidBlock.tsx";
import {
  EMBED_DEFAULT_HEIGHT,
  EMBED_IFRAME_SANDBOX,
  EMBED_READY_TIMEOUT_MS,
  activeMessage,
  buildEmbedDocument,
  embedHeights,
  parseEmbedMessage,
  themeMessage,
} from "./html-embed.ts";
import "./html-embed.css";

/** 视口上下各一屏之内挂；三屏之外卸（之间保持原样） */
const MOUNT_MARGIN = "100% 0px";
const UNMOUNT_MARGIN = "300% 0px";
/** 对话的滚动容器；找不到（别处复用，如文件面板的 markdown 预览）就按浏览器视口 */
const SCROLL_ROOT = ".chat-transcript";

// ---------- 窗口在不在前台（所有图共用一份监听） ----------

function windowActiveNow(): boolean {
  if (document.visibilityState === "hidden") return false;
  // 点进 iframe 时外层窗口会收到 blur：焦点在我们自己的子框架里也算在前台，否则一点图它就停了
  return document.hasFocus() || document.activeElement instanceof HTMLIFrameElement;
}

function subscribeWindowActive(onChange: () => void): () => void {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

function useWindowActive(): boolean {
  return useSyncExternalStore(subscribeWindowActive, windowActiveNow);
}

/** 元素与滚动根在某个外扩边距下相不相交（回调里只报 true / false） */
function useIntersecting(target: React.RefObject<HTMLElement | null>, margin: string, onChange: (hit: boolean) => void): void {
  useLayoutEffect(() => {
    const el = target.current;
    if (el === null) return;
    const root = el.closest(SCROLL_ROOT);
    const observer = new IntersectionObserver((entries) => onChange(entries.some((entry) => entry.isIntersecting)), { root, rootMargin: margin });
    observer.observe(el);
    return () => observer.disconnect();
  }, [target, margin, onChange]);
}

type Phase = { kind: "idle" } | { kind: "loading" } | { kind: "ready" } | { kind: "failed"; reason: string };

export function HtmlEmbedBlock(props: { source: string }) {
  const t = useT().chat;
  const pending = useContext(MermaidPendingContext);
  const theme = usePanelTheme();
  const windowActive = useWindowActive();
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [live, setLive] = useState(false);
  const [inView, setInView] = useState(false);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pointerInside, setPointerInside] = useState(false);
  const [height, setHeight] = useState(() => embedHeights.get(props.source) ?? EMBED_DEFAULT_HEIGHT);
  const themeRef = useRef(theme);
  themeRef.current = theme;

  const tooLarge = utf8Bytes(props.source) > HTML_EMBED_MAX_BYTES;

  // 源码换了（同一位置换成另一张图）：回到初始态
  useEffect(() => {
    setPhase({ kind: "idle" });
    setShowSource(false);
    setHeight(embedHeights.get(props.source) ?? EMBED_DEFAULT_HEIGHT);
  }, [props.source]);

  useIntersecting(hostRef, MOUNT_MARGIN, useCallback((hit: boolean) => hit && setLive(true), []));
  useIntersecting(hostRef, UNMOUNT_MARGIN, useCallback((hit: boolean) => !hit && setLive(false), []));
  useIntersecting(hostRef, "0px", setInView);

  const failed = phase.kind === "failed";
  // 要不要有一只 iframe：在视口附近、围栏闭合、没超限、没失败（失败后用户点「看图」会把 phase 拨回 idle）
  const wantFrame = live && !pending && !tooLarge && !failed && !showSource;

  // 换一次性地址。每次挂都要新的（取走一次即作废）；卸掉就丢
  useEffect(() => {
    if (!wantFrame) {
      setFrameUrl(null);
      // 卸掉后回到 idle：下次挂上收到 ready 时，主题与暂停两条消息会重新发给新的 iframe
      setPhase((previous) => (previous.kind === "failed" ? previous : { kind: "idle" }));
      return;
    }
    let cancelled = false;
    setPhase({ kind: "loading" });
    const html = buildEmbedDocument(props.source, themeRef.current);
    void api.chatEmbed.frame({ html }).then(
      (result) => {
        if (cancelled) return;
        if (result === null) setPhase({ kind: "failed", reason: t.embedTooLarge });
        else setFrameUrl(result.frameUrl);
      },
      (error: unknown) => {
        if (!cancelled) setPhase({ kind: "failed", reason: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [wantFrame, props.source, t]);

  // iframe 的消息（只认这一只、不透明来源）
  useEffect(() => {
    if (frameUrl === null) return;
    let ready = false;
    const timer = window.setTimeout(() => {
      if (!ready) setPhase({ kind: "failed", reason: t.embedTimeout });
    }, EMBED_READY_TIMEOUT_MS);
    const onMessage = (event: MessageEvent): void => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow || event.origin !== "null") return;
      const message = parseEmbedMessage(event.data);
      if (message === null) return;
      if (message.kind === "pointer") {
        setPointerInside(message.inside);
        return;
      }
      if (message.kind === "error") {
        const reason = message.code === "blocked" ? t.embedBlocked(message.message) : message.message === "" ? t.embedScriptError : message.message;
        setPhase({ kind: "failed", reason });
        return;
      }
      if (message.kind === "ready") {
        ready = true;
        setPhase((previous) => (previous.kind === "failed" ? previous : { kind: "ready" }));
      }
      if (message.height !== null) {
        embedHeights.set(props.source, message.height);
        setHeight(message.height);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      setPointerInside(false);
    };
  }, [frameUrl, props.source, t]);

  // 主题变了：发进去（不重挂）
  useEffect(() => {
    if (phase.kind !== "ready") return;
    frameRef.current?.contentWindow?.postMessage(themeMessage(theme), "*");
  }, [theme, phase.kind]);

  // 在视口里且窗口在前台才动
  const active = inView && windowActive;
  useEffect(() => {
    if (phase.kind !== "ready") return;
    frameRef.current?.contentWindow?.postMessage(activeMessage(active), "*");
  }, [active, phase.kind]);

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(props.source).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, [props.source]);


  if (pending) {
    const lines = props.source === "" ? 0 : props.source.split("\n").length;
    return (
      // 占位与图用同一个外框元素（同一个 ref）：视口观察在第一次挂载时就接上，围栏闭合后不用重接
      <div ref={hostRef} className="embed-block" data-phase="pending">
        <div className="embed-pending" aria-live="polite" style={{ height: EMBED_DEFAULT_HEIGHT }}>
          <Icon name="loader-circle" size={14} spin />
          <span>{t.embedPending(lines)}</span>
        </div>
      </div>
    );
  }

  const reason = tooLarge ? t.embedTooLarge : failed ? phase.reason : null;
  const sourceView = showSource || reason !== null;
  const toggleSource = (): void => {
    if (!sourceView) {
      setShowSource(true);
      return;
    }
    // 从源码切回图：失败态也给一次重来的机会
    setShowSource(false);
    setPhase({ kind: "idle" });
  };
  return (
    <div ref={hostRef} className="embed-block" data-phase={sourceView ? "source" : phase.kind} data-pointer={pointerInside && !sourceView ? "inside" : undefined}>
      {reason !== null ? (
        <p className="embed-fail">
          <Icon name="triangle-alert" size={12} />
          <span>{t.embedFailed(reason)}</span>
        </p>
      ) : null}
      <div className="embed-actions">
        {!tooLarge ? (
          <IconButton label={sourceView ? t.embedShowDiagram : t.embedShowSource} size={24} onClick={toggleSource}>
            <Icon name={sourceView ? "eye" : "file-code-2"} size={14} />
          </IconButton>
        ) : null}
        <IconButton label={copied ? t.embedCopied : t.embedCopy} size={24} onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={14} />
        </IconButton>
      </div>
      {sourceView ? (
        <pre className="embed-source">
          <code>{props.source}</code>
        </pre>
      ) : (
        <div className="embed-frame-box" style={{ height }}>
          {frameUrl !== null ? (
            <iframe
              ref={frameRef}
              className="embed-frame"
              src={frameUrl}
              sandbox={EMBED_IFRAME_SANDBOX}
              referrerPolicy="no-referrer"
              title={t.embedTitle}
              style={{ colorScheme: theme.scheme }}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
