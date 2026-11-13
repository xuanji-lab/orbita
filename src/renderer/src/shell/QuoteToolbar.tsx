import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TextQuote } from "@shared/quote";
import { Icon } from "./Icon";
import { useT } from "../locale.ts";

/** 划选之后浮出工具栏要的全部信息：引用、选区原文、选区在视口里的位置 */
export interface QuoteCandidate {
  quote: TextQuote;
  /** 选区原文（复制用，保留换行；quote.text 是规整过的） */
  raw: string;
  x: number;
  top: number;
  bottom: number;
}

/**
 * 划选小工具栏——「复制」进剪贴板、「引用」进输入框的引用 chip、「摘抄」存进摘抄。
 * 对话转录里的划选（ChatView 的 QuoteSelectionLayer）与文档编辑器里的划选是**两个消费者、
 * 同一条工具栏**：捕获选区的方式不同（DOM 选区 / CodeMirror 选区），浮条与三个动作一样。
 *
 * 摘抄只是收藏、不进模型，点一下就存；存完原地变「已摘抄」，停一拍半后收起并清掉选区。
 * 复制拷的是选区原文，按钮原地变「已复制」、约一秒后收起，选区留着（用户可能还想再引用）。
 * 按下浮层时 preventDefault，选区不丢。
 */
export function QuoteToolbar(props: {
  candidate: QuoteCandidate;
  /** 收起浮条（选区不动） */
  onDismiss: () => void;
  /** 清掉选区（引用 / 摘抄完成后；DOM 选区与编辑器选区清法不同，由宿主给） */
  onClearSelection: () => void;
  /** 缺席 = 「引用」键不出现（输入框不可用：只读 / 没配模型 / 子会话面板） */
  onQuote?: (quote: TextQuote) => void;
  /** 缺席 = 「摘抄」键不出现。raw 是选区原文 */
  onExcerpt?: (quote: TextQuote, raw: string) => Promise<"saved" | "duplicate">;
}) {
  const t = useT();
  const { candidate, onDismiss, onClearSelection, onQuote, onExcerpt } = props;
  /** 摘抄的短暂相位：存的中途、存好、已经摘过、失败——各自停一拍再收起 */
  const [excerptPhase, setExcerptPhase] = useState<"saving" | "saved" | "duplicate" | "failed" | null>(null);
  const [copied, setCopied] = useState(false);

  // 换了一次划选（新的 candidate）：两个短暂相位归零
  useEffect(() => {
    setCopied(false);
    setExcerptPhase(null);
  }, [candidate]);

  // 「已复制」停留约一秒后收起工具栏；选区不动
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => {
      setCopied(false);
      onDismiss();
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [copied, onDismiss]);

  // 摘抄的结果停一拍半再收起；成功（含已经摘过）连选区一起清掉，失败留着选区可以再点
  useEffect(() => {
    if (excerptPhase === null || excerptPhase === "saving") return undefined;
    const timer = window.setTimeout(() => {
      if (excerptPhase !== "failed") {
        onClearSelection();
        onDismiss();
      }
      setExcerptPhase(null);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [excerptPhase, onClearSelection, onDismiss]);

  // 贴着窗口顶的选区往上弹会被裁掉，改弹到选区下方
  const below = candidate.top < 56;
  return createPortal(
    <div
      role="toolbar"
      aria-label={t.quote.toolbar}
      data-quote-popover
      className="quote-toolbar"
      onPointerDown={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        left: candidate.x,
        top: below ? candidate.bottom + 8 : candidate.top - 8,
        transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
        zIndex: "var(--z-popover)",
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: 2,
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-panel)",
        boxShadow: "var(--shadow-popover)",
      }}
    >
      <button
        type="button"
        title={copied ? t.chat.copied : t.quote.copyTitle}
        aria-label={copied ? t.chat.copied : t.quote.copyTitle}
        onClick={() => {
          void navigator.clipboard.writeText(candidate.raw).then(
            () => setCopied(true),
            () => onDismiss(),
          );
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={13} strokeWidth={1.8} />
        {copied ? t.chat.copied : t.quote.copy}
      </button>
      {onQuote !== undefined && (
        <button
          type="button"
          title={t.quote.addTitle}
          onClick={() => {
            onQuote(candidate.quote);
            onClearSelection();
            onDismiss();
          }}
        >
          <Icon name="quote" size={13} strokeWidth={1.8} />
          {t.quote.add}
        </button>
      )}
      {onExcerpt !== undefined && (
        <button
          type="button"
          title={t.quote.excerptTitle}
          aria-live="polite"
          disabled={excerptPhase === "saving"}
          data-done={excerptPhase === "saved" || excerptPhase === "duplicate" || undefined}
          onClick={() => {
            if (excerptPhase !== null && excerptPhase !== "failed") return;
            setExcerptPhase("saving");
            void onExcerpt(candidate.quote, candidate.raw).then(
              (result) => setExcerptPhase(result),
              () => setExcerptPhase("failed"),
            );
          }}
        >
          <Icon
            name={
              excerptPhase === "saving"
                ? "loader-circle"
                : excerptPhase === "saved" || excerptPhase === "duplicate"
                  ? "check"
                  : excerptPhase === "failed"
                    ? "triangle-alert"
                    : "bookmark"
            }
            size={13}
            strokeWidth={1.8}
            spin={excerptPhase === "saving"}
          />
          {excerptPhase === "saved"
            ? t.quote.excerptSaved
            : excerptPhase === "duplicate"
              ? t.quote.excerptDuplicate
              : excerptPhase === "failed"
                ? t.quote.excerptFailed
                : t.quote.excerpt}
        </button>
      )}
    </div>,
    document.body,
  );
}
