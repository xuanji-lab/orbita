import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { ApprovalBar } from "./ApprovalBar";
import { QueueStrip } from "./QueueStrip";
import { compactionBoundaryStatus, mergeSideRecords } from "./session-states";
import {
  ChannelFromChildPill,
  ChannelFromParentBubble,
  ChannelToolMarkLine,
  DelegateCardView,
  peerTitleOf,
  type ChannelViewContext,
  type DelegateCardStatus,
} from "./ChannelViews";
import { useChannelMessages, useParentChannels } from "./useChannelMessages";
import { useChannelSummaries } from "./useChannelSummaries";
import {
  HOME_CARD_CARRYOVER_ROWS,
  HOME_CARD_QUERY_ROWS,
  selectHomeCards,
} from "./home-cards";
import { isAtBottom, isBeyondScrollDown, shouldJumpToEnd, shouldLoadOlder } from "./scroll.ts";
import { bubbleClampStyle, isBubbleOverflowing } from "./user-bubble-clamp.ts";
import { EXPANDED_FRAME, RAIL_X } from "./expanded-body.ts";
import { clampToolBody } from "./tool-body-clamp.ts";
import { noticeIconBoxStyle, noticeParagraphStyle, noticeTextStyle } from "./notice.ts";
import { ExitCard } from "./ExitCard";
import { PanelButton } from "../../shell/RightPanel";
import { ProcessViewContext } from "./process-view-context";
import { runStateOf } from "../notify/completion-notice.ts";
import { REVEAL_ENTRY_EVENT } from "../context/task-progress.ts";
import {
  CHAPTER_STEPS_SHOWN,
  SLOW_GAP_MS,
  TAIL_AFTER_MS,
  processChapters,
  processCounts,
  processLive,
  type ProcessChapter,
} from "./turn-process.ts";
import {
  branchAnchorEntries,
  branchAnchorIds,
  answerText,
  delegateCard,
  handoffOutcome,
  editDiffText,
  failedFoldKey,
  fileViewFor,
  flattenRenderUnits,
  formatToolDuration,
  formatThinkingDuration,
  groupToolUnits,
  groupTurns,
  groupTurnsByTurn,
  rollupToolKey,
  indexToolResults,
  interruptedToolCallIds,
  mcpFailureLead,
  mcpInputSummary,
  readTaskCard,
  showImageCard,
  type ShowImageCardView,
  summarizeMcpResult,
  liveTailLines,
  expectedSecondsOf,
  formatRunClock,
  shellAutoExpand,
  stripTrailingBlankLines,
  tailPreviewLines,
  timeoutSecondsOf,
  toolStartAt,
  parseEditDiff,
  editDiffEntries,
  parseGrepLine,
  splitPathTail,
  streamingThinkingKey,
  summarizeToolResult,
  editDiffStats,
  editGroupFileCount,
  thinkingDurationText,
  thinkingPreview,
  toolCallSummary,
  toolDurationText,
  toolExpandable,
  toolGroupStatus,
  toolResultText,
  rollupLead,
  turnAssistantRecords,
  turnStats,
  type ProcessStep,
  type TurnProcessUnit,
  writeLineCount,
  type ChannelMarkTone,
  type IntraToken,
  type RenderEntry,
  type ToolGroupUnit,
  type ToolResultIndex,
  type TurnGroupUnit,
} from "./tool-results";
import { useToday } from "./today.ts";
import { formatMessageTime, fullTimestamp } from "./message-time.ts";
import { highlighterReady, highlightLines, langFromPath, type TokenSpan } from "./highlight";
import { Composer } from "../../shell/Composer";
import {
  insertToken,
  panelInsertPosition,
  type PanelInsertRequest,
  type TokenPickResult,
} from "../../shell/panel-token.ts";
import { SessionCard } from "../../shell/SessionCard";
import { Chip } from "../../shell/Chip";
import { Menu, menuFooterRowStyle, type MenuItem } from "../../shell/Menu";
import { InlineName } from "../../shell/InlineName";
import { IconButton } from "../../shell/IconButton";
import { Icon, type IconName } from "../../shell/Icon";
import { MarkdownBlock } from "./MarkdownBlock";
import { HomeHero } from "./HomeHero";
import { WrapupCard } from "./WrapupCard";
import { useExperimentalFeature } from "../../experimental.ts";
import { FileTurnCard, RevertMarkView } from "./FileTurnCard";
import type { MemorySessionTurnView } from "@shared/memory";
import { useMemorySession } from "../memory/useMemory.ts";
import { liveRemembered, pairMemoryTurns } from "../memory/memory-view.ts";
import "../memory/memory.css";
import { DiffBody } from "../../shell/DiffView";
import { RevertPreviewBar } from "./RevertPreviewBar";
import { collectCitations } from "./citation-markers.ts";
import { CitationTableContext } from "./citation-context.ts";
import { RevertPreviewContext, type RevertPreview } from "./revert-preview.ts";
import { CarryoverScanCard } from "./CarryoverScanCard";
import { matchScanMessage, type ScanMessage } from "./carryover-parse.ts";
import {
  contextRing,
  formatSpeed,
  replySpeed,
  ringLayers,
  streamingStart,
  usageBreakdown,
  WRAP_UP_AFTER_COMPACTIONS,
  type ContextRing,
  type RingLayers,
} from "./stats-format";
import { isPlanBilling } from "@shared/known-providers";
import { deriveWorkspaceName } from "@shared/workspace";
import { modelCardFooter, modelChipParts, ModelPickerMenu, selectedModelAcceptsImage } from "../settings/model-menu";
import { filesOf, imageSrc } from "../../shell/composer-images.ts";
import { ImageLightbox } from "../../shell/ImageLightbox";
import { PaperclipMark } from "../../shell/PaperclipMark";
import { ImageThumb } from "../../shell/ImageThumb";
import { QuoteChip } from "../../shell/QuoteChip";
import { parseQuotedMessage, type TextQuote } from "@shared/quote";
import { pastedTextSize, splitUserTextBlocks } from "@shared/prompt-attachments";
import { FileRefChip, PastedTextChip } from "../../shell/attachment-chips";
import { findQuoteSource, locateQuote, nthUserMessageId, quoteFromSelection } from "./quote-select.ts";
import type { PromptImage } from "@shared/prompt-images";
import type { ChannelMessage } from "@shared/channel";
import { modelDisplayName, modelThinkingLevels } from "@shared/model-defaults";
import { declaredThinkingLevels, modelPreferenceById } from "../settings/providers-view-model.ts";
import { estimateStreamingTokens, messageSpeed } from "@shared/message-speed";
import { parseQualifiedToolName, type McpServerInfo } from "@shared/mcp";
import { parseSkillSegments, skillForReadPath } from "@shared/skill";
import { stripInvocationBlock } from "@shared/invocation";
import type { SkillMeta, SkillSegment } from "@shared/skill";
import { api } from "../../api";
import { retryCauseText, retryLineText } from "./retry-text";
import { IntentRecallFinalCard, IntentRecallRunCard } from "./IntentRecallCard.tsx";
import { IntentConfirmCard } from "./IntentConfirmCard.tsx";
import type { IntentRecallRecord } from "@shared/session";
import type { RecallCardState } from "@shared/intent-recall";
import { PERMISSION_MODES } from "@shared/permission";
import { THINKING_LEVELS, THINKING_LEVEL_LABELS } from "@shared/thinking";
import {
  childSessions,
  deriveSessionTitle,
  type ChannelMarkRecord,
  type CompactedRecord,
  type SessionCompletion,
} from "@shared/session";
import type { FileTurnView, RevertRecord, UndoRecord } from "@shared/revert";
import type { RetryStatus } from "@shared/agent-ipc";
import type { ChatSession } from "./useChatSession";
import type { ModelPair, ThemePreference } from "@shared/settings";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";

/**
 * 展开体的贴底跟随：chat 级滚动（上方 ChatView）同款语义的缩小版——内容增长
 * 钉住底部，用户上滚脱离即停跟，滚回底部自动恢复。`enabled` 只在活体上开
 * （流式思考、跑着的 shell）；静态内容没有「跟随」可言，展开从顶部开始读，
 * 用户滚到哪就停在哪。跟 chat 级一样用 ref 不用 state：滚动是高频事件，
 * 不值得为它重渲染。
 */
function useFollowScroll(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el !== null) {
      followRef.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    }
  };
  // 无依赖数组：不挑触发源，每次 commit 都尝试钉底（scrollTop 赋值廉价），绘制前同步执行
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && enabled && followRef.current) el.scrollTop = el.scrollHeight;
  });
  return { ref, onScroll };
}

/**
 * 中卡的内容：首页与聊天页。
 *
 * 两页共用同一个 `Composer`，宽度都是 `min(100%, var(--content-max-width))`——
 * 这就是 R8-01 ②「输入框宽度跨页面保持一致」：两页的差别只有 slogan 消失、
 * 输入框从居中落到底部，别的都不动。
 */
type ChatViewProps = Parameters<typeof ChatViewBody>[0];

/** 摘抄跳回原文的一次性请求（App 发起，ChatView 消费后滚到原文并闪一下）。 */
export interface ExcerptJumpRequest {
  sessionId: string;
  turn?: number;
  role: "user" | "assistant";
  text: string;
  token: number;
}

/**
 * 拖图进来的落点是**整个聊天面板**，不只是输入框卡片——用户拖文件时眼睛看的是
 * 聊天区，松手在转录上是最常见的落点；只认输入框的话，落在别处什么都不发生
 * （窗口级守卫只拦导航），看起来就是「拖不进去」。
 *
 * 包一层 `display: contents`：不改任何布局，DOM 上仍是祖先，拖放事件照常冒泡到这里。
 * 每个 ChatView 各包各的——主槽与右抽屉并排时，落在哪边就进哪边的输入框。
 * 输入框不可用（没 provider / 只读 / 子会话面板不出输入框）时不接，文件落下即被窗口守卫吞掉。
 */
export function ChatView(props: ChatViewProps) {
  const { session } = props;
  const [dropActive, setDropActive] = useState(false);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const accepts = props.hideComposer !== true && session.usable.length > 0 && !session.readOnly;
  const carriesFiles = (event: React.DragEvent) => accepts && event.dataTransfer.types.includes("Files");
  // 引用跳转：原文在本转录里找得到才给得出（发出去的引用不带 id，按轮号 + 角色 + 原文找；
  // 迁移来的引用、被压缩掉的历史找不到就不可点）
  const jumpToQuote = useCallback(
    (quote: TextQuote): (() => void) | undefined => {
      const sourceId = findQuoteSource(session.transcript, quote);
      if (sourceId === null) return undefined;
      return () => {
        const pane = paneRef.current;
        if (pane !== null) highlightQuote(pane, sourceId, quote.text);
      };
    },
    [session.transcript],
  );
  // PDF 引用表（实验功能「PDF 引用」）：本会话 cite_pdf 核验过的引用，正文里的编号据此可点
  const citations = useMemo(() => collectCitations(session.transcript), [session.transcript]);
  // 摘抄与跳回原文按「正在看的会话」算：纯浏览的旧会话不起 runtime session（sessionId 为
  // null、opened 里拿得到），但它的文字照样能摘、摘过的照样能跳回来
  const viewedId = session.sessionId ?? session.opened?.id ?? null;
  // 摘抄跳回原文（审查面板 › 摘抄页签）：切会话后转录异步加载，token + 已应用水位保证
  // 「加载到那一轮了再滚一次、只滚一次」。逐字原文找不到（被编辑、被回退）就退回到那一轮
  // 的用户消息整块闪一下——至少落在对的地方。迁移来的旧摘抄没有轮号：只按原文找
  const jumpApplied = useRef(0);
  const { excerptJump } = props;
  useEffect(() => {
    if (excerptJump === null || excerptJump === undefined || excerptJump.token === jumpApplied.current) return;
    if (excerptJump.sessionId !== viewedId) return;
    const turns = session.transcript.filter((item) => item.role === "user").length;
    if (excerptJump.turn !== undefined && turns < excerptJump.turn) return;
    if (session.transcript.length === 0) return;
    const sourceId =
      findQuoteSource(session.transcript, {
        messageId: "",
        role: excerptJump.role,
        text: excerptJump.text,
        ...(excerptJump.turn !== undefined ? { turn: excerptJump.turn } : {}),
      }) ?? (excerptJump.turn !== undefined ? nthUserMessageId(session.transcript, excerptJump.turn) : null);
    if (sourceId === null) {
      jumpApplied.current = excerptJump.token;
      return;
    }
    // 刚切过来的会话会连着提交好几次（转录分批、图片、轮尾卡），每次提交都会被
    // useFollowScroll 钉回底部：平滑滚动刚起步就被拽回去（真机：高亮在视口上方几千像素）。
    // 等两帧让这一波提交落定，再**瞬时**滚过去——瞬时滚动立刻产生一次离底的 scroll
    // 事件，把「跟随到底」关掉，之后的提交不再拽它
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const pane = paneRef.current;
        if (pane === null) return;
        // 真滚了才记水位：两帧之内转录又变时清理会取消这一次，下次 effect 重排
        jumpApplied.current = excerptJump.token;
        highlightQuote(pane, sourceId, excerptJump.text, "auto");
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [excerptJump, session.transcript, viewedId]);
  const { onExcerptSaved } = props;
  const saveExcerpt = useMemo(
    () =>
      viewedId === null
        ? undefined
        : async (quote: TextQuote, raw: string): Promise<"saved" | "duplicate"> => {
            const result = await api.excerpt.add({
              sessionId: viewedId,
              role: quote.role,
              // 存选区原文（保留换行）；引用用的 quote.text 压过空白、截过上限
              text: raw,
              ...(quote.turn !== undefined ? { turn: quote.turn } : {}),
            });
            onExcerptSaved?.();
            return result.duplicate ? "duplicate" : "saved";
          },
    [viewedId, onExcerptSaved],
  );
  return (
    <div
      ref={paneRef}
      style={{ display: "contents" }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dropActive) setDropActive(true);
      }}
      onDragLeave={(event) => {
        // 在面板内部元素之间移动也会触发 leave；只有真离开面板才收
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDropActive(false);
      }}
      onDrop={(event) => {
        setDropActive(false);
        if (!carriesFiles(event)) return;
        event.preventDefault();
        session.attachIncoming(filesOf(event.dataTransfer));
      }}
    >
      <QuoteJumpContext.Provider value={jumpToQuote}>
        <CitationTableContext.Provider value={citations}>
          <ChatViewBody {...props} dropActive={dropActive} />
        </CitationTableContext.Provider>
      </QuoteJumpContext.Provider>
      {/* 复制与摘抄只读文字，只读（没有 pi 本子的旧会话）/ 没配模型的会话里也能用；引用要往输入框里放，
          输入框不可用时那一键不出现 */}
      <QuoteSelectionLayer
        paneRef={paneRef}
        transcript={session.transcript}
        onQuote={
          accepts
            ? (quote) => {
                session.addQuote(quote);
                // 引完回到输入框接着写——引用就是为了下一句话
                paneRef.current?.querySelector<HTMLTextAreaElement>("textarea.composer-input")?.focus();
              }
            : undefined
        }
        onExcerpt={saveExcerpt}
      />
    </div>
  );
}

/** 引用 → 跳回原文的处理器（undefined = 原文不在本转录里）。ChatView 外层提供，chip 们各自取 */
const QuoteJumpContext = createContext<(quote: TextQuote) => (() => void) | undefined>(() => undefined);

/**
 * 把一处（引用的那段文字，或整块）滚到转录区**顶部**，留一点边距。不用
 * `scrollIntoView({ block: "center" })`：一条长回复整块居中时，被引用的那句常落在
 * 下半截，正好压在输入框上方叠起来的卡片（排队条、审批条、附图与引用）后面。
 */
function scrollToTop(target: Element, rect: DOMRect, behavior: ScrollBehavior = "smooth"): void {
  const container = target.closest<HTMLElement>(".scroll");
  if (container === null) {
    target.scrollIntoView({ block: "start", behavior });
    return;
  }
  const top = container.scrollTop + rect.top - container.getBoundingClientRect().top - 24;
  container.scrollTo({ top: Math.max(0, top), behavior });
}

/**
 * 跳回被引用的原文：把那一段滚到转录区顶部、高亮 2.4 秒。一条助手消息可能拆成
 * 几个文本块（都带同一个 data-quote-id），挑包含这段原文的那块；逐字定位不到
 * （原文被 markdown 渲染改写得太多）就整块闪一下——至少把人带到对的地方。
 */
function highlightQuote(pane: HTMLElement, messageId: string, text: string, behavior: ScrollBehavior = "smooth"): void {
  const blocks = Array.from(pane.querySelectorAll<HTMLElement>(`[data-quote-id="${CSS.escape(messageId)}"]`));
  for (const block of blocks) {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) nodes.push(node as Text);
    const at = locateQuote(nodes.map((node) => node.data), text);
    const startNode = at === null ? undefined : nodes[at.start.node];
    const endNode = at === null ? undefined : nodes[at.end.node];
    if (at === null || startNode === undefined || endNode === undefined) continue;
    const range = document.createRange();
    range.setStart(startNode, at.start.offset);
    range.setEnd(endNode, at.end.offset);
    scrollToTop(block, range.getBoundingClientRect(), behavior);
    CSS.highlights.set("orbita-quote", new Highlight(range));
    window.setTimeout(() => CSS.highlights.delete("orbita-quote"), 2400);
    return;
  }
  const fallback = blocks[0];
  if (fallback === undefined) return;
  scrollToTop(fallback, fallback.getBoundingClientRect(), behavior);
  fallback.classList.remove("quote-flash");
  // 强制回流，让同一块连点两次时动画能重新开始
  void fallback.offsetWidth;
  fallback.classList.add("quote-flash");
}

/**
 * 划选引用的入口（Proma 的 AgentHistorySelectionLayer 同款交互）：在转录里划选一段文字，
 * 松手后选区上方浮出一条小工具栏——「复制」进剪贴板、「引用」进输入框的引用 chip、
 * 「摘抄」存进摘抄（审查面板的「摘抄」页签里翻）。
 *
 * 摘抄只是收藏、不进模型，所以点一下就存，不问态度；存完原地变「已摘抄」（同一段已经
 * 摘过则是「已经摘过」），停一拍后收起并清掉选区——这段话已经处理完了。
 *
 * 复制拷的是**选区原文**（`selection.toString()`，保留换行），不是引用用的规整版：
 * 引用要压空白、截上限是为了进 prompt，拷到别处的东西应该和用户看到的一样。
 * 复制后按钮原地变「已复制」、约一秒后收起，选区留着（用户可能还想再引用）。
 *
 * - 只认**单条消息内**的选区（起止落在同一个 `[data-quote-id]` 块里）：跨消息的一段
 *   说不清出处，跳不回去。
 * - 监听挂在 document 上、判断时再看是不是本面板：首页没有转录容器，挂在转录根上的话
 *   从首页进聊天页之后监听就不在了。主槽与抽屉各自只认落在自己面板里的选区。
 * - 按下浮层时 preventDefault，选区不丢；在别处按下、滚动都收起浮层。
 */
function QuoteSelectionLayer(props: {
  paneRef: React.RefObject<HTMLDivElement | null>;
  transcript: readonly TranscriptItem[];
  /** 缺席 = 「引用」键不出现（输入框不可用：只读 / 没配模型 / 子会话面板） */
  onQuote?: (quote: TextQuote) => void;
  /** 缺席 = 「摘抄」键不出现（首页等没有会话的地方）。raw 是选区原文 */
  onExcerpt?: (quote: TextQuote, raw: string) => Promise<"saved" | "duplicate">;
}) {
  const t = useT();
  /** 摘抄的短暂相位：存的中途、存好、已经摘过、失败——各自停一拍再收起 */
  const [excerptPhase, setExcerptPhase] = useState<"saving" | "saved" | "duplicate" | "failed" | null>(null);
  const [candidate, setCandidate] = useState<{
    quote: TextQuote;
    /** 选区原文（复制用，保留换行；quote.text 是规整过的） */
    raw: string;
    x: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const transcriptRef = useRef(props.transcript);
  transcriptRef.current = props.transcript;
  const { paneRef } = props;

  useEffect(() => {
    let timer: number | undefined;
    const capture = (): void => {
      const pane = paneRef.current;
      const selection = window.getSelection();
      if (pane === null || selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
        setCandidate(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const blockOf = (node: Node): HTMLElement | null =>
        (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>("[data-quote-id]") ?? null;
      const block = blockOf(range.startContainer);
      if (block === null || block !== blockOf(range.endContainer) || !pane.contains(block)) {
        setCandidate(null);
        return;
      }
      const role = block.dataset["quoteRole"] === "user" ? "user" : "assistant";
      const quote = quoteFromSelection(transcriptRef.current, block.dataset["quoteId"] ?? "", role, selection.toString());
      if (quote === null) {
        setCandidate(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setCopied(false);
      setExcerptPhase(null);
      setCandidate({ quote, raw: selection.toString(), x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
    };
    const schedule = (event: Event): void => {
      // 松手落在工具栏自己上（点复制 / 引用）不是一次新划选，不重新捕获：
      // 重捕获会把刚亮起的「已复制」在 60ms 后打回「复制」，1 秒收起也就永远等不到
      if (event.type === "pointerup" && event.target instanceof Element && event.target.closest("[data-quote-popover]") !== null) {
        return;
      }
      window.clearTimeout(timer);
      // 等浏览器把选区落定（双击选词、三击选段的 selection 在 pointerup 之后才定）
      timer = window.setTimeout(capture, 60);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.shiftKey || event.key.startsWith("Arrow")) schedule(event);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest("[data-quote-popover]") !== null) return;
      setCandidate(null);
    };
    const onScroll = (): void => setCandidate(null);
    document.addEventListener("pointerup", schedule);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerdown", onPointerDown, true);
    // 滚动不冒泡：捕获阶段才收得到转录容器的滚动
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [paneRef]);

  // 「已复制」停留约一秒后收起工具栏；选区不动（用户可能还想引用）
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => {
      setCopied(false);
      setCandidate(null);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // 摘抄的结果停一拍半再收起；成功（含已经摘过）连选区一起清掉，失败留着选区可以再点
  useEffect(() => {
    if (excerptPhase === null || excerptPhase === "saving") return;
    const timer = window.setTimeout(() => {
      if (excerptPhase !== "failed") {
        window.getSelection()?.removeAllRanges();
        setCandidate(null);
      }
      setExcerptPhase(null);
    }, 1400);
    return () => window.clearTimeout(timer);
  }, [excerptPhase]);

  if (candidate === null) return null;
  const { onQuote, onExcerpt } = props;
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
            () => setCandidate(null),
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
            window.getSelection()?.removeAllRanges();
            setCandidate(null);
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

/**
 * 会话区的 skill 索引：read SKILL.md 的行要标成「在用 skill」就靠它认 slug。
 * 挂载读一次、失败静默——徽标是锦上添花，不为它报错，也不为它做重读 UI
 * （新建的 skill 下一轮会话自然出现）。
 */
function useSkillIndex(): {
  skills: SkillMeta[];
} {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const reload = useCallback(() => {
    void api.skill.list().then(setSkills).catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { skills };
}

/*
 * 右栏选取回执与行内选用插入的消费水位（模块级）：只有主槽的 ChatView 拿
 * tokenPickResult / panelInsert，不会串合；但主槽会在设置页来回切时重挂——
 * 实例 ref 会归零，旧回执被重放、token 插两遍。水位放模块级，重挂也记得
 * 消费过哪一条。
 */
let consumedPickNonce = 0;
let consumedPanelInsertNonce = 0;

/** 主槽输入框（选取回执与行内选用的插入目标）：面板 / 抽屉里的 Composer 不算 */
const mainComposerTextarea = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(".pane-main textarea.composer-input");

function ChatViewBody(props: {
  /** 有文件正拖在这个面板上方：输入框亮起落点虚线（拖放本身由外层 ChatView 接） */
  dropActive?: boolean;
  session: ChatSession;
  providersError?: string | null;
  /**
   * 极简首页：只出输入卡，不出 slogan 与会话卡。右抽屉里「还没发过第一句话」的
   * 新任务用它——欢迎界面是主会话的仪式，辅助对话要的是直接开写（wafo 2026-09-12）。
   */
  homeBare?: boolean;
  /** 星标（收藏）的模型。**不是会话元数据**——它跟着用户走，存在设置里 */
  starredModels?: readonly ModelPair[];
  onToggleStarModel?: (pair: ModelPair) => void;
  /**
   * 模型卡片底部「配置模型」的去处（设置面的服务商页）。不传时那行仍然在，
   * 点了只是把卡片关上——比给一个点了没反应的东西好。
   */
  onOpenProviders?: () => void;
  /**
   * 点主流里的派出卡 / 子会话问询胶囊 → 打开右栏 Sub-sessions 面板并直接进入这条
   * 子会话的会话层（子会话 PR4c）。只有主槽的 ChatView 拿到它——辅助对话抽屉与
   * Sub-sessions 面板自己内部渲染的 ChatView（查看子会话）都不传，派出卡保持不可点，
   * 也符合「UI 只做一层」：面板里查看的子会话不再嵌一层它自己的 Sub-sessions 入口。
   */
  onOpenSubSession?: (childId: string) => void;
  /**
   * 解析后的主题：只给首页门面用（纸面两档的 slogan 与批语，HomeHero.tsx）。
   * 只有主槽的 ChatView 拿到它；辅助对话是 homeBare，本来就不出门面。
   */
  theme?: Exclude<ThemePreference, "system">;
  /**
   * 确认卡「在辅助对话打开」：来源会话在右抽屉打开（主槽不动）。只有主槽拿到它。
   */
  onOpenSideChat?: (sessionId: string) => void;
  /** 本机存在的会话 id 集：确认卡渲染时就判定「打开」能不能点（主槽才有） */
  intentOpenableIds?: ReadonlySet<string>;
  /**
   * 右栏 Sub-sessions 面板会话层正开着的子会话 id（子会话 PR4c）：派出卡按它描边。
   * 只有主槽的 ChatView 拿到非 null 值。
   */
  litSubSessionId?: string | null;
  /**
   * 不渲染输入框与排队条（子会话 PR4c）：Sub-sessions 面板的会话层用它——那里是
   * 只读查看 + 审批，不给用户直接对子会话说话的入口（说话走 Open as main）。
   * 审批条不受影响，照常渲染——用户必须能在这里直接批子会话的工具调用。
   */
  hideComposer?: boolean;
  /**
   * 轮尾卡 / 界碑卡的「在面板里看」：打开右侧审查面板并定位该文件。
   * 只有主槽的 ChatView 拿到它（面板开在主槽旁边）；右栏与抽屉里不传，行不可点。
   */
  onOpenReviewAt?: (path: string) => void;
  /**
   * 摘抄跳回原文的一次性请求（审查面板 › 摘抄页签发起，token 单调递增，同 reviewFocus）：
   * 外层 ChatView 消费——本会话直接滚，切过来的会话等转录加载到那一轮再滚。
   * 只有主槽的 ChatView 拿到它。
   */
  excerptJump?: ExcerptJumpRequest | null;
  /** 摘下一条之后（让审查面板的摘抄页签重拉）。只有主槽的 ChatView 拿到它 */
  onExcerptSaved?: () => void;
  /**
   * 召回终态卡的「在右栏看图谱」：打开右栏意图面板。只有主槽拿到它（面板开在
   * 主槽旁边）；右栏与抽屉里不传，终态卡不画这个链接。
   */
  onOpenIntentPanel?: () => void;
  /**
   * 对话里记忆行的「在审查面板里看」：打开右栏审查面板的记忆页签。只有主槽拿到它；
   * 右栏与抽屉里不传，记忆行照常显示、只是没有这个链接。
   */
  onOpenMemoryReview?: () => void;
  /**
   * 用量环菜单里的「查看上下文」：打开右栏上下文面板。只有主槽拿到它（面板开在主槽
   * 旁边）；右栏与抽屉里的会话区不传，菜单不出这一项。
   */
  onOpenContextPanel?: () => void;
  /**
   * 一键回底浮钮（feat/scroll-to-bottom-X）：距底超过 300px 时在消息列底端浮现「回底」
   * 浮钮，点击 smooth 滚到底。三个会话区都开：主槽、辅助对话抽屉、Sub-sessions 面板的
   * 会话层——都有长转录、都会滚离底部。实现在本组件里三处共用。
   */
  scrollToEnd?: boolean;
  /**
   * End 键跳底的全局接管（feat/scroll-to-bottom-X）。**只有主槽给 true**：主槽常驻，
   * 右栏面板（辅助对话 / 子会话）可能同时开着，两处都挂 window keydown 会把一次
   * End 变成同时滚两个面——面板的回底走浮钮，不抢全局键。
   */
  scrollToEndHotkey?: boolean;
  /**
   * 「/ + 空格」打开右栏选取（panel-token.ts）：行首或空白后孤立的 / 按下空格时
   * （句中同样触发，2026-10-11 用户裁定）交出插入锚点。**只有主槽的 ChatView
   * 拿到它**（App 在那边接住去开面板）；抽屉 / 面板内的 Composer 不参与，
   * 那边的 / 空格就是普通文字。
   */
  onSlashSpace?: (position: number) => boolean;
  /**
   * 右栏选取的一次性回执（nonce 单调递增，同 channelOpenRequest 的先例）：token
   * 非空 = 插到 position（execCommand 保撤销栈）；null = 取消，只把焦点送回输入框。
   * 只有主槽的 ChatView 拿到它。
   */
  tokenPickResult?: TokenPickResult | null;
  /**
   * 右栏行内「选用」按钮的一次性插入请求（nonce 单调递增，同 tokenPickResult 的
   * 先例）：token 插到输入框**当前光标处**（从未聚焦过则落到草稿末尾），焦点回
   * 输入框。面板不关——浏览态可以连插几条。只有主槽的 ChatView 拿到它。
   */
  panelInsert?: PanelInsertRequest | null;
  /** 意图系统（实验功能）：新会话的召回默认（settings.intent.newSessionOn 已解缺省）。
   *  可选：副槽（抽屉 / 子会话面板）不传——那里不出开关 */
  intentNewSessionDefault?: boolean;
  /**
   * 主槽传 true：对话卡不再有页头（2026-10-19 方案 B v2，会话信息住工具栏的
   * 会话胶囊）；辅助对话抽屉不传，抽屉里的 ChatView 保留卡内标题行。
   */
  bareHeader?: boolean;
}) {
  const t = useT();
  const { session, providersError, homeBare, hideComposer } = props;
  // 意图系统（实验功能）：确认卡、输入框开关挂它后面；转录里的终态卡另在
  // TranscriptColumn 里判（历史记录照渲染，入口才藏）
  const intentOn = useExperimentalFeature("intent-system");
  // 会话级开关只在根会话上出现（子会话不召回，开存在主会话）；没有会话（新任务）
  // 也不出——首条消息按设置里的新会话默认建
  const intentToggleVisible = intentOn && session.opened !== null && session.opened.parentId === undefined;
  const intentToggleOn =
    session.intentEnabled ?? session.opened?.intentEnabled ?? (props.intentNewSessionDefault === true);
  // read SKILL.md 徽标的识别索引（徽标与工具行共用同一份数据）
  const { skills } = useSkillIndex();
  const jumpToQuote = useContext(QuoteJumpContext);

  // ── 右栏选取的回执：插入 token、焦点回输入框（panel-token.ts）────────
  useEffect(() => {
    const result = props.tokenPickResult;
    if (result == null || result.nonce <= consumedPickNonce) return;
    consumedPickNonce = result.nonce;
    if (result.token === null) {
      // 取消（Esc）：把触发时删掉的「/ 」还回原处。句中也会触发之后，「a / b」这类
      // 正文打出 / 加空格就开了面板——Esc 必须让它回到用户打的原样，不能吞字
      const anchor = result.position;
      requestAnimationFrame(() => {
        const el = mainComposerTextarea();
        const position = Math.max(0, Math.min(anchor, session.draft.length));
        const restored = session.draft.slice(0, position) + "/ " + session.draft.slice(position);
        if (el === null) {
          session.setDraft(restored);
          return;
        }
        el.focus();
        el.setSelectionRange(position, position);
        if (!document.execCommand("insertText", false, "/ ")) session.setDraft(restored);
      });
      return;
    }
    const token = result.token;
    const anchor = result.position;
    requestAnimationFrame(() => {
      const el = mainComposerTextarea();
      const position = Math.max(0, Math.min(anchor, session.draft.length));
      const next = insertToken(session.draft, position, token);
      // execCommand("insertText") 保撤销栈：input 事件会把最终值送回 onChange →
      // draft 自动同步；输入框不在（设置页盖着）或被拒（只读）就退回直接写
      if (el === null) {
        session.setDraft(next.value);
        return;
      }
      el.focus();
      el.setSelectionRange(position, position);
      if (!document.execCommand("insertText", false, next.text)) session.setDraft(next.value);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tokenPickResult]);

  // ── 行内「选用」按钮的插入：token 落到输入框当前光标处（panel-token.ts）──
  // 光标从 DOM 读（失焦后 selectionStart 仍停在最后一次的位置）；「从未聚焦过」
  // 的判定在 panelInsertPosition（纯函数，有测试）
  useEffect(() => {
    const request = props.panelInsert;
    if (request == null || request.nonce <= consumedPanelInsertNonce) return;
    consumedPanelInsertNonce = request.nonce;
    requestAnimationFrame(() => {
      const el = mainComposerTextarea();
      const position = panelInsertPosition(el === null ? 0 : el.selectionStart, session.draft.length);
      const next = insertToken(session.draft, position, request.token);
      // 同选取回执：execCommand 保撤销栈，被拒 / 不在就退回直接写
      if (el === null) {
        session.setDraft(next.value);
        return;
      }
      el.focus();
      el.setSelectionRange(position, position);
      if (!document.execCommand("insertText", false, next.text)) session.setDraft(next.value);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.panelInsert]);

  // 跟随态（pi 的 followingEnd 语义）：贴底时内容增长钉住底部；用户上滚脱离，滚回底部恢复。
  // 用 ref 不用 state——没有 UI 依赖它，不值得为每次滚动触发重渲染。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 收尾卡上的型号名：与模型菜单同一套显示名（声明名 > 白名单 > 目录名 > id）
  const wrapupModelName = useCallback(
    (modelId: string): string => {
      const declared = session.usable.flatMap((p) => p.models.declared).find((m) => m.id === modelId);
      return modelDisplayName(session.catalog, modelId, {}, declared?.name);
    },
    [session.usable, session.catalog],
  );
  // 收尾卡「第 x–y 轮」：跳回那一轮的用户消息并闪一下。不在已加载的窗口里就往前翻页再找
  // （每页 SESSION_PAGE_RECORDS 条，最多翻 20 页——再远的历史不值得一直等）
  const hasMoreRef = useRef(session.hasMoreHistory);
  hasMoreRef.current = session.hasMoreHistory;
  const loadOlderRef = useRef(session.loadOlder);
  loadOlderRef.current = session.loadOlder;
  const jumpToMessage = useCallback((messageId: string) => {
    let tries = 0;
    const attempt = () => {
      const pane = scrollRef.current;
      if (pane === null) return;
      if (pane.querySelector(`[data-quote-id="${CSS.escape(messageId)}"]`) !== null) {
        highlightQuote(pane, messageId, "");
        return;
      }
      if (!hasMoreRef.current || tries >= 20) return;
      tries += 1;
      loadOlderRef.current();
      window.setTimeout(attempt, 400);
    };
    attempt();
  }, []);
  const followRef = useRef(true);
  /**
   * 触顶拉更早一页那一刻的滚动几何（源侧分页的滚动锚定）：
   * pages = 当时的并入页数（回执后它变了就说明真并进来了一页）。
   */
  const olderAnchorRef = useRef<{ pages: number; scrollHeight: number; scrollTop: number } | null>(null);

  // 一键回底（feat/scroll-to-bottom-X）：距底超过 300px 浮出按钮。用 state——按钮显隐
  // 是渲染输出，与 followRef 的「无 UI 依赖」不同。重算挂两处：滚动事件管用户滚动，
  // 每个 commit 后再算一次——流式长高不改 scrollTop，不触发 scroll 事件，只靠
  // onScroll 会在「脱离着看流式输出」时漏掉该浮出的按钮。
  // ponytail: 窗口 resize 不重算显隐（无滚动无 commit 时短暂 stale，下一次 commit
  // 自愈）；要精确就挂 ResizeObserver。
  const [showScrollToEnd, setShowScrollToEnd] = useState(false);
  const syncScrollToEnd = () => {
    const el = scrollRef.current;
    if (el === null) return;
    setShowScrollToEnd(isBeyondScrollDown(el.scrollHeight - el.scrollTop - el.clientHeight));
  };

  /** 用户滚动（滚轮/键盘/滚动条都一样）后重判是否在底部；程序化钉底触发的事件判真，不打架 */
  const handleScroll = () => {
    const el = scrollRef.current;
    if (el !== null) {
      followRef.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    }
    syncScrollToEnd();
    // 触顶就拉更早的一页（源侧分页）。**先记滚动几何再发请求**：回执并进窗口后
    // 靠它把 scrollTop 补回来（见下面的锚定 effect）。守卫在这里做——`loadOlder`
    // 自己也会 no-op，但锚点不能为一个没发出去的请求留着（那会把下一次真拉回来的
    // 页错锚到旧几何上）。
    if (
      el !== null &&
      session.hasMoreHistory &&
      !session.loadingOlder &&
      shouldLoadOlder(el.scrollTop)
    ) {
      olderAnchorRef.current = {
        pages: session.olderPages,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      session.loadOlder();
    }
  };

  // 滚动锚定（源侧分页）：更早的一页 prepend 之后，把 scrollTop 补上新旧 scrollHeight
  // 之差——前面插进来多高，视口就往下走多远，用户视角纹丝不动。绘制前同步执行
  // （useLayoutEffect），不会闪一下再跳。**声明在这支之前**：用户已经回到底部时
  // 交给下面那支钉底，不拿旧几何再补一次。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = olderAnchorRef.current;
    if (el === null || anchor === null) return;
    if (session.olderPages === anchor.pages) {
      // 请求落定但窗口没动（空页 / 失败）：锚点作废，不留到下一次
      if (!session.loadingOlder) olderAnchorRef.current = null;
      return;
    }
    olderAnchorRef.current = null;
    if (followRef.current) return;
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
  });

  // 每次 commit 后钉底：不挑触发源——流式输出、忙碌指示出现、折叠展开全兜住；scrollTop 赋值廉价。
  // 绘制前同步执行，用户看不到先长高再滚下去的闪动。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
    syncScrollToEnd();
  });

  /** 这一屏是哪条会话：活着的优先，否则是打开的那条 */
  const openId = session.sessionId ?? session.opened?.id ?? "";
  // 记忆（实验功能 memory-system）：记住了东西的那条用户消息下挂「记忆 · 记住 M 条」行。
  // 账本按轮记，这里按时间把轮配到气泡上（不按计数，见 pairMemoryTurns）
  const memoryOn = useExperimentalFeature("memory-system");
  const memorySession = useMemorySession(memoryOn && openId !== "" ? openId : null);
  const memoryLines = useMemo((): MemoryLines | null => {
    const view = memorySession.data;
    if (view === null) return null;
    const users = session.transcript.flatMap((item) => (item.role === "user" ? [{ id: item.id, timestamp: item.timestamp }] : []));
    // 随回退停用的条目不挂在对话里（重说的那一轮与被撤回的同轮号，见 liveRemembered）
    const rows = new Map([...pairMemoryTurns(users, view)].map(([id, row]) => [id, liveRemembered(row)]));
    return { rows };
  }, [memorySession.data, session.transcript]);
  // 回退 / 撤销的预演对象：TranscriptColumn 是 memo，按原始值记忆，不每帧新建对象
  const previewMessageId = session.revertDialog?.targetMessageId ?? null;
  const previewTurnId = session.undoDialog?.turnId ?? null;
  const revertPreview = useMemo<RevertPreview>(
    () =>
      previewMessageId !== null
        ? { kind: "revert", messageId: previewMessageId }
        : previewTurnId !== null
          ? { kind: "undo", turnId: previewTurnId }
          : null,
    [previewMessageId, previewTurnId],
  );

  // —— R5-05 首发过渡：slogan 与会话卡 220ms 向上淡出，composer 240ms 滑向窗口底部。
  // leaving 由事件处理器（发送 / 点会话卡）同步置位，首页保持挂载走完动画再让位；
  // 目的地没就绪（create / load 慢于动画）就宁可不动画，硬切也不闪回。
  const [travel, setTravel] = useState<"none" | "leaving" | "prep" | "entering">("none");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const chattedRef = useRef(false);
  const homeActive = session.sessionId === null && session.opened === null;

  /** 滑落距离：composer 现位到窗口底部（聊天页 footer 的大致位置）。外层量——prep 拍里它自己带着 transform。 */
  const measureTravel = () => {
    const el = stageRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--travel-dy", `${Math.max(0, window.innerHeight - rect.bottom - 32)}px`);
  };

  const startLeave = () => {
    if (travel === "leaving" || travel === "prep") return;
    measureTravel();
    setTravel("leaving");
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setTravel("none"), 260);
  };

  // 回场（New task / 发送失败回家）：反方向走一遍。**首启不算「回来」**，不做动画
  useEffect(() => {
    if (!homeActive) {
      chattedRef.current = true;
      return;
    }
    if (!chattedRef.current) return;
    setTravel("prep");
    const raf = requestAnimationFrame(() => {
      measureTravel();
      requestAnimationFrame(() => setTravel("entering"));
    });
    const timer = window.setTimeout(() => setTravel("none"), 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeActive]);

  // 打开/切换会话无条件跳到底并恢复跟随：后台会话的事件一直进自己的槽，切回时转录已是最新
  useLayoutEffect(() => {
    followRef.current = true;
    // 换会话即作废分页锚点：在途回执并的是**旧会话**的窗口，拿它去补新会话的
    // scrollTop 就是错位（锚点里存的是旧会话的 scrollHeight）
    olderAnchorRef.current = null;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
    syncScrollToEnd();
  }, [openId]);

  // 一键回底：smooth 滚到底（reduced-motion 瞬时）。到达后滚动事件把跟随带回来
  // （handleScroll 判贴底即恢复），不用在这里另管 followRef。
  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }, []);

  // End 键跳底：只在主槽接管全局键（scrollToEndHotkey 只主槽给——右栏面板可能同开，
  // 两处都挂会一次滚两个面）；焦点在文本框里时不接管（composer 里 End 是行尾光标），
  // 判定在 shouldJumpToEnd。
  useEffect(() => {
    if (props.scrollToEndHotkey !== true) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const takeover = shouldJumpToEnd(
        event.key,
        { ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey },
        { tagName: target.tagName, isContentEditable: target.isContentEditable },
      );
      if (!takeover) return;
      event.preventDefault();
      scrollToEnd();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props.scrollToEndHotkey, scrollToEnd]);

  // 首页会话卡：有 open 遗留事项的会话优先占卡，剩余槽位按「最近活跃」补齐；
  // 选卡与截断规则在 home-cards.ts 纯函数（测试覆盖），这里只接线。
  // **必须在首页分支之外无条件调用**——hook 不能长在条件分支里，首页让位给聊天页时
  // hooks 数量一变 React 直接卸载整棵树（灰屏）。纯函数毫秒级，恒算不亏。
  const homeCards = useMemo(
    () => selectHomeCards(session.sessions, session.carryovers),
    [session.sessions, session.carryovers],
  );

  // 头部完成入口读当前状态：列表里的 meta 与 opened 都是真的（refreshSessions 双向同步），
  // 列表优先——活会话首条消息刚落盘时它先到
  const openMeta = session.sessions.find((m) => m.id === openId) ?? session.opened;

  // 子会话 PR4a：标记行 / 派出卡的上下文，**必须在首页分支之外无条件建**（同
  // homeCards 上面那条纪律——下面都是 hook，首页让位给聊天页时 hooks 数量一变
  // React 直接卸载整棵树）。ownSide 由被查看会话的 meta 有没有 parentId 定；
  // titles 是 id → 标题的稳定 Map（按 session.sessions 建，只有列表真的变化才
  // 重建）；channelSummaries 把这条会话当父去拉通道摘要——没有子会话时它恒是
  // 空 Map，派出卡也就没有消费者。**channel 对象本身也必须 useMemo**：
  // TranscriptColumn 是 memo 组件，散装对象每次渲染都新建会直接打穿它。
  const ownSide: "parent" | "child" = openMeta?.parentId !== undefined ? "child" : "parent";
  const ownParentId = openMeta?.parentId ?? null;
  const titles = useMemo(
    () => new Map(session.sessions.map((meta) => [meta.id, meta.title])),
    [session.sessions],
  );
  const channelSummaries = useChannelSummaries(openId === "" ? null : openId);
  // 子会话 PR4c：派出卡 / 问询胶囊的点击入口——只有主槽的根会话视图接得上
  // （onOpenSubSession 由 App 给），辅助对话抽屉与面板内查看的子会话都接不上，
  // 不可点。
  const openSubSession = ownSide === "parent" ? (props.onOpenSubSession ?? null) : null;
  const litSubSessionId = props.litSubSessionId ?? null;
  // 通道正文的两个来源（2026-10-12 沟通回对话流）：
  //   - 子会话视图：拉**自己那条父子通道**的全文——任务 / 回复 / 叫停的气泡正文都在
  //     这里；key 为 null 时 `useChannelMessages` 内部短路成空态，不发请求。
  //   - 根会话视图：拉**全部子通道**的合并——问询胶囊按 messageId 取正文首行。
  // 两个 hook 都在分支外无条件调用（首页让位给聊天页时 hooks 数量不变）。
  const ownChildren = ownSide === "parent" && openId !== "" ? childSessions(session.sessions, openId) : [];
  const taskChannelKey =
    ownSide === "child" && ownParentId !== null && openId !== "" ? { parentId: ownParentId, childId: openId } : null;
  const taskChannel = useChannelMessages(taskChannelKey);
  const parentChannels = useParentChannels(
    ownSide === "parent" && openId !== "" ? openId : null,
    ownChildren.map((meta) => meta.id),
  );
  const channelMessages = useMemo(() => {
    if (ownSide === "child") return new Map(taskChannel.messages.map((message) => [message.id, message]));
    const merged = new Map<string, ChannelMessage>();
    for (const messages of parentChannels.values()) {
      for (const message of messages) merged.set(message.id, message);
    }
    return merged;
  }, [ownSide, taskChannel.messages, parentChannels]);
  // 加载 / 错误态跟各自的那仨定：只有气泡（子侧）用得到，父流胶囊没有正文也退化为只报名字
  const channelLoading = ownSide === "child" ? taskChannel.loading : false;
  const channelError = ownSide === "child" ? taskChannel.error : null;
  const channel = useMemo<ChannelViewContext>(
    () => ({
      ownSide,
      ownParentId,
      titles,
      channelSummaries,
      childPhaseOf: session.phaseOf,
      openSubSession,
      litSubSessionId,
      channelMessages,
      channelMessagesLoading: channelLoading,
      channelMessagesError: channelError,
    }),
    [
      ownSide,
      ownParentId,
      titles,
      channelSummaries,
      session.phaseOf,
      openSubSession,
      litSubSessionId,
      channelMessages,
      channelLoading,
      channelError,
    ],
  );

  /**
   * 头部次要芯片「N sub-sessions · M waiting」（子会话 PR4c，2.2）：只在
   * `ownSide` 为 "parent" 且这条根会话确有子会话时才有内容——与派出卡同一条
   * 「子会话没有自己的子会话（今天）」的现状一致。waiting 计通道状态 waiting
   * 的子会话数；为 0 时芯片只显示前半（不拼出 "· 0 waiting"）。点击调用方按
   * `onOpenSubSessions` 是否给了决定是否可点，同 `ChannelMarkPill` 的门槛。
   */

  const composer = (
    <Composer
      value={session.draft}
      onChange={session.setDraft}
      // 发送即恢复跟随：翻着历史发消息，新对话永远长在底部。
      // 首页发送时同步起离场动画（R8-01 ③：首条消息提交才 createAgent）
      onSubmit={() => {
        followRef.current = true;
        if (homeActive) startLeave();
        session.send();
      }}
      onStop={session.stop}
      // 按「是不是首页」分，不按 sessionId：从侧栏打开的历史会话 sessionId 还是 null
      // （agent 要等发第一条才起），只有 opened 有值——按 sessionId 判会给它首页那句
      // 有引用时提示按编号逐条回复——编号就是 chip 上的角标，也是模型看到的 index。
      // 收尾扫描中：扫描轮不设超时，唯一出口是这张卡上的停止键（空草稿 + 在跑 = 发送键变停止），
      // 占位里直接说出来（审核 S-4）
      placeholder={
        session.closingScan
          ? t.chat.placeholderScanning
          : session.quotes.length > 0
          ? t.quote.replyPlaceholder(session.quotes.length)
          : homeActive
            ? t.chat.placeholderNew
            : t.chat.placeholderReply
      }
      disabled={session.usable.length === 0 || session.readOnly}
      running={session.phase !== "idle"}
      bottomSlot={
        <ComposerBar
          session={session}
          // 用量环浮层里的「标记完成」：与头部完成入口同一道门（已落盘 + 未完成；会话生命周期已转正，
          // 不再看实验开关），同一条收尾仪式
          markDone={
            openId !== "" && (openMeta?.completion ?? "open") === "open"
              ? { onSelect: session.startClosingRitual, busy: session.phase !== "idle" || session.closingScan }
              : null
          }
          starredModels={props.starredModels ?? []}
          onToggleStarModel={props.onToggleStarModel ?? (() => {})}
          onOpenProviders={props.onOpenProviders ?? (() => {})}
          onOpenContext={props.onOpenContextPanel ?? null}
          intentToggle={
            intentToggleVisible
              ? { on: intentToggleOn, onToggle: session.setIntentEnabled }
              : null
          }
        />
      }
      dropActive={props.dropActive === true}
      quotes={session.quotes}
      onRemoveQuote={session.removeQuote}
      jumpToQuote={jumpToQuote}
      attachments={session.attachments}
      onAttach={session.attachIncoming}
      onRemoveAttachment={session.removeAttachment}
      onPickFolders={session.attachFolderRefs}
      files={session.files}
      pasted={session.pasted}
      onRemoveFile={session.removeFile}
      onAddPasteBlock={session.addPasteBlock}
      onExpandPaste={session.expandPaste}
      onCollapsePaste={session.collapsePaste}
      imageUnsupported={!selectedModelAcceptsImage(session.usable, session.catalog, session.model)}
      onSlashSpace={props.onSlashSpace}
    />
  );

  const notices = (
    <>
      {providersError != null ? (
        // 加载失败 ≠ 没有 provider：原因说清楚，去设置面重试（打开设置会重新拉取）
        <Notice tone="bad">{t.chat.providersFailed(providersError)}</Notice>
      ) : (
        session.usable.length === 0 && (
          <Notice
            icon="info"
            exit={props.onOpenProviders === undefined ? undefined : { label: t.chat.noProviderExit, onClick: props.onOpenProviders }}
          >
            {t.chat.noProvider}
          </Notice>
        )
      )}
      {session.error !== null && <Notice tone="bad">{session.error}</Notice>}
      {/*
        收尾仪式的降级 / 结果反馈：一句中性的话，不当错误报。
        读不懂扫描结果时这行带一个 Retry（重发同一条扫描消息）——失败不该只留一句
        「已标完成」就无路可走。
      */}
      {session.scanNotice !== null && (
        <Notice exit={session.retryClosingScan === null ? undefined : { label: t.common.retry, onClick: session.retryClosingScan }}>
          {session.scanNotice}
        </Notice>
      )}
      {/*
        只能读不能续：pi 没有这条会话的本子。**说清楚，别让输入框看起来能打字**
        （guideline §四把这条代价写明了）。
      */}
      {session.readOnly && (
        <Notice icon="lock">{t.chat.readOnlyTask}</Notice>
      )}
    </>
  );

  // 首页 = 既没有活着的会话，也没有打开任何一条旧会话。
  // leaving 期间保持首页挂载（homeActive 已翻 false 也一样），动画走完再让位给聊天页
  if (homeActive || travel === "leaving") {
    // 极简首页（右抽屉里还没发话的新任务）：slogan 与会话卡都不出现，
    // notices + 输入卡贴底——辅助对话要的是直接开写，不是仪式（wafo 2026-09-12：输入卡在下）
    if (homeBare) {
      return (
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            // 底距与聊天页 footer 同为 10px——两边输入卡的下沿齐平（wafo 2026-09-12）
            padding: "var(--space-5) var(--space-5) 10px",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "min(100%, var(--content-max-width))",
              display: "grid",
              gap: "var(--space-2)",
            }}
          >
            {notices}
            {composer}
          </div>
        </div>
      );
    }
    // 行位换成遗留标题（最多 4 行）；遗留事项直接吃引擎缓存（PR-4 的 carryoverList
    // 通道，写操作自动刷新），卡不另建缓存、meta 不冗余计数。
    // 点击：卡与行都进该会话（openSession）——滚动定位到 sourceMessageRange 的基建
    // 还未立项（PR-4 面板同款 TODO），落定后行点击可升级为定位，卡保持进会话
    return (
      <div
        className="home-stage"
        data-leaving={travel === "leaving" ? "true" : undefined}
        data-travel={travel === "prep" || travel === "entering" ? travel : undefined}
        style={{
          position: "relative",
          // pane 是 flex 行，首页根是它的子项——不撑满的话内容列会收缩靠左，
          // 看起来像被右侧的抽屉挤过去（2026-09-12）
          flex: 1,
          minWidth: 0,
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-5)",
          overflow: "hidden",
        }}
      >
        <div
          ref={stageRef}
          style={{
            position: "relative",
            zIndex: 1,
            width: "min(100%, var(--content-max-width))",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--space-5)",
          }}
        >
          {/* 淡出组：slogan 与会话卡一起向上走（--transition-layer，220ms） */}
          <div
            className="home-fade"
            style={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--space-5)",
            }}
          >
            {/* 门面：slogan（纸面两档再加红笔批语），样子与理由在 HomeHero.tsx */}
            <HomeHero theme={props.theme} />
            {/* 一排最近会话卡（SessionCard 规格：恒三槽、等高、hover 只抬阴影） */}
            {!session.sessionsLoaded ? (
              <div style={{ width: "100%", display: "flex", gap: "var(--space-3)" }}>
                {[0, 1, 2].map((index) => (
                  <SessionCard key={index} name="" loading />
                ))}
              </div>
            ) : (
              homeCards.length > 0 && (
                <div style={{ width: "100%", display: "flex", gap: "var(--space-3)" }}>
                  {homeCards.map((card) => (
                    <SessionCard
                      key={card.sessionId}
                      name={card.title}
                      items={card.rows.map((row) => ({
                        // 图标与遗留事项面板的跳转按钮同款（corner-down-left）：
                        // 这行的动作就是「跳到那条会话」，视觉语言一致
                        icon: row.kind === "carryover" ? ("corner-down-left" as const) : undefined,
                        text: row.text,
                      }))}
                      slots={card.todo ? HOME_CARD_CARRYOVER_ROWS : HOME_CARD_QUERY_ROWS}
                      state={(() => {
                        const meta = session.sessions.find((m) => m.id === card.sessionId);
                        return meta === undefined ? null : runStateOf(session, meta);
                      })()}
                      onClick={() => {
                        startLeave();
                        session.openSession(card.sessionId);
                      }}
                    />
                  ))}
                </div>
              )
            )}
          </div>
          {/* 滑落组：notices 与 composer 一起滑向窗口底部（--transition-composer-exit，240ms） */}
          <div
            className="home-travel"
            style={{ width: "100%", display: "grid", gap: "var(--space-2)" }}
          >
            {notices}
            {composer}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Pane
        title={session.opened?.title || (sessionTitle(session.transcript) ?? t.common.newTask)}
        badge={openId.slice(0, 6)}
        badgeTitle={openId}
        scrollRef={scrollRef}
        onScroll={handleScroll}
        scrollToEnd={props.scrollToEnd === true ? { visible: showScrollToEnd, onClick: scrollToEnd } : null}
        // 只要这条会话已经落盘就能标记完成——与改名同一条门槛，只读会话同样可用。
        completion={
          openId !== "" ? (openMeta?.completion ?? "open") : null
        }
        onSetCompletion={
          openId !== ""
            ? (next) => session.setCompletionSession(openId, next)
            : undefined
        }
        // open 态点击走收尾仪式（降级矩阵在 hook）；Reopen 仍走 onSetCompletion
        onMarkDone={openId !== "" ? session.startClosingRitual : undefined}
        closing={session.closingScan}
        busy={session.phase !== "idle"}
        scanless={openMeta?.piSessionFile == null}
        // 只要这条会话已经落盘就能改名——刚发完第一句正是最想改名的时候
        onRename={openId === "" ? undefined : (title) => session.renameSession(openId, title)}
        hideHeader={props.bareHeader === true}
        footer={
          <>
            {notices}
            {/* 回退 / 撤销的预演确认栏：与审批条、收尾清单同位同配方（就地，不遮消息流） */}
            {session.revertDialog !== null && (
              <RevertPreviewBar
                mode="revert"
                plan={session.revertDialog.plan}
                cwd={session.cwd}
                busy={session.revertBusy}
                onConfirm={session.confirmRevert}
                onCancel={session.cancelRevert}
                onOpenFile={props.onOpenReviewAt}
              />
            )}
            {session.undoDialog !== null && (
              <RevertPreviewBar
                mode="undo"
                plan={session.undoDialog.plan}
                cwd={session.cwd}
                busy={session.undoBusy}
                onConfirm={session.confirmUndo}
                onCancel={session.cancelUndo}
                onOpenFile={props.onOpenReviewAt}
              />
            )}
            {session.approvals[0] && (
              <ApprovalBar approval={session.approvals[0]} onAnswer={session.answerApproval} />
            )}
            {/* 回答前确认（实验功能 intent-system）：与审批条同位同配方——比聊天面高
                一层、要求一个回答才继续，但不霸屏、不抢焦点、不藏输入框。草稿不跨
                刷新（实验功能：内存态即可，重弹重选） */}
            {intentOn && session.intentAsk !== null && (
              <IntentConfirmCard
                ask={session.intentAsk.ask}
                requestId={session.intentAsk.requestId}
                sessionId={session.intentAsk.sessionId}
                turnId={session.intentAsk.turnId}
                draft={null}
                onDraftChange={() => {}}
                onAnswer={session.answerIntentConfirm}
                onOpenSideChat={props.onOpenSideChat}
                openableSessionIds={props.intentOpenableIds}
              />
            )}
            {/* 收尾确认卡：inline 浮层，与审批条同位同配方；只在查看发起会话时显示
                （scanResult 由 hook 查看槽持有，切走再切回还在） */}
            {session.scanResult !== null && session.scanResult.sessionId === openId && (
              <WrapupCard
                // 每次扫描是一张新卡：换一份清单就重挂，卡内的编辑状态不串到下一次
                key={`${session.scanResult.sessionId}:${session.scanResult.plan.lastTurn}:${session.scanResult.plan.sinceTurn}`}
                plan={session.scanResult.plan}
                draft={session.scanResult.draft}
                nameOf={wrapupModelName}
                onConfirm={session.confirmCarryovers}
                onCancel={session.cancelCarryovers}
                onRevise={session.reviseWrapup}
                onJumpTurn={jumpToMessage}
              />
            )}
            {/*
              子会话 PR4c：Sub-sessions 面板的会话层不给输入框——那里是只读查看 +
              审批（上面 ApprovalBar 不受影响，照常渲染）。排队条跟着composer一起
              藏：排队是「等发出的下一句话」，没有输入框就没有下一句话可排。
            */}
            {hideComposer !== true && (
              <>
                {/* 排队卡片：比 composer 高一层（等待发出的事），比审批低一层（审批要求回答才继续） */}
                <QueueStrip
                  items={session.queued}
                  phase={session.phase}
                  onSendNow={session.sendQueuedNow}
                  onWithdraw={session.withdrawQueued}
                  onMove={session.moveQueuedTo}
                  titles={channel.titles}
                />
                {composer}
              </>
            )}
          </>
        }
      >
        <RevertPreviewContext.Provider value={revertPreview}>
        <TranscriptColumn
          preview={revertPreview}
          transcript={session.transcript}
          compactions={session.compactions}
          marks={session.marks}
          phase={session.phase}
          retry={session.retry}
          turnError={session.turnError}
          loadingHistory={session.loadingHistory}
          loadingOlder={session.loadingOlder}
          onBranch={session.branchFrom}
          onOpenTask={session.openSession}
          channel={channel}
          skills={skills}
          intentRecalls={session.intentRecalls}
          intentRun={session.intentRun}
          onAbort={session.stop}
          pendingEcho={session.pendingEcho}
          fileTurns={session.fileTurns}
          reverts={session.reverts}
          undos={session.undos}
          cwd={session.cwd}
          onUndoTurn={session.undoTurn}
          onRevertTo={session.revertToMessage}
          actionsBusy={session.phase !== "idle" || session.queued.length > 0 || revertPreview !== null}
          readOnly={session.readOnly}
          onOpenReviewAt={props.onOpenReviewAt}
          onOpenIntentPanel={props.onOpenIntentPanel}
          memory={memoryLines}
          onOpenMemoryReview={props.onOpenMemoryReview}
          sessionId={openId}
        />
        </RevertPreviewContext.Provider>
      </Pane>
    </>
  );
}

/**
 * 转录列（memo 隔离）：往来流与它的一切派生（摊平 / 分组 / 折叠 / 分支锚点）只吃
 * 这几个 props。隔离的理由是可感的点击延迟（2026-09-10）：草稿每个字、排队卡每次
 * 乐观更新都会让 useChatSession 重渲染，此前整列几百行单元跟着全部重新对账一遍，
 * 流式期间主线程被逐帧渲染占满，点击反馈排不上队。transcript 引用在 hook 侧
 * 已按 entry 稳定化——闲时（打字 / 排队操作）memo 命中，整列跳过；流式期间它
 * 逐帧变化，列照旧逐帧重渲染，活体的实时性不变。
 */
const TranscriptColumn = memo(function TranscriptColumn(props: {
  /** 回退 / 撤销预演：回退时切点之后的往来变淡加删除线；撤销时那一轮的轮尾卡描边 */
  preview: RevertPreview;
  transcript: readonly TranscriptItem[];
  compactions: readonly CompactedRecord[];
  /** 子会话 PR4a：盘上读回的通道标记，与 compactions 同一条纪律（见 mergeSideRecords） */
  marks: readonly ChannelMarkRecord[];
  phase: "idle" | "turn" | "compaction";
  retry: RetryStatus | null;
  turnError: string | null;
  loadingHistory: boolean;
  /** 更早的一页在途（源侧分页触顶）：列首出一行次级灰提示 */
  loadingOlder: boolean;
  onBranch: (anchorItemId: string) => void;
  /** B-1：read_task 的「Open」——引用稳定（openSession 只依赖 engine），不破 memo */
  onOpenTask: (sessionId: string) => void;
  /**
   * 子会话 PR4a：channelMark 标记行与 delegate / reply_subsession / report_to_parent
   * 工具行要用的一切。**必须引用稳定**（ChatView 用 useMemo 建）——这层是 memo，
   * 每次渲染新建对象会打穿它（同 onOpenTask 的纪律）。
   */
  channel: ChannelViewContext;
  /** skill 索引（read SKILL.md 徽标用）；挂载读一次，引用稳定不打穿 memo */
  skills: SkillMeta[];
  /** 轮尾文件账（fileTurn 事件 + 盘上种子），与 marks 同一条纪律 */
  fileTurns: readonly FileTurnView[];
  /** 回退界碑（盘上种子；回退后重读会话自然进来） */
  reverts: readonly RevertRecord[];
  /** 撤销记录（盘上种子）：轮尾卡的「已撤销」徽标按它点亮 */
  undos: readonly UndoRecord[];
  /** 会话 cwd：轮尾卡的路径显示（cwd 内相对、外绝对） */
  cwd: string | null;
  /** 单轮撤销入口（轮尾卡的 Undo）；引用稳定，不破 memo */
  onUndoTurn: (turnId: string) => void;
  /** 回退入口（user 气泡的「回到这里」）：开确认框的回调 */
  onRevertTo: (messageId: string) => void;
  /** 运行中 / 排队非空：回退与撤销的入口全禁 */
  actionsBusy: boolean;
  /** 只读（无 pi 本子）：回退 / 撤销不可用——没有可裁的本子 */
  readOnly: boolean;
  /** 轮尾卡文件行的「在面板里看」（主槽才有；引用稳定） */
  onOpenReviewAt?: (path: string) => void;
  /** 召回终态卡的「在右栏看图谱」（主槽才有；引用稳定，不破 memo） */
  onOpenIntentPanel?: () => void;
  /** 记忆行（实验功能 memory-system）：用户气泡 id → 那一轮的账；null = 关着 / 没数据 */
  memory: MemoryLines | null;
  /** 记忆行的「在审查面板里看」（主槽才有） */
  onOpenMemoryReview?: () => void;
  /** 产物打开按钮的会话对账 */
  sessionId: string;
  /** 意图召回（实验功能 intent-system）：终态卡（按时间插回流）与运行中卡（转录末尾） */
  intentRecalls: readonly IntentRecallRecord[];
  intentRun: RecallCardState | null;
  /** 停止当前轮（= 取消召回）。引用稳定，不破 memo */
  onAbort: () => void;
  /** 乐观回显：发出即画的用户气泡（真回显事件一到即清）。ephemeral */
  pendingEcho: { blocks: readonly string[] } | null;
}) {
  const t = useT();
  // 意图系统开关：关着时终态记录照渲染（历史还在），运行卡与入口全藏
  const intentOn = useExperimentalFeature("intent-system");
  const { transcript } = props;
  // 派生链按引用记忆：没变的部分不重复对账（phase / retry / turnError 槽变化时只补差额）
  const toolResults = useMemo(() => indexToolResults(transcript), [transcript]);
  // 界碑、通道标记、轮尾账与回退界碑按发生位置插回往来流：压缩摘要收进「已压缩」
  // 折叠行、通道标记画成一行虚线标记、轮尾账是卡片、回退界碑是标记行 + 还原卡
  const records = useMemo(
    () =>
      mergeSideRecords(
        props.compactions,
        props.marks,
        props.fileTurns,
        props.reverts,
        props.undos,
        transcript,
        props.intentRecalls,
      ),
    [props.compactions, props.marks, props.fileTurns, props.reverts, props.undos, transcript, props.intentRecalls],
  );
  // 被撤销的轮 id 集：轮尾卡据此挂「已撤销」徽标（undo 记录不是渲染单元）
  const undoneTurnIds = useMemo(
    () =>
      new Set(
        records.filter((record) => record.role === "undo").map((record) => record.turnId),
      ),
    [records],
  );
  // 摊平 → 相邻同类合并：渲染从「按条」改成「按单元」，连续同类工具收成一行组
  const units = useMemo(() => flattenRenderUnits(records), [records]);
  const entries = useMemo(() => groupToolUnits(units, props.skills), [units, props.skills]);
  // 流式中的 assistant 记录 id 集：这些消息的 text 块渲染时传 streaming——
  // 流式帧省掉公式排版与代码高亮（stream-render.ts），落定帧再补渲
  const streamingIds = useMemo(
    () =>
      new Set(
        records
          .filter((record) => record.role === "assistant" && record.status === "streaming")
          .map((record) => record.id),
      ),
    [records],
  );
  // 组行的展开是时间态：活跃轮里铺开，整轮落定一次性收纳（见 ToolGroupLine）
  const turnActive = props.phase === "turn";
  // 已中断的工具调用（interruptedToolCallIds）：结果永远不会来的调用按静止的
  // 「已中断」渲染，不再呼吸/转圈——委派卡「委派中…」停不下来就是这类（2026-10-09）
  const interruptedCalls = useMemo(
    () => interruptedToolCallIds(records, toolResults, turnActive),
    [records, toolResults, turnActive],
  );
  // 过程显示（设置 › 过程显示）：一轮一行 = groupTurnsByTurn（旁白收进块、活跃轮成现场块）；
  // 逐步铺开 = groupTurns（落定轮按旁白收成几条 Worked，活跃轮原样铺开）
  const processView = useContext(ProcessViewContext);
  const turnView = useMemo(
    () =>
      processView === "turn"
        ? groupTurnsByTurn(entries, turnActive, toolResults)
        : groupTurns(entries, turnActive, toolResults),
    [entries, turnActive, toolResults, processView],
  );
  // 现场块在场且后面没有正文在流时，它自己就是「在干活」的那一行——底下的 Responding 不再重复
  const liveBlockShown = turnView.some((entry) => entry.kind === "turnProcess" && entry.live && !entry.answering);
  // 流式中的思考块（行首呼吸的判定）：本轮未结束且它是流式 assistant 消息的最后一块
  const activeThinkingKey = useMemo(
    () => streamingThinkingKey(records, turnActive),
    [records, turnActive],
  );
  // 分支锚点（C-2）：每轮最终完整输出的最后一个单元后面挂一条分支按钮行；
  // 本轮还在跑（turnActive）时末尾候选不确认——复制/分支行等回答结束再出现；速度不在此列：
  // 实时速度本就在 Responding 行（估算，每秒一跳），这里整行藏着的是落定后的 BranchRow
  // （复制 + 分支 + 随记录落盘的真值速度）。有工具还在跑时分支按钮全部禁用（历史锚点
  // 同）——它的结果没齐，此刻切出去的上下文是畸形的。锚点算在**大折叠视图**上：锚点的
  // 正文永远在折叠外面，按钮跟着正文走。
  const branchRows = useMemo(
    () => branchAnchorEntries(branchAnchorIds(records, toolResults, turnActive), turnView),
    [records, toolResults, turnActive, turnView],
  );
  const toolsRunning = useMemo(
    () => transcript.some((item) => item.role === "tool" && item.status === "running"),
    [transcript],
  );
  // 收尾扫描回复卡片化：落定的 assistant 消息若整条恰好是一个可解析的 fenced
  // json 块（扫描回答的 prompt 契约形状），用只读展示卡替代 markdown 渲染——
  // 原始 json 占屏是噪音（2026-09-22 用户反馈）。streaming 中保持普通流式渲染，
  // 落定后自然翻转为卡片。判定按整条消息的全部 text 块拼接（与 collectScanAnswer
  // 同口径：围栏可能被拆在多个 text 块里）；命中后多个 text 单元只在第一个的位置
  // 渲染一次卡片，其余跳过——整条消息已进卡。消息里命中与 user 关闭无关，
  // 挂在 records 上（扫描历史会话的旧回答同样卡片化）。
  const carryoverCards = useMemo(() => {
    const cards = new Map<string, { scan: ScanMessage; firstKey: string }>();
    for (const record of records) {
      if (record.role !== "assistant" || record.status === "streaming") continue;
      let firstKey: string | null = null;
      const parts: string[] = [];
      record.content.forEach((block, index) => {
        if (block.type !== "text") return;
        if (firstKey === null) firstKey = `${record.id}:${index}`;
        parts.push(block.text);
      });
      if (firstKey === null) continue;
      const scan = matchScanMessage(parts.join(""));
      if (scan !== null) cards.set(record.id, { scan, firstKey });
    }
    return cards;
  }, [records]);
  // 回合级失败（网络中断 / 重试耗尽）的红 triangle 只挂**失败那轮**的折叠（见 failedFoldKey）；
  // 那轮没折叠就不挂，红字自带的图标是全部。
  // 工具类失败不配图标（各自的红色 failed 计数已经跟在工具后面）。
  // 局部名叫 failedFold：failedFoldKey 是 turn-rollup 里的函数，不能重名遮蔽。
  const failedFold = props.turnError !== null ? failedFoldKey(turnView) : null;
  // 回退预演的切点：要撤回的那条用户消息在视图里的位置（-1 = 没在预演 / 不在视图里）
  const previewMessageId = props.preview?.kind === "revert" ? props.preview.messageId : null;
  const cutIndex = useMemo(
    () =>
      previewMessageId === null
        ? -1
        : turnView.findIndex((entry) => entry.kind === "user" && entry.item.id === previewMessageId),
    [previewMessageId, turnView],
  );
  const cutRef = useRef<HTMLDivElement | null>(null);
  // 「这条任务 › 进度」点一章：对话滚到那个过程块并闪一下（面板与对话不共享状态，走一次性事件）
  useEffect(() => {
    const onReveal = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      const target = document.querySelector(`[data-entry-key="${CSS.escape(key)}"]`);
      if (!(target instanceof HTMLElement)) return;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.remove("entry-revealed");
      void target.offsetWidth;
      target.classList.add("entry-revealed");
    };
    window.addEventListener(REVEAL_ENTRY_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_ENTRY_EVENT, onReveal);
  }, []);
  useEffect(() => {
    if (cutIndex >= 0) cutRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cutIndex]);

  return (
    <>
      {/* 历史恢复在途：一行安静的加载指示，正文区不再是一片无解释的空白 */}
      {props.loadingHistory && entries.length === 0 && <StatusLine spin>{t.common.loading}</StatusLine>}
      {/* 触顶拉更早的一页：列首一行次级灰（设计系统的 caption 惯例）。import 耗尽了就不出现 */}
      {props.loadingOlder && <StatusLine spin>{t.chat.loadingOlder}</StatusLine>}
      {/* 空会话（没发过消息）：一行 tertiary 交代「这里为什么是空的」 */}
      {entries.length === 0 &&
        !props.loadingHistory &&
        props.phase === "idle" &&
        props.turnError === null && (
          <StatusLine>{t.chat.noMessages}</StatusLine>
        )}
      {turnView.map((entry, index) => {
        const branchAfter = branchRows.get(index);
        // 复制与速度都按锚点所在的**整轮**取：轮内可能有多条 assistant 记录（每次 toolCall 切一条）
        const turnRecords = branchAfter !== undefined ? turnAssistantRecords(records, branchAfter) : [];
        // 相邻 show_image 合并成一个画廊（2026-09-27 裁决）：首张渲染合并画廊，后续
        // 兄弟渲染 null（数据数组不动，branchRows 索引不乱）；失败的 show_image 不进
        // 合并——照通用红色骨架。判「组首」：自己是 show_image 且前一个不是
        const isShowCall =
          entry.kind === "toolCall" && entry.toolName === "show_image" && toolResults.get(entry.toolCallId)?.status !== "error";
        const prevEntry = index > 0 ? turnView[index - 1] : undefined;
        const prevIsShowCall =
          prevEntry !== undefined &&
          prevEntry.kind === "toolCall" &&
          prevEntry.toolName === "show_image" &&
          toolResults.get(prevEntry.toolCallId)?.status !== "error";
        if (isShowCall) {
          if (prevIsShowCall) return null; // 已被前面的组吸收
          const cards: ShowImageCardView[] = [];
          for (let scan = index; scan < turnView.length; scan++) {
            const candidate = turnView[scan];
            if (
              candidate === undefined ||
              candidate.kind !== "toolCall" ||
              candidate.toolName !== "show_image"
            ) {
              break;
            }
            const card = showImageCard(toolResults.get(candidate.toolCallId));
            if (card === null) break;
            cards.push(card);
          }
          return (
            <Fragment key={entry.key}>
              {index === cutIndex && (
                <div ref={cutRef} className="revert-cut">
                  <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
                  {t.chat.previewCut}
                </div>
              )}
              <div className={cutIndex >= 0 && index >= cutIndex ? "revert-doomed" : "revert-keep"}>
              <ShowImageGalleryGroup cards={cards} />
              {branchAfter !== undefined && (
                <BranchRow
                  /* 挂点照常渲染：被吸收的 entry 只把主行换 null，分支行各归各 */
                  anchorItemId={branchAfter}
                  speed={replySpeed(turnRecords)}
                  copyText={answerText(turnRecords)}
                  disabled={toolsRunning}
                  onBranch={props.onBranch}
                />
              )}
              </div>
            </Fragment>
          );
        }
        const doomed = cutIndex >= 0 && index >= cutIndex;
        return (
          <Fragment key={entry.key}>
            {index === cutIndex && (
              <div ref={cutRef} className="revert-cut">
                <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
                {t.chat.previewCut}
              </div>
            )}
            <div className={doomed ? "revert-doomed" : "revert-keep"} data-entry-key={entry.key}>
            {entry.kind === "turnProcess" ? (
              <TurnProcessLine
                unit={entry}
                toolResults={toolResults}
                turnFailed={entry.key === failedFold}
                skills={props.skills}
                interruptedCalls={interruptedCalls}
                renderStep={(step) => (
                  <EntryView
                    key={step.key}
                    entry={step}
                    toolResults={toolResults}
                    activeThinkingKey={null}
                    turnActive={false}
                    interruptedCalls={interruptedCalls}
                    onOpenTask={props.onOpenTask}
                    carryoverCards={carryoverCards}
                    channel={props.channel}
                    skills={props.skills}
                    cwd={props.cwd}
                    undoneTurnIds={undoneTurnIds}
                    onUndoTurn={props.onUndoTurn}
                    actionsBusy={props.actionsBusy}
                    onOpenReviewAt={props.onOpenReviewAt}
                    onOpenIntentPanel={props.onOpenIntentPanel}
                    sessionId={props.sessionId}
                    onRevertTo={props.onRevertTo}
                    streamingIds={streamingIds}
                  />
                )}
              />
            ) : entry.kind === "turnGroup" ? (
              <TurnRollupLine
                group={entry}
                toolResults={toolResults}
                turnFailed={entry.key === failedFold}
                onOpenTask={props.onOpenTask}
                carryoverCards={carryoverCards}
                channel={props.channel}
                skills={props.skills}
                cwd={props.cwd}
                undoneTurnIds={undoneTurnIds}
                onUndoTurn={props.onUndoTurn}
                actionsBusy={props.actionsBusy}
                onOpenReviewAt={props.onOpenReviewAt}
                sessionId={props.sessionId}
                interruptedCalls={interruptedCalls}
              />
            ) : (
              <EntryView
                entry={entry}
                toolResults={toolResults}
                activeThinkingKey={activeThinkingKey}
                turnActive={turnActive}
                interruptedCalls={interruptedCalls}
                onOpenTask={props.onOpenTask}
                carryoverCards={carryoverCards}
                channel={props.channel}
                skills={props.skills}
                cwd={props.cwd}
                undoneTurnIds={undoneTurnIds}
                onUndoTurn={props.onUndoTurn}
                actionsBusy={props.actionsBusy}
                onOpenReviewAt={props.onOpenReviewAt}
                onOpenIntentPanel={props.onOpenIntentPanel}
                sessionId={props.sessionId}
                onRevertTo={props.onRevertTo}
                streamingIds={streamingIds}
                memory={props.memory}
                onOpenMemoryReview={props.onOpenMemoryReview}
              />
            )}
            {branchAfter !== undefined && (
              <BranchRow
                anchorItemId={branchAfter}
                speed={replySpeed(turnRecords)}
                copyText={answerText(turnRecords)}
                disabled={toolsRunning}
                onBranch={props.onBranch}
              />
            )}
            </div>
          </Fragment>
        );
      })}
      {props.pendingEcho !== null && <PendingEchoRow blocks={props.pendingEcho.blocks} />}
      {/* 等确认态（done 且有待表态、终态记录还没落盘）也由运行卡画：环停 86%、
          确认胶囊换气泡图标——确认卡此刻浮在输入框上方，两处互为上下文 */}
      {props.intentRun !== null &&
        (props.intentRun.status === "running" ||
          (props.intentRun.status === "done" && props.intentRun.pendingAsks > 0)) && (
        <IntentRecallRunCard card={props.intentRun} onCancel={props.onAbort} />
      )}
      {props.turnError !== null && (
        /*
         * 回合失败标注（重试耗尽）：跟着失败的归属走——它追在谁后面，就贴着谁的
         * 对齐侧（用户消息居右、agent 消息居左，UserBubble 同款）。常见情形是模型
         * 调用重试耗尽、转录末尾正是那条没送出去的用户消息 → 居右；回答中途断掉
         * （末条是半截 assistant）→ 居左。新一轮开跑自动清除（槽里清）。
         */
        <div
          style={{
            display: "flex",
            width: "100%",
            justifyContent: transcript.at(-1)?.role === "user" ? "flex-end" : "flex-start",
          }}
        >
          <Notice tone="bad">{props.turnError}</Notice>
        </div>
      )}
      {props.phase === "turn" &&
        (props.retry !== null ? (
          <Retrying status={props.retry} />
        ) : liveBlockShown ? null : (
          <Responding transcript={transcript} />
        ))}
      {props.phase === "compaction" && (
        <>
          <Compacting />
          {props.retry !== null && (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Retrying status={props.retry} />
            </div>
          )}
        </>
      )}
    </>
  );
});

/**
 * 聊天面的骨架：页头 / 可滚动的内容列 / 底部。实时会话与历史会话共用它——
 * 两者只有底部不同（一个是输入卡，一个是「这条不能继续」的说明）。
 */
function Pane(props: {
  title: string;
  badge: string;
  badgeTitle: string;
  /** 当前会话的完成状态；null = 还没落盘（首条消息未发），完成入口不摆 */
  completion: SessionCompletion | null;
  /** 翻完成状态（Reopen 用）；没落盘时不传 */
  onSetCompletion?: ((next: SessionCompletion) => void) | undefined;
  /**
   * open 态点击「Mark task done」的回调——收尾仪式（注入扫描、弹清单），
   * 降级矩阵（在跑 / 只读 / 空对话）在 hook；不给则退回纯标记。
   */
  onMarkDone?: (() => void) | undefined;
  /** 收尾扫描进行中：按钮转圈 */
  closing?: boolean;
  /** 会话在跑：open 态的完成按钮禁用（收尾要等话说完） */
  busy?: boolean;
  /** 只读（没有 pi 本子）：纯标记路径，tooltip 说明为什么没有扫描 */
  scanless?: boolean;
  /** 有值才出现铅笔——首条消息还没发的会话还没有记录可改 */
  onRename?: ((title: string) => void) | undefined;
  /** 消息列的滚动容器：跟随/跳底逻辑在 ChatView，骨架只交出节点 */
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: (() => void) | undefined;
  /**
   * 一键回底浮钮（feat/scroll-to-bottom-X）：非 null 才挂（只有主槽给）——浮在消息列
   * 底端靠右、输入卡上方；visible 由 ChatView 按距底 300px 重算，点击回底。骨架只管
   * 摆位，判定在 ChatViewBody。
   */
  scrollToEnd?: { visible: boolean; onClick: () => void } | null;
  /**
   * 主槽传 true：不渲染卡内页头（2026-10-19 方案 B v2——会话信息住工具栏的会话
   * 胶囊，对话卡从工具栏下直接开始）；抽屉里的 ChatView 保留页头。
   */
  hideHeader?: boolean;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  // 消息列与输入卡同一根外线：滚动段占着滚动条宽、页脚没有，宽窗口里消息列在
  // 「面板宽 − 滚动条」里居中，比输入卡整体偏 半个滚动条（2026-10-30 实测 1800 宽：
  // 正文 523–1523、输入卡 528–1528）。量出滚动条的实际宽度（macOS 浮层滚动条是 0，
  // 常驻滚动条随系统设置变），页脚右内边距补同样多——两段的内容盒逐像素一致。
  // 滚动段同时 scrollbar-gutter: stable（styles.css 的 .chat-transcript），宽度
  // 不随「内容够不够滚」跳动
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const scroller = pane?.querySelector<HTMLElement>(".chat-transcript");
    if (pane === null || pane === undefined || scroller === null || scroller === undefined) return;
    const sync = (): void => {
      const style = getComputedStyle(scroller);
      const borders = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
      const bar = Math.max(0, scroller.offsetWidth - scroller.clientWidth - borders);
      pane.style.setProperty("--transcript-scrollbar", `${bar}px`);
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={paneRef}
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        // 行数随页头有无切换（2026-10-19 修复：主槽删页头后若仍是三行，滚动区会
        // 掉进第一行 auto、输入卡掉进第二行 1fr——composer 卡在半空、下方一片空白）
        gridTemplateRows:
          props.hideHeader === true ? "minmax(0,1fr) auto" : "auto minmax(0,1fr) auto",
      }}
    >
      {/* 抽屉里保留的卡内页头（主槽 hideHeader，2026-10-19 方案 B v2：会话信息住
          工具栏的会话胶囊）；窗口拖拽由顶部工具栏整条接管，这里只是内容行 */}
      {props.hideHeader !== true && (
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          height: 36,
          padding: "0 14px",
          boxSizing: "border-box",
          borderBottom: "1px solid var(--color-border-subtle)",
          flex: "0 0 auto",
        }}
      >
        <InlineName
          editing={editing}
          value={props.title}
          onCommit={(value) => {
            setEditing(false);
            props.onRename?.(value);
          }}
          onCancel={() => setEditing(false)}
          style={{ fontWeight: "var(--weight-bold)" }}
        >
          <strong
            style={{
              // 标题是头部唯一允许收缩的元素：主槽变窄时先吃掉标题的空间，铅笔/
              // 完成入口/子会话芯片/id 徽标一律 flex-shrink:0，不给它们让路
              // （子会话 PR4c fix：三者原先没有一个显式声明谁该先缩，窄到极致时
              // 会挤到互相覆盖）。**只收缩不伸长**：flex-grow 给 0（不是 1）——
              // 给 1 会在宽槽下把标题撑满剩余空间，铅笔/完成入口被推到最右，
              // 与标题之间空出一大截（CDP 复验发现的回归，原来紧挨着的观感变了）。
              flex: "0 1 auto",
              minWidth: 0,
              fontWeight: "var(--weight-bold)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {props.title}
          </strong>
        </InlineName>
        {/* 铅笔夹在名字与 id 之间：它属于名字，不属于这条会话的其它动作 */}
        {props.onRename !== undefined && !editing && (
          <IconButton
            label={t.chat.renameTask}
            size="var(--titlebar-control)"
            onClick={() => setEditing(true)}
          >
            <Icon name="pencil-line" size={13} />
          </IconButton>
        )}
        {/**
          完成入口（第二处，与侧栏菜单同源）：open → Mark done（收尾仪式），非 open → Reopen。
          降级矩阵在这里只做展示：扫描中转圈、在跑禁用、只读（无 pi 本子）在 tooltip
          里说明是纯标记——真正的判定在 useChatSession.startClosingRitual。
        */}
        {props.completion !== null && props.onSetCompletion !== undefined && (
          <IconButton
            size="var(--titlebar-control)"
            label={
              props.completion === "open"
                ? props.closing === true
                  ? t.chat.scanningLabel
                  : t.chat.markTaskDone
                : t.chat.reopenTask
            }
            title={
              props.completion === "open"
                ? props.closing === true
                  ? t.chat.scanningTip
                  : props.busy === true
                    ? t.chat.waitBeforeDone
                    : props.scanless === true
                      ? t.chat.doneScanlessTip
                      : t.chat.doneTip
                : t.chat.reopenTip
            }
            disabled={props.completion === "open" && (props.closing === true || props.busy === true)}
            onClick={() =>
              props.completion === "open"
                ? (props.onMarkDone ?? (() => props.onSetCompletion?.("done")))()
                : props.onSetCompletion?.("open")
            }
          >
            <Icon
              name={
                props.completion === "open"
                  ? props.closing === true
                    ? "loader-circle"
                    : "check"
                  : "rotate-ccw"
              }
              size={13}
              spin={props.closing === true}
            />
          </IconButton>
        )}
        <span
          title={props.badgeTitle}
          style={{
            flex: "0 0 auto",
            padding: "2px 8px",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-muted)",
            color: "var(--color-text-secondary)",
            fontFamily: "var(--font-family-business)",
            fontSize: "var(--font-size-xs)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          {props.badge}
        </span>
      </header>
      )}

      {/* 滚动段套一层定位容器：回底浮钮要浮在这段的底缘上，而不是随内容滚走。
          样式在 styles.css 的 .chat-scroll-seg（含 overflow: hidden——页脚很高时滚动段不越界盖到页脚下） */}
      <div className="chat-scroll-seg">
        <div
          ref={props.scrollRef}
          onScroll={props.onScroll}
          className="scroll chat-transcript"
          style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}
        >
          <div
            style={{
              width: "min(100%, var(--content-max-width))",
              margin: "0 auto",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-4)",
            }}
          >
            {props.children}
          </div>
        </div>
        {/* 一键回底浮钮（feat/scroll-to-bottom-X）：盖一层 pointer-events:none 的定位层，
            内衬与消息列同宽同边距的列、按钮靠右缘——对齐的是消息列而不是面板边。
            只盖按钮自身可点，正文照常选中/点击。 */}
        {props.scrollToEnd?.visible === true && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 1,
              pointerEvents: "none",
              padding: "0 var(--space-5)",
              display: "flex",
              alignItems: "flex-end",
            }}
          >
            <div
              style={{
                width: "min(100%, var(--content-max-width))",
                margin: "0 auto",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <IconButton
                label={t.chat.scrollToBottom}
                title={t.chat.scrollToBottom}
                size={30}
                className="scroll-end-float"
                style={{
                  pointerEvents: "auto",
                  marginBottom: 10,
                  borderRadius: "var(--radius-pill)",
                }}
                onClick={props.scrollToEnd.onClick}
              >
                <Icon name="arrow-down" size={15} />
              </IconButton>
            </div>
          </div>
        )}
      </div>

      <div className="chat-footer">
        <div
          style={{
            width: "min(100%, var(--content-max-width))",
            margin: "0 auto",
            display: "grid",
            gap: "var(--space-2)",
          }}
        >
          {props.footer}
        </div>
      </div>
    </div>
  );
}

function SubSessionsChip(props: { chip: { count: number; waiting: number }; onClick?: () => void }) {
  const t = useT();
  const { count, waiting } = props.chip;
  // N=1 用单数（子会话 PR4c fix：CDP 实测发现 "1 sub-sessions" 读着不对）——单复数在文案表里
  const noun = t.chat.subSessionCount(count);
  const text = waiting > 0 ? `${noun} · ${t.chat.subSessionWaiting(waiting)}` : noun;
  const style: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    // flex-shrink:1 + minWidth:0（不是 0 0 auto）：主槽变窄到标题已经缩没了还不够时，
    // 这个芯片的文字自己 ellipsis，不会顶着 id 徽标（flex-shrink:0）互相覆盖
    // （子会话 PR4c fix，CDP 实测发现的重叠）
    flex: "0 1 auto",
    minWidth: 0,
    maxWidth: 200,
    border: 0,
    background: "transparent",
    padding: 0,
    font: "inherit",
    fontSize: "var(--font-size-sm)",
    color: waiting > 0 ? "var(--color-warning)" : "var(--color-text-tertiary)",
    ...(props.onClick !== undefined ? { cursor: "pointer" } : {}),
  };
  const content = (
    <>
      <Icon name="git-fork" size={12} strokeWidth={1.8} style={{ flex: "0 0 auto" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {text}
      </span>
    </>
  );
  if (props.onClick === undefined) return <span style={style}>{content}</span>;
  return (
    <button type="button" onClick={props.onClick} title={t.chat.openSubSessions} style={style}>
      {content}
    </button>
  );
}

/**
 * 输入卡底栏：作用域 / 权限档 / 模型——都是「这一句会以什么身份发出去」的事实。
 *
 * 三个都是菜单而不是并排的芯片：权限档摊开是三个、模型摊开是所有 provider 的所有模型，
 * 288px 之外的这条底栏放不下，摊开也把「当前是什么」淹没在选项里。
 * 菜单里当前项用 check 标出来——**状态优先图标与文字**。
 */
function ComposerBar(props: {
  session: ChatSession;
  /** 星标过的模型（设置里那份）：行的星与左栏第一格都看它 */
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
  /** 卡片底部「配置模型」→ 设置面的服务商页 */
  onOpenProviders: () => void;
  /** 意图召回的会话级开关（实验功能）：null = 不渲染（实验关 / 子会话 / 新任务） */
  intentToggle: { on: boolean; onToggle: (next: boolean) => void } | null;
  /** 用量环浮层里的「标记完成」（见 UsageRing）；null = 不给 */
  markDone: { onSelect: () => void; busy: boolean } | null;
  /** 用量环浮层里的「查看上下文」；null = 不给（非主槽） */
  onOpenContext: (() => void) | null;
}) {
  const t = useT();
  const { session } = props;
  const workspace = session.workspaces.find((w) => w.id === session.workspaceId);
  // 工作区名**原样**显示（「名字 == 路径」的老数据在 store 读时已治愈，wafo 裁决——
  // 显示层不截尾，用户起的 `PhD/Year1` 不会再被截成 `Year1`）；没选工作区时落在
  // cwd，那才是真路径，显示目录尾段
  const scope =
    workspace !== undefined
      ? workspace.name
      : session.cwd === null
        ? t.chat.home
        : deriveWorkspaceName(session.cwd) || t.chat.home;
  // 命名新建工作区：scope 芯片**原位**换成输入框（InlineName）——就在用户点开的
  // 地方接着打字，视线不跳去侧栏；窄窗侧栏折成图标条时这里照样能用
  const [namingWorkspace, setNamingWorkspace] = useState(false);

  // pi 内建目录：模型项的 ctx 徽标要从这里查官方参数（与设置页同一套口径）。
  // 一个 app 一次 fetch——引擎已经拉过一份，这里不再自己起第二次
  const catalog = session.catalog;

  const scopeItems: MenuItem[] = [
    {
      id: "home",
      label: t.chat.home,
      icon: "folder",
      // 路径副行（mono 注脚）：主行报名字，副行说它在哪。路径的**尾段才是名字**
      // （/Users/dama/Desktop/orbita → orbita），所以从头部省略，别把唯一有信息量的那段切掉
      subLabel: session.defaultCwd,
      subLabelMono: true,
      subLabelEllipsis: "head",
      checked: session.workspaceId === null && session.cwd === null,
      onSelect: session.newTask,
    },
    ...session.workspaces.map((item): MenuItem => ({
      id: item.id,
      // 名字原样（读时已治）；全路径放副行消歧（两个同名的工作区），与 home 项的 defaultCwd 同构
      label: item.name,
      subLabel: item.path,
      subLabelMono: true,
      subLabelEllipsis: "head" as const,
      icon: "folder" as const,
      checked: session.workspaceId === item.id,
      onSelect: () => session.newTaskIn(item),
    })),
  ];

  // 菜单卡片只有词，不带描述——与思考档菜单同一口径（描述是悬停在芯片上的事，
  // 展开卡片里一行行小字只会让它显得吵；宽度也因此能固定）
  const modeItems: MenuItem[] = PERMISSION_MODES.map((value): MenuItem => ({
    id: value,
    label: t.permissionModes[value].label,
    checked: session.mode === value,
    onSelect: () => session.changeMode(value),
  }));

  // 按厂商分组的模型菜单（与设置面的命名模型同一份构造）
  // 模型卡片的行（两行：模型名 + 厂商）与左栏（全部 / 各厂商）。
  // 设置面那份「按厂商分组」的构造还在用，两边的参数口径（ctx 徽标、当前项）同源。
  /**
   * 宽度尺：**不过滤**的那一份（与上面同一套构造，只把 scope 换成「全部」）。
   * 卡片按它定宽，所以左栏怎么筛宽、高、位置都不动。
   */

  // 思考档菜单按模型真实支持集显示（官方档位表：glm-5.3 只有 low/high/max，
  // claude 按型号——fable 系关不掉思考、opus-4-6 没有 xhigh——写死档位只会递增假选项）。来源三级
  // （modelThinkingLevels，与 useChatSession 的新任务槽起档共用同一份判定）：
  // 白名单 > 开轮事件回的真值（含 clamp 事实）> 目录（BuiltinModel，agent 进程在
  // pi 旁算好过线）。都没有 = 未知：按全量显示、不禁用，开轮后由 thinking 事件
  // 纠真——宁可待验证，不先撒谎
  const thinkingSupported =
    session.model === null
      ? null
      : modelThinkingLevels(
          session.model.modelId,
          catalog,
          session.thinkingSupported,
          modelPreferenceById(session.usable, session.model.providerId),
          declaredThinkingLevels(session.usable, session.model.providerId, session.model.modelId),
        );
  const thinkingMenuLevels = thinkingSupported ?? THINKING_LEVELS;
  // 逐档判断，不是全局锁：glm-5.3 支持 low/high/max（不含 minimal），全局判
  // 「不含 minimal」会把整个菜单错锁成全灰——那是 reasoning:false 模型（支持集
  // 真只有 off）才有的形状。不支持的档单独禁用并说明，可用的照常可选
  const thinkingItems: MenuItem[] = thinkingMenuLevels.map((value): MenuItem => {
    const unavailable = thinkingSupported !== null && !thinkingSupported.includes(value);
    return {
      id: value,
      label: t.thinkingLevel(value, session.model?.modelId),
      checked: session.thinkingLevel === value,
      disabled: unavailable,
      onSelect: () => session.changeThinkingLevel(value),
    };
  });

  return (
    <>
      {/*
        底栏芯片的菜单一律 placement="above"：首页里输入卡悬在窗口中间，默认
        「哪边空往哪开」会往下方弹（还会同一排芯片朝向不一）；聊天页钉底又全朝上。
        点名朝上，两边同一朝向（2026-10-03 用户定）
      */}
      <Menu
        items={scopeItems}
        placement="above"
        // 卡片：高不超过 520（视口不够时 placeMenu 会再封一道），宽随最长的那条路径自适应，
        // 上限夹进视口——以前是固定 320 的菜单，长路径被截成光秃秃一节
        panelMaxHeight={520}
        panelMaxWidth={640}
        // 「去哪」与「往清单里加东西」是两件事：动作收进底栏，发卡线分隔（同模型卡片的「配置模型」）
        footer={(close) => (
          <>
            <button
              type="button"
              className="option-row"
              style={menuFooterRowStyle}
              onClick={() => {
                close();
                setNamingWorkspace(true);
              }}
            >
              <Icon name="plus" size={13} strokeWidth={1.8} />
              <span>{t.sidebar.newWorkspace}</span>
            </button>
            <button
              type="button"
              className="option-row"
              style={menuFooterRowStyle}
              onClick={() => {
                close();
                session.addWorkspace();
              }}
            >
              <Icon name="folder-plus" size={13} strokeWidth={1.8} />
              <span>{t.sidebar.addFolder}</span>
            </button>
          </>
        )}
        trigger={({ open, toggle }) =>
          namingWorkspace ? (
            // 定宽：trigger 的锚 span 是 shrink-to-fit，width:100% 会塌——
            // 与相邻芯片同一量级（scope 芯片 icon + 名字 + chevron ≈ 140px）
            <InlineName
              editing
              value=""
              placeholder={t.sidebar.workspaceName}
              onCommit={(name) => {
                setNamingWorkspace(false);
                const trimmed = name.trim();
                if (trimmed !== "") session.createWorkspace(trimmed);
              }}
              onCancel={() => setNamingWorkspace(false)}
              style={{ width: 140 }}
            />
          ) : (
            <Chip
              icon="folder"
              active={open}
              title={t.chat.scopeTip(session.cwd ?? session.defaultCwd)}
              onClick={toggle}
              chevron
              // 窄槽下只留图标（styles.css 的 .composer-bottom-bar 容器查询）
              className="chip-scope"
            >
              {scope}
            </Chip>
          )
        }
      />
      <Menu
        items={modeItems}
        placement="above"
        panelMinWidth={112}
        trigger={({ open, toggle }) => (
          <Chip
            icon="shield-check"
            active={open}
            fixedWidth={84}
            title={t.permissionModes[session.mode].hint}
            onClick={toggle}
            chevron
            // 窄槽下只留图标，fixedWidth 也在同一断点被覆盖掉（见 styles.css）
            className="chip-mode"
          >
            {t.permissionModes[session.mode].label}
          </Chip>
        )}
      />
      {props.intentToggle !== null && (
        <Chip
          icon="waypoints"
          active={props.intentToggle.on}
          title={props.intentToggle.on ? t.composer.intentToggleOnHint : t.composer.intentToggleOffHint}
          onClick={() => props.intentToggle?.onToggle(!props.intentToggle.on)}
          className="chip-intent"
        >
          {t.composer.intentToggle}
        </Chip>
      )}
      {session.usable.length > 0 && (
        <ModelPickerMenu
          t={t}
          providers={session.usable}
          catalog={catalog}
          selected={session.model}
          starred={props.starredModels}
          onToggleStar={props.onToggleStarModel}
          onSelect={(providerId, modelId) => session.chooseModel(providerId, modelId)}
          placement="above"
          // 底部固定行：卡片会筛掉没配 key 的厂商，这行是唯一能说清「别家不是不存在」的地方
          footer={(close) =>
            modelCardFooter({
              t,
              onConfigure: () => {
                close();
                props.onOpenProviders();
              },
            })
          }
          trigger={({ open, toggle }) => {
            // 头像 + 显示名（不带服务商名）；服务商与 id 进悬停提示
            const parts = session.model === null ? null : modelChipParts(session.usable, catalog, session.model);
            return (
              <Chip
                active={open}
                title={parts === null ? t.chat.modelTip : `${parts.name} · ${parts.detail}\n${t.chat.modelTip}`}
                onClick={toggle}
                chevron
                leading={parts?.avatar}
                // 名字随时可省略号截断（styles.css），不等断点
                className="chip-model"
              >
                {parts?.name ?? t.chat.noModel}
              </Chip>
            );
          }}
        />
      )}
      <Menu
        items={thinkingItems}
        placement="above"
        panelMinWidth={112}
        trigger={({ open, toggle }) => (
          <Chip
            active={open}
            fixedWidth={84}
            title={
              thinkingSupported !== null && thinkingSupported.every((level) => level === "off")
                ? t.chat.thinkingOffTip
                : t.chat.thinkingTip
            }
            onClick={toggle}
            chevron
          >
            {t.thinkingLevel(session.thinkingLevel, session.model?.modelId)}
          </Chip>
        )}
      />
      <UsageRing session={session} markDone={props.markDone} onOpenContext={props.onOpenContext} />
    </>
  );
}

/**
 * 底栏最右侧的用量环（A-1）。它顶替了 `18.2k / 200k · $0.06` 那行字——
 * 文字每次都要读，环扫一眼就够，省下的宽度留给别的芯片。
 *
 * **悬停即开分项菜单**（`hoverOpen`），不用点；分项走我们自己画的菜单行，
 * **不用原生 `title`**——原生 tooltip 的字体/字号/颜色由系统决定，改不了，
 * 而且它会在悬停约 1 秒后再弹一次，与菜单重复（wafo 2026-09-03 报的两次悬停）。
 *
 * 菜单底下挂「Compact context now」（A2-Q1 裁决：菜单项与 `/compact` 都要）。
 * 压缩只在闲着时给：pi 的 `compact()` 会先打断当前这一轮——跑着时让人点得动，
 * 他以为只是整理一下，实际把回答砍了。**禁用的理由写在 hint 里**，不让它只是变灰。
 */
function UsageRing(props: {
  session: ChatSession;
  /**
   * 「标记完成」入口（压缩 ≥ 2 次时浮层里给）。null = 不给这一项、只留提示文字：
   * 会话生命周期实验开关关着、会话还没落盘、或已经是完成态。
   */
  markDone: { onSelect: () => void; busy: boolean } | null;
  /** 「查看上下文」：打开右栏上下文面板（分项之后、压缩之前）；null = 不给 */
  onOpenContext: (() => void) | null;
}) {
  const t = useT();
  const { session } = props;
  const stats = session.stats;
  const ring = contextRing(stats, t);
  const compactions = session.compactionCount;
  const busy = session.phase !== "idle";
  // 包月制的 provider 不显示花费——那个数字是拿 API 价目表算的估价，不是他的账单。
  // 认不得的 id（自建网关）一律当按量算：藏起真实花费比多一行估价更坏。
  // 按目录条目判（同一家的第二个实例也认得出），所以要拿到这条会话用的 provider 本身
  const provider =
    session.model === null ? undefined : session.usable.find((item) => item.id === session.model?.providerId);
  const billing = provider !== undefined && isPlanBilling(provider) ? "plan" : "metered";
  /**
   * 压缩走两段式（与侧栏 Delete 同一副骨架，wafo 2026-09-03 裁决）：
   * 用户意愿优先——不再拿「内容太少」当拒绝理由，改说「价值不大」再让他确认。
   * 第二段的文案按规模分岔：阈值取 pi 的 keepRecentTokens 默认值（20k）——
   * 低于它压缩省不了什么，高于它才值得问一句「确认压吗」。
   */
  const [confirming, setConfirming] = useState(false);
  /**
   * 「值得压」的量不是「当前上下文多大」，而是**还有多少没被压过的内容**。
   *
   * 已压缩过的会话当前 tokens 里大部分是摘要——摘要本身再压一遍没有意义，
   * 有意义的是上次界碑之后又攒了多少新对话。用 `tokensAfter`（上次压缩完的
   * 估算）当基线：新增 = 当前 − 基线。没压过的会话没有基线，全部都算新增。
   * （wafo 2026-09-03 深夜实测撞的坑：压缩到 15k 后判「≤20k 不值得」用的是
   * 总量，把「压完只剩摘要」和「压根没得压」混成了同一句话。）
   *
   * 阈值 20k = pi 的 keepRecentTokens 默认值。
   */
  const usageTokens = stats?.contextUsage?.tokens ?? null;
  const lastCompactedTo = session.compactions.at(-1)?.tokensAfter ?? null;
  const freshTokens =
    usageTokens === null ? null : lastCompactedTo === null ? usageTokens : Math.max(0, usageTokens - lastCompactedTo);
  const worthIt = freshTokens !== null && freshTokens > 20_000;
  const items: MenuItem[] = [
    ...usageBreakdown(stats, t, billing).map((row): MenuItem => ({
      id: row.label,
      label: row.label,
      hint: row.value,
      fact: true,
    })),
    // 压缩次数：0 次不出这一行（没压过就没什么可报的）
    ...(compactions > 0
      ? [
          {
            id: "compacted-count",
            label: t.stats.compacted,
            hint: t.stats.compactedTimes(compactions),
            fact: true,
          } satisfies MenuItem,
        ]
      : []),
    // 「查看上下文」：分项只报总量，按来源看装了什么去右栏面板
    ...(props.onOpenContext === null
      ? []
      : [
          {
            id: "open-context",
            label: t.contextPanel.open,
            icon: "layers" as const,
            onSelect: props.onOpenContext,
          } satisfies MenuItem,
        ]),
    // 压过两次就建议收尾：第三次压缩时摘要已是摘要的摘要，不如带着遗留事项换会话
    ...(compactions >= WRAP_UP_AFTER_COMPACTIONS && !confirming
      ? [
          {
            id: "wrap-up-hint",
            label: props.markDone === null ? t.chat.compactSuggestNew : t.chat.compactSuggestDone,
            icon: "lightbulb" as const,
            fact: true,
          } satisfies MenuItem,
          ...(props.markDone === null
            ? []
            : [
                {
                  id: "wrap-up-done",
                  label: t.chat.markTaskDone,
                  icon: "check" as const,
                  hint: props.markDone.busy ? t.chat.compactWait : undefined,
                  disabled: props.markDone.busy,
                  onSelect: props.markDone.onSelect,
                } satisfies MenuItem,
              ]),
        ]
      : []),
    ...(confirming
      ? [
          {
            id: "compact-confirm-hint",
            label: worthIt
              ? t.chat.compactConfirm
              : t.chat.compactShort,
            fact: true,
          } satisfies MenuItem,
          {
            id: "compact-confirm",
            label: t.chat.compactAnyway,
            icon: "fold-vertical" as const,
            onSelect: () => {
              setConfirming(false);
              session.compact();
            },
          },
          {
            id: "compact-cancel",
            label: t.common.cancel,
            icon: "x" as const,
            keepOpen: false,
            onSelect: () => setConfirming(false),
          } satisfies MenuItem,
        ]
      : [
          {
            id: "compact",
            label: t.chat.compactNow,
            icon: "fold-vertical" as const,
            hint: session.readOnly
              ? t.chat.compactReadOnly
              : busy
                ? t.chat.compactWait
                : undefined,
            disabled: session.readOnly || busy,
            keepOpen: true,
            onSelect: () => setConfirming(true),
          } satisfies MenuItem,
        ]),
  ];
  return (
    <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", justifyContent: "flex-end" }}>
      <Menu
        items={items}
        placement="above"
        align="end"
        hoverOpen
        onOpenChange={(next) => {
          if (!next) setConfirming(false);
        }}
        trigger={({ open, toggle }) => (
          <Chip
            active={open}
            onClick={toggle}
            ariaLabel={compactions > 0 ? `${ring.label} · ${t.stats.compacted} ${t.stats.compactedTimes(compactions)}` : ring.label}
            leading={<Ring ring={ring} layers={ringLayers(compactions)} />}
          >
            {null}
          </Chip>
        )}
      />
    </span>
  );
}

/**
 * 环的几何：外径 20 = 模型芯片里的型号头像（两者在底栏同高对齐），线宽 2、圈隙 1，
 * 两圈半径依次 9 / 6。数字档只有外圈，里面留 16px 给数字。
 */
const RING_SIZE = 20;
const RING_STROKE = 2;
const RING_GAP = 1;

/**
 * 上下文占用环（Apple 健身圆环式，档位见 stats-format 的 `ringLayers`）。
 * 底轨一圈中性边框色，弧从 12 点方向顺时针长——和钟一样，不用学。
 * 画满的圈（用完的窗口）用 tertiary 墨，当前圈继承文字色：前者是历史，后者才是要看的那一圈。
 * 颜色是第二信号（设计系统）：过七成 warning、过九成 danger，**只给当前圈**。
 * `fill` 为 null 时当前圈只有底轨：没数字就不画数字。
 */
function Ring(props: { ring: ContextRing; layers: RingLayers }) {
  const { fill, tone } = props.ring;
  const { full, label } = props.layers;
  const color =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warning"
        ? "var(--color-warning)"
        : "currentColor";
  const center = RING_SIZE / 2;
  const radii = Array.from(
    { length: full + 1 },
    (_, index) => (RING_SIZE - RING_STROKE) / 2 - index * (RING_STROKE + RING_GAP),
  );
  const current = radii[full] ?? (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * current;
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden
      style={{ display: "block" }}
    >
      {radii.map((radius, index) => (
        <circle
          key={radius}
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke={index < full ? "var(--color-text-tertiary)" : "var(--color-border-strong)"}
          strokeWidth={RING_STROKE}
        />
      ))}
      {fill !== null && fill > 0 && (
        <circle
          cx={center}
          cy={center}
          r={current}
          fill="none"
          stroke={color}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fill} ${circumference}`}
          transform={`rotate(-90 ${center} ${center})`}
          style={{ transition: "stroke-dasharray var(--duration-hover) var(--ease-standard)" }}
        />
      )}
      {label !== null && (
        <text
          x={center}
          y={center}
          textAnchor="middle"
          dominantBaseline="central"
          fill="currentColor"
          style={{
            fontFamily: "var(--font-family-base)",
            fontSize: "var(--font-size-xs)",
            fontWeight: "var(--weight-semibold)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {label}
        </text>
      )}
    </svg>
  );
}

/**
 * 一个渲染单元：摊平后每单元独立占一行——用户气泡、正文、思考行、工具行/组、界碑行。
 * 单元间距由外层内容列统一（16px）——设计系统：chat 内卡片之间由 16px 空白分隔。
 */
function EntryView(props: {
  entry: RenderEntry;
  toolResults: ToolResultIndex;
  activeThinkingKey: string | null;
  turnActive: boolean;
  /** 流式中的 assistant 记录 id 集：text 块的 MarkdownBlock 据此传 streaming——
   * 流式帧不挂 rehype-katex、不跑 shiki，落定（翻 false）后才补渲 */
  streamingIds: ReadonlySet<string>;
  /** 已中断的工具调用 id 集（interruptedToolCallIds）：成员行按「已中断」渲染 */
  interruptedCalls: ReadonlySet<string>;
  onOpenTask?: (sessionId: string) => void;
  carryoverCards: ReadonlyMap<string, { scan: ScanMessage; firstKey: string }>;
  /** 子会话 PR4a：channelMark / delegate / reply_subsession / report_to_parent 要用 */
  channel: ChannelViewContext;
  /** read SKILL.md 徽标的识别索引（透传自 ChatViewBody） */
  skills: SkillMeta[];
  /** 轮尾卡：会话 cwd（路径显示用）与被撤销的轮 id 集 */
  cwd: string | null;
  undoneTurnIds: ReadonlySet<string>;
  /** 单轮撤销入口（轮尾卡的 Undo）；busy 时卡上按钮自己禁用 */
  onUndoTurn: (turnId: string) => void;
  /** 会话在跑 / 排队非空：撤销入口禁用的真值在 ChatViewBody 算好传入 */
  actionsBusy: boolean;
  /** 回退入口（user 气泡的「回到这里」）；undefined = 不给（子会话面板等只读视图） */
  onRevertTo?: (messageId: string) => void;
  /** 只读（无 pi 本子）：回退 / 撤销不可用 */
  readOnly?: boolean;
  /** 轮尾卡文件行的「在面板里看」（原样转发给 FileTurnCard） */
  onOpenReviewAt?: (path: string) => void;
  /** 召回终态卡的「在右栏看图谱」（主槽才有） */
  onOpenIntentPanel?: () => void;
  /** 记忆行（实验功能 memory-system）：挂在用户气泡下；undefined = 不画 */
  memory?: MemoryLines | null;
  onOpenMemoryReview?: () => void;
  /** 产物打开按钮的会话对账（主进程白名单按它查） */
  sessionId: string;
}) {
  const t = useT();
  const { entry } = props;
  if (entry.kind === "compacted") return <CompactedLine record={entry.record} />;
  if (entry.kind === "user") {
    const memoryRow = props.memory?.rows.get(entry.item.id);
    return (
      <>
        <UserBubble
          item={entry.item}
          onRevertTo={props.onRevertTo}
          revertDisabled={props.actionsBusy || props.readOnly === true}
          revertDisabledWhy={props.readOnly ? t.chat.revertReadOnly : t.chat.revertBusy}
        />
        {memoryRow !== undefined && memoryRow.remembered.length > 0 && (
          <MemoryLine row={memoryRow} onOpenReview={props.onOpenMemoryReview} />
        )}
      </>
    );
  }
  if (entry.kind === "fileTurn") {
    return (
      <FileTurnCard
        record={entry.record}
        cwd={props.cwd}
        undone={props.undoneTurnIds.has(entry.record.id)}
        busy={props.actionsBusy}
        onUndo={props.onUndoTurn}
        onOpenFile={props.onOpenReviewAt}
        sessionId={props.sessionId}
      />
    );
  }
  if (entry.kind === "revertMark") {
    return <RevertMarkView record={entry.record} cwd={props.cwd} onOpenFile={props.onOpenReviewAt} />;
  }
  if (entry.kind === "intentRecall") {
    return <IntentRecallFinalCard record={entry.record} onOpenIntentPanel={props.onOpenIntentPanel} />;
  }
  if (entry.kind === "channelMark") {
    // 子会话流里的父侧消息（task / reply / stop）：正文直接进对话流——虚线气泡 +
    // 引子（2026-10-12 用户裁决：父会话给子会话的命令要直接出现在子会话的 UI 里），
    // 不再是一行「在通道里查看」的胶囊。
    if (props.channel.ownSide === "child" && entry.mark.from === "parent") {
      return (
        <ChannelFromParentBubble
          mark={entry.mark}
          message={props.channel.channelMessages.get(entry.mark.messageId)}
          loading={props.channel.channelMessagesLoading}
          error={props.channel.channelMessagesError}
        />
      );
    }
    // 父流里子发来的消息：问询 / 完成 / 失败胶囊（下一刀接上），进度不进父流。
    if (props.channel.ownSide === "parent" && entry.mark.from === "child" && entry.mark.kind !== "progress") {
      return <ChannelFromChildPill mark={entry.mark} channel={props.channel} />;
    }
    // 其余组合（父流里的 progress 标记、防御性兜底）：不渲染——进度是子会话自己的
    // 事，父流里它的落点就是没有落点
    return null;
  }
  if (entry.kind === "text") {
    const card = props.carryoverCards.get(entry.messageId);
    if (card !== undefined) {
      // 同一条消息的多个 text 块只渲染一张卡（第一个块的位置），其余已并进卡里
      if (entry.key !== card.firstKey) return null;
      return <CarryoverScanCard scan={card.scan} />;
    }
    // 引用的来源标记：划选要落在单个块里才成引用，跳回原文也按它找。
    // streaming：正在流式的那条渲染成便宜的帧（不排公式、不高亮代码，见 stream-render.ts），
    // 落定后自动补渲
    return (
      <div className="assistant-prose" data-quote-id={entry.messageId} data-quote-role="assistant">
        <MarkdownBlock text={entry.text} streaming={props.streamingIds.has(entry.messageId)} />
      </div>
    );
  }
  if (entry.kind === "thinking") {
    return (
      <ThinkingLine text={entry.text} active={entry.key === props.activeThinkingKey} blockKey={entry.key} />
    );
  }
  if (entry.kind === "toolCall") {
    return (
      <ToolLine
        toolCallId={entry.toolCallId}
        toolName={entry.toolName}
        input={entry.input}
        result={props.toolResults.get(entry.toolCallId)}
        interrupted={props.interruptedCalls.has(entry.toolCallId)}
        onOpenTask={props.onOpenTask}
        channel={props.channel}
        skills={props.skills}
      />
    );
  }
  return (
    <ToolGroupLine
      group={entry}
      toolResults={props.toolResults}
      turnActive={props.turnActive}
      interruptedCalls={props.interruptedCalls}
      onOpenTask={props.onOpenTask}
      channel={props.channel}
      skills={props.skills}
    />
  );
}

/**
 * 大折叠行（一轮一行）：agent 整轮回答落定后，这轮的思考行与工具行/组收成
 * 一条统计——`Worked 45s · thought 2 · tools 8 · bash 3 · read 5 1 · edit 2`
 * （段与段之间用 · 分隔；失败数是紧跟在工具次数后面的红色数字）。
 * Worked 之后每个段都是「标签 + 数字」同一语法：thought / tools 与工具名
 * 同一套小写词汇，数字一律在后。
 * 工具类别用**真实工具名**而非组行动词（Run/Read…）：统计行是机器事实，
 * Run 会把 bash 与 powershell 混为一谈，且成员行展开后显示的也是同一套名字。
 * 思考排在工具之前——先想后做，时间序。
 * 展开就是成员行原样（小折叠降级为成员，两层折叠契约）；轮耗时是记录时间戳
 * 的跨度（adapter 每帧落 now()，旧会话也准）。
 * 图标裁决（用户）：折叠头**不带图标**——工具类失败靠跟在工具后面的红色数字
 * 说话；只有回合级失败（网络中断、重试耗尽——turnError 的红字就渲染在折叠
 * 后面）才在行首亮红 triangle，图标与那行红字是一对。
 * 成员行与折叠头同左缘（不缩进），与 ToolGroupLine 的成员同一规矩。
 */
function TurnRollupLine(props: {
  group: TurnGroupUnit;
  toolResults: ToolResultIndex;
  turnFailed: boolean;
  onOpenTask?: (sessionId: string) => void;
  carryoverCards: ReadonlyMap<string, { scan: ScanMessage; firstKey: string }>;
  /** 子会话 PR4a：折叠展开后的成员行仍走 EntryView，需要同一份上下文原样转发 */
  channel: ChannelViewContext;
  /** 透传给成员 EntryView（read SKILL.md 徽标用） */
  skills: SkillMeta[];
  /** 轮尾卡（成员里可能有 fileTurn 单元——折叠段尾钉着的卡不进 members，但
   * 通道工具切块后的段内仍可能夹着）：与 TranscriptColumn 同名 props 原样转发 */
  cwd: string | null;
  undoneTurnIds: ReadonlySet<string>;
  onUndoTurn: (turnId: string) => void;
  actionsBusy: boolean;
  /** 轮尾卡文件行的「在面板里看」（成员里的 fileTurn 单元用，原样转发） */
  onOpenReviewAt?: (path: string) => void;
  /** 产物打开按钮的会话对账 */
  sessionId: string;
  /** 已中断的工具调用 id 集（interruptedToolCallIds）：成员行按「已中断」渲染 */
  interruptedCalls: ReadonlySet<string>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { group } = props;
  // 「今天只写时分」的档位随日历日走：跨午夜翻档（today.ts 的 useToday）
  const today = useToday();
  const stats = turnStats(group, props.toolResults, Date.now(), props.skills);
  // 统计段先收集再渲染：段与段之间插 · 分隔——纯 gap 挨在一起分不清边界；
  // 工具次数与它的失败数字是一个段，中间不插
  const segments: ReactNode[] = [];
  // 加粗开头：有时长是「用时」，量不到时由第一段统计顶上（rollupLead）。顶上来的那段
  // 首字母大写（英文 thought / tools 本是小写的统计词；中文不受影响）
  const lead = rollupLead(stats);
  // 整行一个字级（2026-10-29 精装第三笔）：12px / 500 / tertiary。原来开头是 14px / 650
  // （工具名那一档），比正文还重，读者先看见日志、后看见结论；后面各段又是 11px——
  // 一行两种元数据写法。轮折叠头是注脚，退回元数据档
  const leadStyle: React.CSSProperties = { ...ROLLUP_SEGMENT, fontFamily: "var(--font-family-base)", textTransform: "capitalize" };
  if (stats.durationMs !== null) {
    segments.push(
      <span style={{ ...ROLLUP_SEGMENT, fontFamily: "var(--font-family-base)" }}>
        {t.chat.worked} {formatToolDuration(stats.durationMs, t)}
      </span>,
    );
  }
  if (stats.thinkingCount > 0) {
    segments.push(
      <span style={lead === "thinking" ? leadStyle : ROLLUP_SEGMENT}>
        {t.chat.thought} {stats.thinkingCount}
      </span>,
    );
  }
  if (stats.calls > 0) {
    segments.push(<span style={lead === "tools" ? leadStyle : ROLLUP_SEGMENT}>{t.chat.tools(stats.calls)}</span>);
  }  for (const { toolName, count, failed } of stats.byTool) {
    segments.push(
      <span style={ROLLUP_SEGMENT}>
        {t.chat.rollupTool(toolName)} {count}
        {/* 失败数不写词，红色数字直接跟在次数后面——红即失败的语义 */}
        {failed > 0 && <span style={{ color: "var(--color-danger)" }}> {failed}</span>}
      </span>,
    );
  }
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      {/* 轮头时间（用户裁决 2026-10-12）：这轮开始流式回复的时刻，放在「用时」
          那行上面——时长与起点摆在一起看。左缘对齐 CollapseRow 的文本起点（按钮
          左内边距 = 血线 RAIL_X）。缺时间戳（诚实未知）不渲染 */}
      {group.startedAt !== null && (
        <div
          className="turn-start-time"
          style={{ ...TIME_LABEL, paddingLeft: RAIL_X }}
          title={fullTimestamp(group.startedAt, t.chat.timeWeekdays)}
        >
          {formatMessageTime(group.startedAt, today)}
        </div>
      )}
      <CollapseRow dense open={open} onToggle={() => setOpen((value) => !value)}>
        {props.turnFailed && (
          <span style={{ color: "var(--color-danger)", flex: "0 0 auto" }}>
            <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          </span>
        )}
        {segments.map((segment, index) => (
          <Fragment key={index}>
            {index > 0 && <span style={SEP_DOT}>·</span>}
            {segment}
          </Fragment>
        ))}
      </CollapseRow>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {group.members.map((member) => (
            <EntryView
              key={member.key}
              entry={member}
              toolResults={props.toolResults}
              activeThinkingKey={null}
              turnActive={false}
              interruptedCalls={props.interruptedCalls}
              onOpenTask={props.onOpenTask}
              carryoverCards={props.carryoverCards}
              channel={props.channel}
              skills={props.skills}
              cwd={props.cwd}
              undoneTurnIds={props.undoneTurnIds}
              onUndoTurn={props.onUndoTurn}
              actionsBusy={props.actionsBusy}
              onOpenReviewAt={props.onOpenReviewAt}
              sessionId={props.sessionId}
              streamingIds={EMPTY_STREAMING_IDS}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 折叠行只收已落定轮次，成员永远不在流式——空集占位，避免每次渲染新建 Set */
const EMPTY_STREAMING_IDS: ReadonlySet<string> = new Set<string>();

/**
 * 用户消息：右对齐的独立气泡；只有 text 块进气泡。text 走 MarkdownBlock 的
 * bubble 变体（标题摊平、换行保留，其余与模型回复同一套管线）。
 * 气泡下方的复制图标（与回答行同款反馈）：拷输入的原文（只含 text，图片不进）。
 */
/** 乐观回显行：发出即画的用户气泡。真回显（转录 item_started）一到，这行被换下。 */
function PendingEchoRow(props: { blocks: readonly string[] }) {
  const item = {
    role: "user" as const,
    id: "pending-echo",
    content: props.blocks.map((text) => ({ type: "text" as const, text })),
    timestamp: Date.now(),
  };
  // 回退入口不给：这条还没落进转录，回退目标不存在（真回显落定后入口自然出现）
  return <UserBubble item={item} revertDisabled />;
}

function UserBubble(props: {
  item: Extract<TranscriptItem, { role: "user" }>;
  /** 「回到这里」：回退到这条消息之前（含原文放回输入框）；undefined = 不给入口 */
  onRevertTo?: (messageId: string) => void;
  /** 运行中 / 排队非空 / 只读：入口禁用（tooltip 说明） */
  revertDisabled: boolean;
  revertDisabledWhy?: string;
}) {
  const t = useT();
  const today = useToday();
  const [copied, setCopied] = useState(false);
  // 垂直 clamp 到约 4 行（composer 上限 12 行的 1/3，wafo 2026-09-20）：溢出时底部
  // 渐变遮罩 + Show more/less 开合。overflowing 只在折叠态量——展开后
  // scrollHeight == clientHeight，结论会丢，按钮就再也收不回了。
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // 量的是折叠 wrapper（不是气泡本体）：scrollHeight 是全文高、clientHeight 是
  // clamp 高，两者都在无 padding 的内容盒上量，判定才不被气泡 chrome 干扰
  const clampRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const textBlocks = props.item.content.filter((block) => block.type === "text");
  // 文本块**按内容识别**（splitUserTextBlocks）：粘贴块 / 文件清单块解析回折叠 chip，
  // 其余才是正文——「只发附件不打字」的消息第一块就是 <pasted-text>，按「第一块
  // 恒是正文」猜会把裸标签渲染进气泡（review #90 指出）。旧会话只有单块正文，
  // 这条路径同样走通、行为不变。
  // `/skill:` / `/mcp:` 的指令块先剥掉：转录存的是发给模型的全文（指令 + 原文），
  // 气泡只显示用户自己写的话（token 以纯文字留在原文里，chip 化是后续另一个 PR）；
  // 剩下的旧格式 `<skill>` 块（2026-10-02 前的存量转录）拆成折叠卡：skill 正文
  // 几千字，不能平铺进气泡；句中展开时代一条消息可能有多块，逐张成卡，块前后的
  // 文字按原顺序留在气泡里。新消息不再产生 `<skill>` 块，这条路径仅服务旧数据。
  const split = splitUserTextBlocks(textBlocks.map((block) => block.text));
  const body = stripInvocationBlock(split.body);
  const skillSegments = parseSkillSegments(body);
  const skillCards =
    skillSegments === null
      ? []
      : skillSegments.filter(
          (segment): segment is Extract<SkillSegment, { kind: "skill" }> => segment.kind === "skill",
        );
  const skillFreeText =
    skillSegments === null
      ? body
      : skillSegments
          .filter(
            (segment): segment is Extract<SkillSegment, { kind: "text" }> => segment.kind === "text",
          )
          .map((segment) => segment.text)
          .join("\n\n");
  const parsed = parseQuotedMessage(skillFreeText);
  const quotes = parsed.quotes;
  const copyText = parsed.text;
  const pastedBlocks = split.pasted.map((content) => ({ content, lines: pastedTextSize(content).lines }));
  const fileRefs = split.files;
  // markdown 轻量渲染（表格/粗体/代码块/数学放行，标题摊平——wafo 2026-09-20：
  // 「正文里渲染正确，user message 为什么不一并渲染」）。多块之间空行分段。
  const text = parsed.text;
  const jumpToQuote = useContext(QuoteJumpContext);
  // 引用默认收成一行摘要，复制键旁的眼睛切全文（Proma 同款：发出去之后引用是背景，不该占满屏）
  const [quotesExpanded, setQuotesExpanded] = useState(false);
  const images = props.item.content.filter(
    (block): block is Extract<typeof block, { type: "image" }> => block.type === "image",
  );
  // 只发图的消息没有文字气泡——一个空气泡比没有更像出了错
  const hasText = text.trim() !== "";
  useLayoutEffect(() => {
    if (expanded) return;
    const el = clampRef.current;
    if (el === null) return;
    const measure = () => setOverflowing(isBubbleOverflowing(el.scrollHeight, el.clientHeight));
    measure();
    // 宽度变了要重量：右栏打开 / 拖窗口让聊天列变窄，原本 4 行内的消息会折到第 5 行——
    // 折叠样式一直挂着（不论溢出与否），不重量的话正文被静默裁掉、却没有展开键与遮罩；
    // 反过来列变宽，原本溢出的消息放得下了，展开键与遮罩还残留着。只在折叠态观察：
    // 展开后两个高度相等，量了会把结论丢掉（收起时 expanded 变化会再量一次）
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, expanded]);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        width: "100%",
        gap: 2,
      }}
    >
      {images.length > 0 && <UserImages images={images} />}
      {quotes.length > 0 && (
        <div
          style={{
            display: "grid",
            justifyItems: "end",
            gap: "var(--space-1)",
            maxWidth: "var(--bubble-max-width)",
            marginBottom: "var(--space-1)",
          }}
        >
          {quotes.map((quote, index) => (
            <QuoteChip
              key={index}
              index={index + 1}
              quote={quote}
              expanded={quotesExpanded}
              onJump={jumpToQuote(quote)}
            />
          ))}
        </div>
      )}
      {fileRefs.length > 0 && (
        // 文件引用行。发送后排布的统一规则（2026-09-27 定稿）：
        // 图片 → 引用 → 文件 → skill → 粘贴文字 → 文字气泡——前三类是「带进来的
        // 材料」（对话里的 / 磁盘上的），粘贴文字是用户写的内容、贴着气泡
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-2)",
            justifyContent: "flex-end",
            maxWidth: "var(--bubble-max-width)",
            marginBottom: "var(--space-1)",
          }}
        >
          {fileRefs.map((ref, index) => (
            <FileRefChip
              key={`file:${index}`}
              name={fileRefName(ref.path)}
              path={ref.path}
              kind={ref.kind}
            />
          ))}
        </div>
      )}
      {skillCards.length > 0 &&
        // 旧转录的 `<skill>` 块折叠卡，落在统一排布的第四行：图片 → 引用 → 文件 →
        // **skill** → 粘贴文字 → 文字气泡（2026-09-27 定稿）。它按内容也是「带进来
        // 的材料」，排在材料组末尾；句中多块调用就多张卡，同一行话语里挂多个 skill
        skillCards.map((card, index) => (
          <SkillInvocationCard key={`skill:${index}`} name={card.name} content={card.content} />
        ))}
      {pastedBlocks.length > 0 && (
        // 粘贴文字行：贴着气泡（它是用户写的内容，不是从磁盘带来的材料）；
        // 折叠成一行——发出去之后它是背景，不该在对话流里再刷一次屏
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--space-2)",
            justifyContent: "flex-end",
            maxWidth: "var(--bubble-max-width)",
            marginBottom: "var(--space-1)",
          }}
        >
          {pastedBlocks.map((block, index) => (
            <PastedTextChip key={`pasted:${index}`} text={block.content} lines={block.lines} />
          ))}
        </div>
      )}
      {hasText && (
        <div
          data-quote-id={props.item.id}
          data-quote-role="user"
          style={{
            position: "relative",
            width: "fit-content",
            maxWidth: "var(--bubble-max-width)",
            minWidth: 0,
            padding: "9px 13px",
            background: "var(--color-chat-card-bg)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-bubble)",
            fontSize: "var(--font-size-base)",
            lineHeight: "var(--line-height-reading)",
            overflowWrap: "anywhere",
          }}
        >
          {/* 折叠裁剪落在内容自己的 wrapper 上（无 padding / 边框）：裁剪边正好是
              第 4 行底边，第 5 行整体藏在裁剪线以下。旧实现把 maxHeight 加在气泡
              本体，裁剪边（padding box）比第 4 行低出一条 bottom padding，第 5 行
              的上半截正好落进可见带——「最后一行被裁一半」的根因，详见
              user-bubble-clamp.ts */}
          <div ref={clampRef} style={bubbleClampStyle(expanded)}>
            <MarkdownBlock text={text} variant="bubble" />
          </div>
          {!expanded && overflowing && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: 0,
                height: "var(--space-8)",
                background: "linear-gradient(transparent, var(--color-chat-card-bg))",
                borderRadius: "0 0 var(--radius-bubble) var(--radius-bubble)",
                pointerEvents: "none",
              }}
            />
          )}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        {overflowing && (
          <button
            type="button"
            title={expanded ? t.chat.showLess : t.chat.showMore}
            aria-label={expanded ? t.chat.showLess : t.chat.showMore}
            onClick={() => setExpanded((value) => !value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "var(--space-1-5)",
              border: "none",
              background: "none",
              color: "var(--color-text-tertiary)",
              cursor: "pointer",
            }}
          >
            <Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} strokeWidth={1.8} />
          </button>
        )}
        {quotes.length > 0 && (
          <button
            type="button"
            title={quotesExpanded ? t.quote.collapse : t.quote.expand}
            aria-label={quotesExpanded ? t.quote.collapse : t.quote.expand}
            aria-pressed={quotesExpanded}
            onClick={() => setQuotesExpanded((value) => !value)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "var(--space-1-5)",
              border: "none",
              background: "none",
              color: "var(--color-text-tertiary)",
              cursor: "pointer",
            }}
          >
            <Icon name={quotesExpanded ? "eye-off" : "eye"} size={12} strokeWidth={1.8} />
          </button>
        )}
        {/* 只发图的消息没有可拷的文字，复制键不出现（置灰的键只是噪音） */}
        {hasText && (
        <button
          type="button"
          title={copied ? t.chat.copied : t.chat.copyMessage}
          aria-label={copied ? t.chat.copied : t.chat.copyMessage}
          disabled={copyText === ""}
          onClick={() => {
            void navigator.clipboard.writeText(copyText);
            setCopied(true);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "var(--space-1-5)",
            border: "none",
            background: "none",
            color: copied ? "var(--color-success)" : "var(--color-text-tertiary)",
            cursor: copyText === "" ? "default" : "pointer",
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} strokeWidth={1.8} />
        </button>
        )}
        {props.onRevertTo !== undefined && (
          <button
            type="button"
            title={props.revertDisabled ? (props.revertDisabledWhy ?? t.chat.revertHere) : t.chat.revertHere}
            aria-label={t.chat.revertHere}
            disabled={props.revertDisabled}
            onClick={() => props.onRevertTo?.(props.item.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              padding: "var(--space-1-5)",
              border: "none",
              background: "none",
              color: "var(--color-text-tertiary)",
              cursor: props.revertDisabled ? "default" : "pointer",
            }}
          >
            <Icon name="rotate-ccw" size={12} strokeWidth={1.8} />
          </button>
        )}
        {/* 发送时间（用户裁决 2026-10-12）：钉在这排动作的最右（行尾血线——时间戳
            是 trailing 元素），与按钮同一排、不占气泡上方（引用多时会被顶高）。
            常显不随按钮变化：这排动作本就常驻，时间不会跳动 */}
        <span
          className="user-msg-time"
          style={{ ...TIME_LABEL, flex: "0 0 auto" }}
          title={fullTimestamp(props.item.timestamp, t.chat.timeWeekdays)}
        >
          {formatMessageTime(props.item.timestamp, today)}
        </span>
      </div>
    </div>
  );
}

/**
 * 旧转录 `<skill>` 块的折叠卡（pi TUI 同款形态）：默认一行「skill 名」，点开看
 * 全文——skill 正文几千字，收着才不淹没对话。2026-10-02 起 `/skill:` 改指令式，
 * 新消息不再产生这种块，这张卡只服务存量会话的显示。在右对齐的气泡列里要
 * fit-content 宽度，不复用 CollapseRow（那套是全宽的工具行骨架）。
 */
function SkillInvocationCard(props: { name: string; content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-1)",
        width: "fit-content",
        maxWidth: "var(--bubble-max-width)",
        minWidth: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "6px 10px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--color-border-subtle)",
          background: "transparent",
          cursor: "pointer",
          minWidth: 0,
          textAlign: "left",
        }}
      >
        <Icon name="book-open" size={13} strokeWidth={1.8} style={{ color: "var(--color-text-secondary)", flex: "0 0 auto" }} />
        <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-tertiary)", flex: "0 0 auto" }}>
          skill
        </span>
        <span
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-primary)",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {props.name}
        </span>
        <Icon
          name={open ? "chevron-up" : "chevron-down"}
          size={13}
          strokeWidth={1.8}
          style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
        />
      </button>
      {open && (
        <div
          style={{
            maxHeight: 320,
            overflowY: "auto",
            padding: "8px 10px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-border-subtle)",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-sm)",
            lineHeight: "var(--line-height-code)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            color: "var(--color-text-secondary)",
          }}
        >
          {props.content}
        </div>
      )}
    </div>
  );
}

/**
 * 用户消息里的图：右对齐、按原比例缩在 240px 框内（同 MCP 工具图的内联口径）。
 * 显示的是 agent 进程缩放后、真正送给模型的那一份——模型看到什么，这里就是什么。
 */
/** 文件引用的显示名：路径最后一段（目录的尾斜杠不算一段） */
function fileRefName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== "").pop() ?? path;
}

function UserImages(props: { images: readonly PromptImage[] }) {
  const t = useT();
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: "flex-end",
        // 回形针半露在每张图左上角外面，图间距留出它的位置
        gap: "var(--space-3)",
        maxWidth: "var(--bubble-max-width)",
        marginBottom: "var(--space-1)",
      }}
    >
      {viewing !== null && (
        <ImageLightbox images={props.images} startIndex={viewing} onClose={() => setViewing(null)} />
      )}
      {props.images.map((image, index) => (
        <button
          key={index}
          type="button"
          aria-label={t.lightbox.open}
          onClick={() => setViewing(index)}
          style={{ ...ZOOM_BUTTON_STYLE, position: "relative" }}
        >
          <PaperclipMark size={22} />
          <img
            src={imageSrc(image)}
            alt=""
            draggable={false}
            style={{
              display: "block",
              maxWidth: 240,
              maxHeight: 240,
              objectFit: "contain",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--color-border-subtle)",
              background: "var(--color-bg-muted)",
            }}
          />
        </button>
      ))}
    </div>
  );
}

/** 内联图外面那层「点了看大图」的按钮：去掉按钮自己的盒子，只留图；圆角跟图走，焦点环才贴合 */
const ZOOM_BUTTON_STYLE: React.CSSProperties = {
  display: "block",
  padding: 0,
  border: 0,
  background: "none",
  borderRadius: "var(--radius-md)",
  cursor: "zoom-in",
  maxWidth: "100%",
};

/**
 * 分支按钮行（C-2）：挂在每轮 agent 最终完整输出的下面，回答落定即**常驻显示**
 * （用户裁决：不用 hover 浮现）。图标即按钮——悬停 / 读屏都走「Branch from here」这同一个
 * 名字。点了开出一条新会话（该回答及之前的全部），原会话原封不动，所以**无需确认弹窗**。
 * 工具还在跑时禁用：它的结果没齐，此刻裁出去的上下文是畸形的。
 * 分支旁的复制图标（usage-speed-X 同行）：拷该回答的正文（markdown 原样，只含 text 块），
 * 成功后图标换对勾 1.2s——复制成功用图标换字形，不用颜色（ActionRail 同款）。
 * 再右边是这条回答的生成速度：adapter 挂在终态帧上的真值，随记录落盘、重开即回；
 * 过不了噪音门的回答没有这个字段，也就不显示。**流式中的实时速度不在这行**——
 * 它在 Responding 行（估算，每秒一跳），落定后被这里的真值顶替（message-speed.ts）。
 */
function BranchRow(props: {
  anchorItemId: string;
  speed: number | null;
  copyText: string;
  disabled: boolean;
  onBranch: (anchorItemId: string) => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    // 图标按钮自带 6px 内边距（24 的台阶）：行左缩「血线 − 6」，字形落在正文同一根线上
    <div
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: "calc(var(--space-3) / 2)",
        paddingLeft: "calc(var(--content-hem) - var(--space-1-5))",
      }}
    >
      <button
        type="button"
        title={copied ? t.chat.copied : t.chat.copyAnswer}
        aria-label={copied ? t.chat.copied : t.chat.copyAnswer}
        onClick={() => {
          void navigator.clipboard.writeText(props.copyText);
          setCopied(true);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          // 12 的字形 + 两边 6 = 24：落在图标按钮的最小台阶上
          padding: "var(--space-1-5)",
          border: "none",
          background: "none",
          color: copied ? "var(--color-success)" : "var(--color-text-tertiary)",
          cursor: "pointer",
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={12} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => props.onBranch(props.anchorItemId)}
        title={t.chat.branchFromHere}
        aria-label={t.chat.branchFromHere}
        style={{
          display: "inline-flex",
          alignItems: "center",
          // 12 的字形 + 两边 6 = 24：落在图标按钮的最小台阶上
          padding: "var(--space-1-5)",
          border: "none",
          background: "none",
          color: "var(--color-text-tertiary)",
          cursor: props.disabled ? "default" : "pointer",
        }}
      >
        <Icon name="git-branch" size={12} strokeWidth={1.8} />
      </button>
      {props.speed !== null && (
        <span
          style={{
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-family-business)",
            fontVariantNumeric: "tabular-nums",
            fontSize: "var(--font-size-xs)",
          }}
        >
          {formatSpeed(props.speed, t)}
        </span>
      )}
    </div>
  );
}

/**
 * 折叠行共用骨架（设计系统 ToolCard / ThinkingCard）：满宽热区、hover 淡底、
 * 圆角裁边。行首（图标+label）是「状态」本体，副标是注脚（tertiary mono），
 * 状态词是机器事实（xs mono 等宽数字）。
 */
/**
 * 「一轮一行」的过程块（设置 › 过程显示 = turn；推导在 turn-process.ts）。
 *
 * - **活跃**：定高的现场块——头行（第几步 · 各工具次数 · 失败 · 总用时，每秒走表）、
 *   当前章节一行、最近三步（越旧越淡）、当前这一步（自带计时；没有工具在跑就是
 *   「在想 · Ns」）、末行留给输出尾巴或「比平时久」。行数固定，只换字不加行：
 *   太安静像卡住，太吵像一直在走却不出结果（真链条的节奏见 turn-process.ts 头注释）。
 * - **落定**：一行结论（写了几个文件 · 几步 · 各工具次数 · 失败 · 用时），展开成按
 *   旁白切开的章节时间线；每章平铺前几步，点章节看这一章的每一步（原样的工具行）。
 */
function TurnProcessLine(props: {
  unit: TurnProcessUnit;
  toolResults: ToolResultIndex;
  turnFailed: boolean;
  skills: SkillMeta[];
  interruptedCalls: ReadonlySet<string>;
  renderStep: (step: ProcessStep) => ReactNode;
}) {
  const t = useT();
  const today = useToday();
  const { unit } = props;
  const [open, setOpen] = useState(false);
  const live = unit.live && !unit.answering;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!unit.live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [unit.live]);
  const counts = processCounts(unit.steps, props.toolResults, props.skills);
  const toolChips = counts.byTool.slice(0, 4).map(({ key, count }) => (
    <span key={key}>
      {t.chat.rollupTool(key)} {count}
    </span>
  ));
  const failed = counts.failed > 0 && <span className="proc-bad">{t.chat.processFailed(counts.failed)}</span>;
  const timeLabel = unit.startedAt !== null && (
    <div className="turn-start-time" style={{ ...TIME_LABEL, paddingLeft: RAIL_X }} title={fullTimestamp(unit.startedAt, t.chat.timeWeekdays)}>
      {formatMessageTime(unit.startedAt, today)}
    </div>
  );

  if (live) {
    const snap = processLive(unit, props.toolResults, (call) => toolStartAt(call.toolCallId), props.interruptedCalls);
    const elapsed = unit.startedAt === null ? null : now - unit.startedAt;
    const current = snap.now;
    const runMs =
      current.kind === "tool"
        ? current.startedAt === null ? null : now - current.startedAt
        : current.since === null ? null : now - current.since;
    let tail: string | null = null;
    if (current.kind === "tool" && runMs !== null && runMs > TAIL_AFTER_MS) {
      const result = props.toolResults.get(current.call.toolCallId);
      if (result !== undefined) tail = tailPreviewLines(toolResultText(result, t), 1, 200)[0] ?? null;
    }
    const slow = current.kind === "think" && runMs !== null && runMs > SLOW_GAP_MS;
    const verb = (toolName: string, input: unknown) => t.chat.rollupTool(rollupToolKey(toolName, input, props.skills));
    return (
      <div className="proc-live" aria-live="off">
        {timeLabel}
        <div className="proc-head">
          <Icon name="loader-circle" size={12} strokeWidth={1.8} spin />
          <span className="proc-strong">{t.chat.processStepAt(Math.max(1, counts.steps))}</span>
          <span className="proc-num">
            {toolChips}
            {failed}
          </span>
          {elapsed !== null && <span className="proc-time">{formatRunClock(elapsed)}</span>}
        </div>
        <div className={`proc-chapter${snap.chapter?.source === "think" ? " think" : ""}`}>{snap.chapter?.title ?? ""}</div>
        <div className="proc-trail">
          {Array.from({ length: 3 - snap.trail.length }, (_, i) => (
            <div key={`pad${i}`} className="proc-step" aria-hidden="true" />
          ))}
          {snap.trail.map((item, index) => (
            <div key={item.call.toolCallId} className={`proc-step fade-${snap.trail.length - index}`}>
              <span className={item.failed ? "proc-mark bad" : "proc-mark ok"}>
                <Icon name={item.failed ? "x" : "check"} size={12} strokeWidth={2} />
              </span>
              <span className="proc-verb">{verb(item.call.toolName, item.call.input)}</span>
              <code>{toolCallSummary(item.call.toolName, item.call.input) ?? ""}</code>
              {/* 一秒内落定的不标时长：一排 0.0s 是噪音，慢的那几步才值得看 */}
              {item.ms !== null && item.ms >= 1000 && <span className="proc-dur">{formatToolDuration(item.ms, t)}</span>}
            </div>
          ))}
          <div className="proc-step now">
            <span className="proc-mark">
              <Icon name="loader-circle" size={12} strokeWidth={1.8} spin />
            </span>
            {current.kind === "tool" ? (
              <>
                <span className="proc-verb">{verb(current.call.toolName, current.call.input)}</span>
                <code>{toolCallSummary(current.call.toolName, current.call.input) ?? ""}</code>
              </>
            ) : (
              <>
                <span className="proc-verb orbita-breath">{t.chat.processThinking}</span>
                {/* 章节行已经是这段思考时不重复；章节是旁白时，这里补「此刻在想什么」 */}
                <code className="proc-preview">{snap.chapter?.source === "think" ? "" : (current.preview ?? "")}</code>
              </>
            )}
            {runMs !== null && <span className="proc-dur">{formatRunClock(runMs)}</span>}
          </div>
        </div>
        <div className={slow ? "proc-foot slow" : "proc-foot"}>{slow ? t.chat.processSlow : (tail ?? "")}</div>
      </div>
    );
  }

  const outcome = [
    ...(counts.files.length > 0 ? [t.chat.processWrote(counts.files.length)] : []),
    t.chat.processSteps(counts.steps),
  ].join(" · ");
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      {timeLabel}
      <CollapseRow dense open={open} onToggle={() => setOpen((value) => !value)}>
        {props.turnFailed && (
          <span style={{ color: "var(--color-danger)", flex: "0 0 auto" }}>
            <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          </span>
        )}
        <span className="proc-head-row">
          <span className="proc-strong">{outcome}</span>
          <span className="proc-num">
            {toolChips}
            {failed}
          </span>
          {unit.durationMs !== null && <span className="proc-time">{formatToolDuration(unit.durationMs, t)}</span>}
        </span>
      </CollapseRow>
      {open && (
        <ol className="proc-chapters">
          {processChapters(unit.steps).map((chapter) => (
            <ProcessChapterItem key={chapter.key} chapter={chapter} {...props} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** 章节时间线的一章：标题 + 前几步的小标签；点开看这一章的每一步（原样的工具行） */
function ProcessChapterItem(props: {
  chapter: ProcessChapter;
  toolResults: ToolResultIndex;
  skills: SkillMeta[];
  renderStep: (step: ProcessStep) => ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { chapter } = props;
  const failed = chapter.calls.some((call) => props.toolResults.get(call.toolCallId)?.status === "error");
  const title =
    chapter.title ??
    t.chat.processToolsTitle(
      processCounts(chapter.steps, props.toolResults, props.skills)
        .byTool.map(({ key, count }) => t.chat.processToolPart(t.chat.rollupTool(key), count))
        .join(t.common.listSeparator),
    );
  const shown = chapter.calls.slice(0, CHAPTER_STEPS_SHOWN);
  return (
    <li className={failed ? "bad" : undefined}>
      <button
        type="button"
        className="proc-chapter-btn"
        aria-expanded={open}
        title={t.chat.processChapterSteps}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={chapter.source === "say" ? "proc-ch-title" : "proc-ch-title think"}>{title}</span>
        {chapter.calls.length > 0 && (
          <span className="proc-ch-steps">
            {shown.map((call) => (
              <span key={call.toolCallId} className={props.toolResults.get(call.toolCallId)?.status === "error" ? "bad" : undefined}>
                {t.chat.rollupTool(rollupToolKey(call.toolName, call.input, props.skills))}{" "}
                {toolCallSummary(call.toolName, call.input) ?? ""}
              </span>
            ))}
            {chapter.calls.length > shown.length && <span>{t.chat.processMore(chapter.calls.length - shown.length)}</span>}
          </span>
        )}
      </button>
      {open && <div className="proc-ch-body">{chapter.steps.filter((step) => step.kind !== "text").map((step) => props.renderStep(step))}</div>}
    </li>
  );
}

function CollapseRow(props: {
  open: boolean;
  disabled?: boolean;
  /** 28px 的元数据行（轮折叠头）：它是注脚，不该和工具行一样高 */
  dense?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const interactive = props.disabled !== true;
  return (
    <div style={{ minWidth: 0, borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
      <button
        type="button"
        aria-expanded={interactive ? props.open : undefined}
        disabled={!interactive}
        onClick={props.onToggle}
        className="collapse-row-btn"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          width: "100%",
          minHeight: props.dense === true ? "var(--control-height-sm)" : "var(--control-height-md)",
          // 高度就是台阶本身（28 / 32），不由「字 + 上下内边距」撑：原来 6 + 21 + 6 = 33
          padding: `0 ${RAIL_X}`,
          border: "none",
          color: "var(--color-text-secondary)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-base)",
          lineHeight: "var(--line-height-ui)",
          textAlign: "left",
          cursor: interactive ? "pointer" : "default",
        }}
      >
        {props.children}
      </button>
    </div>
  );
}

/**
 * 消息时间标签的共用字音（与 SLOT.status 同一套灰色小字 token）：轮头时间
 * （TurnRollupLine）与用户气泡旁的时间（UserBubble）共用，保持两处观感一致。
 */
const TIME_LABEL = {
  color: "var(--color-text-tertiary)",
  fontFamily: "var(--font-family-business)",
  fontSize: "var(--font-size-xs)",
  fontVariantNumeric: "tabular-nums",
} satisfies React.CSSProperties;

const SLOT = {
  /** 副标不占满整行（flex 0 1 auto）：状态词紧跟其后，行不被拉长 */
  sub: {
    flex: "0 1 auto",
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "var(--color-text-tertiary)",
    fontFamily: "var(--font-family-mono)",
    fontSize: "var(--font-size-sm)",
  },
  status: {
    flex: "0 0 auto",
    color: "var(--color-text-tertiary)",
    fontFamily: "var(--font-family-business)",
    fontSize: "var(--font-size-xs)",
    fontVariantNumeric: "tabular-nums",
  },
} satisfies Record<string, React.CSSProperties>;

/**
 * 行首 label 的亮度是**时间态**：进行中 secondary 半粗（比正文暗一档，全场唯一在动），
 * 状态落定整行退到 tertiary——完成的都是过去时，行与行不再争层次。
 * 失败红是语义色，不参与档位，由调用方另行覆盖。
 */
function headLabel(active: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    fontWeight: "var(--weight-strong)",
    fontSize: "var(--font-size-base)",
    color: active ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
  };
}

/** 行首图标同 label 的时间态；思考的 brain 进行中保持 info 蓝（全转写唯一蓝记号）。 */
function headIconColor(active: boolean): string {
  return active ? "var(--color-text-secondary)" : "var(--color-text-tertiary)";
}

/** 呼吸只包行首（图标+label）——副标和状态词不跟着呼吸，它们不是状态。 */
const HEAD_WRAP = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: "0 0 auto",
} satisfies React.CSSProperties;

/** 大折叠统计段的分隔点：段落边界的标点，最淡一档——它是标点不是内容。 */
/** 轮折叠头的每一段：12px / 500 / tertiary，数字等宽（开头那段换回正文字族） */
const ROLLUP_SEGMENT = {
  flex: "0 0 auto",
  color: "var(--color-text-tertiary)",
  fontFamily: "var(--font-family-business)",
  fontSize: "var(--font-size-sm)",
  fontWeight: "var(--weight-medium)",
  fontVariantNumeric: "tabular-nums",
} satisfies React.CSSProperties;

const SEP_DOT = {
  flex: "0 0 auto",
  color: "var(--color-text-tertiary)",
  opacity: 0.6,
} satisfies React.CSSProperties;

/**
 * 展开体共用形态：圆角虚线框（EXPANDED_FRAME，语义见 expanded-body.ts）接在
 * 折叠行下、无底色、mono caption。各展开体只叠各自排版，框只有这一份真源。
 */
const EXPANDED_BODY = {
  margin: 0,
  ...EXPANDED_FRAME,
  padding: "var(--space-2)",
  maxHeight: 320,
  overflow: "auto",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-sm)",
  lineHeight: "var(--line-height-code)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} satisfies React.CSSProperties;

/**
 * markdown 展开体（压缩界碑行用）：EXPANDED_BODY 的骨架（虚线框 + 320 封顶 +
 * 可滚），排版让给 .chat-md——摘要是结构化文档，不套 mono caption / pre-wrap。
 * 框的缩进与其余展开体同位（x=10px，见 expanded-body.ts），内容列全体一致。
 */
const MARKDOWN_EXPANDED_BODY = {
  margin: 0,
  ...EXPANDED_FRAME,
  padding: "var(--space-2)",
  maxHeight: 320,
  overflow: "auto",
} satisfies React.CSSProperties;

// ── 信息区文案（本模块全部用户可见字符串集中在此；英文先行，中文化等真实需求出现再抽字典） ──

/** 工具的类型图标：图标只说「哪一类事」，具体哪个工具由旁边的名字说。 */
function toolIcon(toolName: string): IconName {
  switch (toolName) {
    case "bash":
    case "powershell":
      return "terminal";
    case "read":
      return "file-text";
    case "write":
    case "edit":
      return "pencil-line";
    case "grep":
    case "find":
      return "search";
    case "ls":
      return "folder";
    case "read_task":
      return "book-open";
    // 受管浏览器：导航与读取都是「在网上」，截图单独一个相机形状不值得——同一枚地球
    case "browser_navigate":
    case "browser_observe":
    case "browser_extract":
    case "browser_screenshot":
    case "browser_tabs":
    case "browser_scroll":
    case "browser_wait_for":
    case "browser_console_messages":
    case "browser_network_requests":
    case "browser_click":
    case "browser_type":
    case "browser_press":
      return "globe";
    default:
      // MCP 工具（mcp__server__tool）：专属插头图标——外部能力，与内置工具一眼区分
      return parseQualifiedToolName(toolName) !== null ? "plug" : "wrench";
  }
}

/**
 * 组行的标签。bash / powershell 直接用**真实工具名**（用户裁决：不说 Run）——
 * Run 是编造的动词，还把两个不同的工具混为一谈；其余保留动词标签（Read/Search…，
 * 与「N files」量词配套），不认识的工具本就回落真名。
 */
function toolGroupLabel(toolName: string, t: Messages): string {
  switch (toolName) {
    case "read":
      return t.chat.toolRead;
    case "grep":
    case "find":
      return t.chat.toolSearch;
    case "write":
      return t.chat.toolWrite;
    case "edit":
      return t.chat.toolEdit;
    case "ls":
      return t.chat.toolList;
    default: {
      // MCP 组：组头直说 server/tool，不露 mcp__server__tool 原名
      const mcp = parseQualifiedToolName(toolName);
      return mcp !== null ? `${mcp.server}/${mcp.tool}` : toolName;
    }
  }
}

/** 组头折叠态的量词——跟着动词说量级：「Read 3 files / Run 3 commands」。 */
function toolGroupCountLabel(toolName: string, count: number, t: Messages): string {
  switch (toolName) {
    case "read":
    case "write":
      return t.chat.files(count);
    case "bash":
    case "powershell":
      return t.chat.commands(count);
    case "edit":
      return t.chat.matches(count);
    case "ls":
      return t.chat.directories(count);
    default:
      return t.chat.calls(count);
  }
}

/**
 * 工具调用行：折叠时一行（行首 + 参数摘要 + 状态词），点开看结果——edit 展开是
 * 带行号的 diff，其余是原文。**进行中：行首（图标+工具名）secondary + 呼吸**——
 * 呼吸即状态，不转圈；跑着的 shell 可展开看实时输出（贴底跟随），其余工具
 * 跑完才能展开。状态落定呼吸与高亮一起消失，整行退到 tertiary。
 * 失败是语义色不参与档位：`triangle-alert` + "failed" 染 danger（AGENTS.md：
 * 状态优先图标与文字，颜色是第二信号）。
 */
function ToolLine(props: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  result: ToolTranscriptItem | undefined;
  /** 结果永远不会来（所在消息 error/aborted 收场且无结果帧，见 interruptedToolCallIds）：
   * 按静止的「已中断」渲染，不呼吸不转圈 */
  interrupted: boolean;
  /** B-1：read_task 的「Open」跳到被读的 task（侧栏点击同语义）；别的工具不传 */
  onOpenTask?: (sessionId: string) => void;
  /** 子会话 PR4a：delegate / reply_subsession / report_to_parent 三个通道工具要用 */
  channel: ChannelViewContext;
  /** read SKILL.md 徽标的识别索引（透传自 EntryView） */
  skills: SkillMeta[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { result } = props;
  const failed = result?.status === "error";
  // 已中断：无结果帧且判定永不回来——不算运行中（不呼吸、不展开、状态词换「已中断」）
  const interrupted = props.interrupted && result === undefined;
  const active = !interrupted && (result === undefined || result.status === "running");
  // ── 运行中 shell 的可见性（长 bash 不再「一行不动」）。active 已含「中断不算
  // 运行」（PR 168）：被中断的 bash 不计时、不自动展开，与真跑着的命令分流 ──
  const shell = props.toolName === "bash" || props.toolName === "powershell";
  const shellActive = shell && active;
  // 秒针：只挂运行中的 shell（Responding 同款，一秒一跳）。睡眠中的命令没有任何
  // 事件帧，计时只能靠自己跳；跑完即停，不留空转的 interval。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shellActive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shellActive]);
  const runStart = shellActive ? toolStartAt(props.toolCallId) : null;
  const expectedSeconds = shell ? expectedSecondsOf(props.input) : null;
  const limitSeconds = shell ? timeoutSecondsOf(props.input) : null;
  // 自动展开的账：用户手动碰过折叠就不再自动改（尊重人）；autoOpened 记「这次
  // 展开是自动的」，跑完只有自动开的才自动收。两个都是 ref——这些是过程状态，
  // 不参与渲染，不值得每次跳秒重算。
  const userToggled = useRef(false);
  const autoOpened = useRef(false);
  useEffect(() => {
    if (!shellActive) {
      // 跑完了：自动展开的自动收回去；用户碰过的保持用户的选择
      if (autoOpened.current && !userToggled.current) setOpen(false);
      return;
    }
    if (userToggled.current) return;
    const elapsed = runStart !== null ? now - runStart : null;
    if (shellAutoExpand(expectedSeconds, elapsed)) {
      autoOpened.current = true;
      setOpen(true);
    }
  }, [shellActive, now, runStart, expectedSeconds]);
  const toggleOpen = () => {
    userToggled.current = true;
    setOpen((value) => !value);
  };

  // 子会话通道工具（子会话 PR4a）：三个工具的信息形状不是「调用 + 摘要」，各自
  // 早退，不复用下面的通用骨架。**三个都不在失败时早退**——照 ToolLine 的失败
  // 样式走（红色 triangle-alert + 可展开看错误），不能被派出卡/标记行的「成功
  // 语气」盖过去。delegate 若在此早退，一次真实失败会被 DelegateCardView 的
  // running 帧（`card === null` 时的「delegating…」呼吸）悄悄吞掉，永远显示
  // 「派出中」而不是「失败了」。
  if (props.toolName === "delegate" && !failed) {
    return (
      <DelegateToolLine
        input={props.input}
        result={result}
        interrupted={interrupted}
        channel={props.channel}
      />
    );
  }
  // 交接（受管浏览器）：离开卡，与派出卡同一个骨架。失败照通用骨架走（红色 + 可展开看错误）
  if (props.toolName === "request_user_action" && !failed) {
    return (
      <HandoffToolLine
        toolCallId={props.toolCallId}
        input={props.input}
        result={result}
        interrupted={interrupted}
      />
    );
  }
  if ((props.toolName === "reply_subsession" || props.toolName === "report_to_parent") && !failed) {
    return (
      <ChannelSendToolLine
        toolName={props.toolName}
        input={props.input}
        result={result}
        running={active}
        interrupted={interrupted}
        channel={props.channel}
      />
    );
  }
  /** MCP 工具（4-5）：行首只说 tool 名，server 进副标；量词与失败分型另有规格 */
  const mcp = parseQualifiedToolName(props.toolName);
  // read SKILL.md：路径尾巴 <slug>/SKILL.md 命中已知 skill 就是在用 skill——
  // 行首换 book-open、标签 skill、副标 skill 名；普通 read 一字不变
  const skillUse =
    props.toolName === "read" &&
    typeof props.input === "object" &&
    props.input !== null &&
    typeof (props.input as Record<string, unknown>)["path"] === "string"
      ? skillForReadPath((props.input as Record<string, unknown>)["path"] as string, props.skills)
      : null;
  const summary = mcp === null ? summarizeToolResult(result, t) : summarizeMcpResult(result, t);
  const callSummary = toolCallSummary(props.toolName, props.input);
  // 路径类工具的摘要只显示文件名——Windows 上模型几乎总传绝对路径，整条 C:\... 是噪音；
  // 完整路径进 tooltip。toolCallSummary 本身保持原始 path 语义（editGroupFileCount 靠它去重）
  const pathTool =
    props.toolName === "read" ||
    props.toolName === "write" ||
    props.toolName === "edit" ||
    props.toolName === "ls";
  const callLabel =
    callSummary !== null && pathTool ? splitPathTail(callSummary).name : callSummary;
  // 跑着的 shell 有实时增量可展，其余工具跑完才有完整结果（见 toolExpandable）
  const expandable = toolExpandable(result, props.toolName);
  const live = expandable && active;
  const finished = result !== undefined && result.status !== "running";
  // B-1：read_task 落定后 details 里带任务卡（running/error 帧没有）；别的工具不解析
  const taskCard = props.toolName === "read_task" && finished ? readTaskCard(result) : null;
  const diff = finished ? editDiffText(result) : null;
  const stats = finished ? editDiffStats(result) : null;
  // 正文只在**真要用**时才拼：`toolResultText` 把结果里每个 text 块 join 成一整条
  // （实测单条最大 479KB），而折叠着的工具行只有两处需要它——展开体（open）与
  // 跑着的 shell 的活尾预览（shellActive）。活跃轮的组行默认铺开，一轮几十个工具时
  // 这条 join 会随每一帧流式更新重跑几十遍，全是白付的分配；落定的成员行更不必说。
  const needBody = open || shellActive;
  const rawBody = needBody && result !== undefined ? toolResultText(result, t) : "";
  // 跑着时只渲染尾部：partial 是累积快照、每帧整条重渲染，万行输出会拖垮 DOM
  const body = live ? liveTailLines(rawBody) : rawBody;
  // 工具结果里的 image 块（read_pdf 页图 / read 读图）内联展示给用户——模型看得见
  // 的图用户也要看得见。有真图时正文里的 [image] 文字标记是冗余的，展开时剥掉
  const toolImages =
    result !== undefined && result.content.some((block) => block.type === "image")
      ? result.content.filter((block): block is Extract<(typeof result.content)[number], { type: "image" }> => block.type === "image")
      : [];
  const imagelessBody =
    needBody && toolImages.length > 0 && result !== undefined
      ? result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")
      : body;
  // write 的正文在入参不在结果（pi 同款：结果只有一行统计），展开走文件内容视图
  const fileView = finished ? fileViewFor(props.toolName, props.input, result) : null;
  const fileLang = fileView !== null ? langFromPath(callSummary ?? "") : null;
  const writeLines =
    !open && props.toolName === "write" && fileView !== null ? writeLineCount(props.input) : null;
  // 只有 shell 类值得看耗时（read/edit 毫秒级是噪音）；旧会话没见过 running 帧，量不到就没有
  const shellDuration =
    (props.toolName === "bash" || props.toolName === "powershell") && !active
      ? toolDurationText(props.toolCallId, t)
      : null;
  // 运行中时钟：已跑多久（+上限，+预计）。起点没记到（旧会话重开）时退化为只报预计，
  // 连预计都没有就什么都不报——宁缺勿假。超出预计如实说「比预计慢」，不给负数倒计时。
  const runClock =
    shellActive && runStart !== null
      ? formatRunClock(Math.max(0, now - runStart)) +
        (limitSeconds !== null ? ` / ${t.chat.limitLabel(formatRunClock(limitSeconds * 1000))}` : "")
      : null;
  const runExpected = (() => {
    if (!shellActive || expectedSeconds === null) return null;
    const about = t.chat.expectedAbout(formatThinkingDuration(expectedSeconds * 1000, t));
    // 起点没记到就没有时钟可比，「比预计慢」判断不了——只报预计，不猜
    if (runStart === null) return about;
    return now - runStart >= expectedSeconds * 1000 ? t.chat.slowerThanExpected : about;
  })();
  // 折叠行下的活尾：有流式输出时取末几行，让「它在动」不展开也看得见；
  // 展开时藏起（展开体本身就是完整活尾，别显两遍）
  const tailPreview = shellActive && !open ? tailPreviewLines(rawBody) : [];

  // 外部能力芯片行（2026-09-27 两轮裁决）：skill 使用与 MCP 调用的身份收进一枚
  // 药丸芯片（图标 + 类型词 + 名字），与输入框附件 chip / 引用 chip 同族——「外部
  // 对象」在整个应用里长一个样；后跟灰色摘要，行形态与普通工具行同层、不抢块。
  // 族内分一档：skill 名正文字体（人写的指令），server/tool 是 mono（机器服务）。
  if (skillUse !== null || mcp !== null) {
    const mcpBrief = mcp === null ? null : (callLabel ?? mcpInputSummary(props.input));
    return (
      <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
        <CollapseRow open={open} disabled={!expandable} onToggle={toggleOpen}>
          <span
            className={active ? "orbita-breath" : undefined}
            style={{
              flex: "0 1 auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 10px",
              borderRadius: 999,
              // 药丸是这一行的重点（用户 2026-09-27：hairline 边框看不清）：
              // muted 底成块 + strong 边框勾轮廓，双信号才压得住玻璃面
              background: "var(--color-bg-muted)",
              border: "1px solid var(--color-border-strong)",
              minWidth: 0,
            }}
          >
            <Icon
              name={failed ? "triangle-alert" : interrupted ? "circle-off" : skillUse !== null ? "book-open" : "plug"}
              size={13}
              strokeWidth={1.8}
              style={{
                color: failed
                  ? "var(--color-danger)"
                  : interrupted
                    ? "var(--color-text-tertiary)"
                    : "var(--color-text-secondary)",
                flex: "0 0 auto",
              }}
            />
            <span style={{ ...SLOT.status, color: "var(--color-text-secondary)" }}>
              {skillUse !== null ? "skill" : "mcp"}
            </span>
            <span
              style={{
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                fontSize: "var(--font-size-sm)",
                lineHeight: "var(--line-height-ui)",
                color: "var(--color-text-primary)",
                fontFamily:
                  skillUse !== null ? "var(--font-family-business)" : "var(--font-family-mono)",
                fontWeight: 600,
              }}
            >
              {skillUse !== null ? skillUse.name : mcp === null ? "" : `${mcp.server}/${mcp.tool}`}
            </span>
          </span>
          {mcpBrief !== null && <span style={{ ...SLOT.sub, flex: "1 1 auto" }}>{mcpBrief}</span>}
          {summary !== null && !active && (
            <span style={failed ? { ...SLOT.status, color: "var(--color-danger)" } : SLOT.status}>
              {summary}
            </span>
          )}
          {interrupted && <span style={SLOT.status}>{t.chat.toolInterrupted}</span>}
        </CollapseRow>
        {open && expandable && (
          <>
            {mcp !== null ? (
              <McpToolBody result={result} />
            ) : (
              <PlainToolBody
                toolName={props.toolName}
                text={imagelessBody}
                failed={failed}
                live={live}
                images={toolImages}
              />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} disabled={!expandable} onToggle={toggleOpen}>
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span style={{ color: failed ? "var(--color-danger)" : headIconColor(active) }}>
            <Icon
              name={
                failed
                  ? "triangle-alert"
                  : interrupted
                    ? "circle-off"
                    : skillUse !== null
                      ? "book-open"
                      : toolIcon(props.toolName)
              }
              size={14}
              strokeWidth={1.8}
            />
          </span>
          <span style={headLabel(active)}>
            {props.toolName}
          </span>
        </span>
        {callLabel !== null && (
          <span
            title={callSummary !== callLabel ? (callSummary ?? undefined) : undefined}
            style={pathTool ? { ...SLOT.sub, color: "var(--color-chat-link)" } : SLOT.sub}
          >
            {callLabel}
          </span>
        )}
        {/* 增删统计紧跟文件名（git stat 读法）；与展开后 DiffView 头重复，展开时藏起 */}
        {!open && stats !== null && (
          <span style={SLOT.status}>
            <span style={{ color: "var(--color-success)" }}>+{stats.added}</span>{" "}
            <span style={{ color: "var(--color-danger)" }}>-{stats.removed}</span>
          </span>
        )}
        {/* write 的量词是行数（无增删语义，不染色）；有了它「N chars」是统计句的长度，让位 */}
        {!open && stats === null && writeLines !== null && (
          <span style={SLOT.status}>{t.chat.lines(writeLines)}</span>
        )}
        {/* 有统计时「N lines」是同一量级的第二遍，让位 */}
        {summary !== null && !active && stats === null && writeLines === null && (
          <span
            style={failed ? { ...SLOT.status, color: "var(--color-danger)" } : SLOT.status}
          >
            {summary}
          </span>
        )}
        {/* 运行中 shell 的时钟（已跑多久 / 上限）与预计——「像卡死」的正解：让时间说话。
            active 已含「中断不算运行」（PR 168），被中断的 bash 这里拿不到时钟 */}
        {runClock !== null && <span style={SLOT.status}>{runClock}</span>}
        {runExpected !== null && <span style={SLOT.status}>{runExpected}</span>}
        {/* 已中断（无结果帧且永不回来）：静止的中性状态词——不再呼吸、不假装在跑 */}
        {interrupted && <span style={SLOT.status}>{t.chat.toolInterrupted}</span>}
        {/* shell 类的执行耗时（落定后显示）——慢命令不展开也讲清楚花在哪 */}
        {shellDuration !== null && <span style={SLOT.status}>{shellDuration}</span>}
        {/* B-1：read_task 的任务卡动作——「Open」跳到被读的 task（与侧栏点击同语义）。
            stopPropagation：这个按钮不是折叠开关。card 走 details 通路，模型看不见。 */}
        {taskCard !== null && (
          <button
            type="button"
            title={t.chat.openTaskCard(taskCard.title)}
            onClick={(event) => {
              event.stopPropagation();
              props.onOpenTask?.(taskCard.sessionId);
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              border: "none",
              background: "none",
              padding: 0,
              cursor: "pointer",
              ...SLOT.status,
              color: "var(--color-chat-link)",
            }}
          >
            {t.chat.open}
          </button>
        )}
      </CollapseRow>
      {/* 活尾预览：跑着的 shell 有流式输出时，折叠行下贴几行末尾——「它在动」
          不展开也看得见。与展开体同一个圆角虚线框（用户 2026-10-12：从开始显示
          活尾的那一刻起就该有框，无框的裸文本像渲染错误）；行也走展开体同一套
          排版（BODY_LINE + mono caption + lineHeight 1.6，容器只补纵向内边距），
          展开那一刻框里的文字不跳。 */}
      {tailPreview.length > 0 && (
        <div
          className="scroll"
          style={{
            ...EXPANDED_FRAME,
            display: "grid",
            minWidth: 0,
            padding: "var(--space-2) 0",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-sm)",
            lineHeight: "var(--line-height-code)",
          }}
        >
          {tailPreview.map((line, index) => (
            <div key={index} style={{ ...BODY_LINE, color: "var(--color-text-secondary)" }}>
              {line}
            </div>
          ))}
        </div>
      )}
      {open && expandable && diff !== null && <DiffView diff={diff} />}
      {open && expandable && diff === null && fileView !== null && (
        <FileContentView text={fileView.text} startLine={fileView.startLine} lang={fileLang} />
      )}
      {open && expandable && diff === null && fileView === null && (
        <PlainToolBody
          toolName={props.toolName}
          text={imagelessBody}
          failed={failed}
          live={live}
          images={toolImages}
        />
      )}
    </div>
  );
}

/**
 * `request_user_action` 的交接卡：agent 请用户去受管浏览器亲手做一步（登录、验证码、授权）。
 * 与派出卡同一个「离开卡」骨架（ExitCard）——两者都是「点了离开聊天区」。
 *
 * 等待中：三个动作——去浏览器完成（打开窗口、切到那个 tab）/ 完成了，继续 / 取消。
 * 窗口顶部也有同样的交还按钮：用户登录完人在浏览器里，就地交还，不必切回来找这张卡。
 * 结束后：状态写「已交还 / 已取消」（主进程写进 details，不解析给模型的文字）。
 */
function HandoffToolLine(props: {
  toolCallId: string;
  input: unknown;
  result: ToolTranscriptItem | undefined;
  interrupted: boolean;
}) {
  const t = useT();
  const [gone, setGone] = useState(false);
  const reason = toolCallSummary("request_user_action", props.input) ?? "";
  const outcome = handoffOutcome(props.result);
  // 已中断：请求从未发出（结果帧永远不来），不能再给「去完成 / 交还」的动作——
  // 那些按钮会去 resolve 一个不存在的交接；退成静止的中性状态卡
  if (props.interrupted && props.result === undefined) {
    return (
      <ExitCard
        kicker={t.browser.handoffKicker}
        icon="user"
        title={reason}
        status={{ text: t.chat.toolInterrupted, color: "var(--color-text-tertiary)", active: false }}
        preview={t.browser.handoffWhere}
      />
    );
  }
  const waiting = outcome === null && !gone;
  const status = waiting
    ? { text: t.browser.handoffWaiting, color: "var(--color-accent)", active: true }
    : outcome === "done"
      ? { text: t.browser.handoffHandedBack, color: "var(--color-success)", active: false }
      : { text: t.browser.handoffCancelled, color: "var(--color-text-tertiary)", active: false };
  const open = () => {
    void api.browser.showHandoff(props.toolCallId).then((live) => {
      if (!live) setGone(true);
    });
  };
  return (
    <ExitCard
      kicker={t.browser.handoffKicker}
      icon="user"
      title={reason}
      status={status}
      preview={gone && outcome === null ? t.browser.handoffGone : t.browser.handoffWhere}
      {...(waiting
        ? {
            actions: (
              <>
                <PanelButton onClick={open}>
                  <Icon name="arrow-up-right" size={13} /> {t.browser.handoffOpen}
                </PanelButton>
                <PanelButton onClick={() => void api.browser.resolveHandoff(props.toolCallId, "done")}>
                  <Icon name="check" size={13} /> {t.browser.handoffDone}
                </PanelButton>
                <PanelButton onClick={() => void api.browser.resolveHandoff(props.toolCallId, "cancelled")}>
                  {t.common.cancel}
                </PanelButton>
              </>
            ),
          }
        : {})}
    />
  );
}

/**
 * `delegate` 工具的折叠展示：派出卡而不是「调用 + 摘要」的通用骨架。
 * `taskPreview` 从 toolCall 的 input.task 取（running 帧也有——task 是入参，
 * 不必等结果），首行截断复用 `deriveSessionTitle` 的规则（会话标题同一套）。
 * `card` 为 null（running 帧，details 随终态帧来）时 `DelegateCardView` 自己
 * 显示「delegating…」，这里不用猜状态。
 */
function DelegateToolLine(props: {
  input: unknown;
  result: ToolTranscriptItem | undefined;
  interrupted: boolean;
  channel: ChannelViewContext;
}) {
  const card = delegateCard(props.result);
  const taskPreview = deriveSessionTitle(toolCallSummary("delegate", props.input) ?? "");
  if (card === null) {
    return (
      <DelegateCardView
        card={null}
        status="running"
        taskPreview={taskPreview}
        interrupted={props.interrupted}
      />
    );
  }
  const summary = props.channel.channelSummaries.get(card.childId);
  // 状态优先读通道摘要的终态（done/failed/waiting/stopped）；否则看子会话在 renderer
  // 会话槽里的 phase——不为 idle 就是还在跑（子会话 PR4a 的「状态从哪来」）。
  // stopped 不读的话，用户终止过的子会话在派出卡上会退回「空闲」（验收发现）
  const status: DelegateCardStatus =
    summary?.status === "done" ||
    summary?.status === "failed" ||
    summary?.status === "waiting" ||
    summary?.status === "stopped"
      ? summary.status
      : props.channel.childPhaseOf(card.childId) !== "idle"
        ? "running"
        : "idle";
  const openSubSession = props.channel.openSubSession;
  return (
    <DelegateCardView
      card={card}
      status={status}
      taskPreview={taskPreview}
      onClick={openSubSession === null ? undefined : () => openSubSession(card.childId)}
      lit={props.channel.litSubSessionId === card.childId}
    />
  );
}

/**
 * `reply_subsession` / `report_to_parent` 的发送侧标记行——与 `ChannelMarkLine`
 * 同一套胶囊语言，只是文案来源是这次工具调用的入参而不是一条 `ChannelMarkRecord`。
 * 入参不逐字段深校验（同 `toolCallSummary` 的纪律）：字段缺失就退回通用兜底文案，
 * 不抛错——折叠行画错一个词不碍事，编造字段才碍事。
 */
function ChannelSendToolLine(props: {
  toolName: "reply_subsession" | "report_to_parent";
  input: unknown;
  result: ToolTranscriptItem | undefined;
  running: boolean;
  interrupted: boolean;
  channel: ChannelViewContext;
}) {
  const t = useT();
  const record = typeof props.input === "object" && props.input !== null ? (props.input as Record<string, unknown>) : {};
  // 已中断：消息从未发出（结果帧永远不来）——不能按「已回复 / 已报告」的语气画
  // 成功胶囊，换成静止的中性中断行
  if (props.interrupted && props.result === undefined) {
    return (
      <ChannelToolMarkLine
        icon="circle-off"
        text={t.chat.toolInterrupted}
        tone="neutral"
        running={false}
      />
    );
  }
  // 面板删除后发送侧标记不再有「滚到某一条」的去处；reply_subsession 的点击改成
  // 打开右栏 Sub-sessions 面板进入该子会话（与派出卡 / 问询胶囊同一个入口）。
  const openSubSession = props.channel.openSubSession;
  if (props.toolName === "reply_subsession") {
    const childId = typeof record["childId"] === "string" ? record["childId"] : "";
    const childTitle = peerTitleOf(props.channel, childId, t);
    const followUp = record["delivery"] === "followUp";
    const text = followUp ? t.chat.repliedTurnEnd(childTitle) : t.chat.repliedSteer(childTitle);
    return (
      <ChannelToolMarkLine
        icon="undo-2"
        text={text}
        tone="reply"
        running={props.running}
        onClick={openSubSession !== null && childId !== "" ? () => openSubSession(childId) : undefined}
        clickTitle={t.subSessions.openInPanel}
      />
    );
  }
  // report_to_parent：对面恒是本会话自己的父——ownParentId 是这条会话固定的事实，
  // 不像 reply_subsession 那样按入参里的 id 变化。面板删除后不可点：它发给母会话
  // 的话就留在母会话的对话流里（问询胶囊），这里只留一行工具标记。
  const parentTitle = peerTitleOf(props.channel, props.channel.ownParentId ?? "", t);
  const kind = record["kind"];
  const label: { text: string; icon: IconName; tone: ChannelMarkTone } =
    kind === "question"
      ? { text: t.chat.askedParent(parentTitle), icon: "message-square", tone: "question" }
      : kind === "done"
        ? { text: t.chat.reportedDone, icon: "circle-check", tone: "done" }
        : kind === "failed"
          ? { text: t.chat.reportedFailed, icon: "triangle-alert", tone: "failed" }
          : { text: t.chat.reportedProgress, icon: "refresh-cw", tone: "neutral" };
  return (
    <ChannelToolMarkLine icon={label.icon} text={label.text} tone={label.tone} running={props.running} />
  );
}

/**
 * 同类工具的组：agent 连续做同类事（连读 N 个文件）时，组头「读取」声明在做什么。
 * **展开是时间态**：活跃期间成员常驻铺开（用户正看着的东西不能在眼前消失）；
 * 整轮落定**一次性收纳全部组**——无记忆（Q17b），手动展开的也折，用户可再点开。
 * 折叠态组头带 `× N`（成员可见时不显示）；组内有失败时组头换红色 triangle-alert
 * ——折了也不能让失败无声消失。组头亮暗呼吸跟随成员：任一还在跑 → 行首
 * secondary + 呼吸；**全部落定**才退到 tertiary。
 * 成员行与组头**同左缘**（不缩进）：折叠行的 icon 上下连成一条线，缩进会把线打断。
 */
function ToolGroupLine(props: {
  group: ToolGroupUnit;
  toolResults: ToolResultIndex;
  turnActive: boolean;
  /** 已中断的调用 id 集（interruptedToolCallIds）：组头不为它们呼吸，按「N 个已中断」计 */
  interruptedCalls: ReadonlySet<string>;
  onOpenTask?: (sessionId: string) => void;
  /** 子会话 PR4a：展开后的成员行仍是 ToolLine，同一份上下文原样转发 */
  channel: ChannelViewContext;
  /** 透传给成员 ToolLine（read SKILL.md 徽标用） */
  skills: SkillMeta[];
}) {
  const t = useT();
  const { group } = props;
  // 挂载时的相态决定初始展开：活跃轮里长出来的组铺开，idle 会话（旧历史）收着
  const [open, setOpen] = useState(props.turnActive);
  useEffect(() => {
    if (!props.turnActive) setOpen(false);
  }, [props.turnActive]);

  const status = toolGroupStatus(group.calls, props.toolResults, props.interruptedCalls);
  const active = status.running > 0;
  const failed = status.failed > 0;
  const fileCount = group.toolName === "edit" ? editGroupFileCount(group.calls, props.toolResults) : null;
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span style={{ color: failed ? "var(--color-danger)" : headIconColor(active) }}>
            <Icon
              name={failed ? "triangle-alert" : toolIcon(group.toolName)}
              size={14}
              strokeWidth={1.8}
            />
          </span>
          <span style={headLabel(active)}>{toolGroupLabel(group.toolName, t)}</span>
        </span>
        {!open && <span style={SLOT.status}>{toolGroupCountLabel(group.toolName, status.total, t)}</span>}
        {!open && group.toolName === "edit" && fileCount !== null && (
          <span style={SLOT.status}>{t.chat.files(fileCount)}</span>
        )}
        {!open && failed && (
          <span style={{ ...SLOT.status, color: "var(--color-danger)" }}>
            {t.chat.failedCount(status.failed)}
          </span>
        )}
        {/* 已中断（中性色）：这几次调用从未发生——折了也不能无声消失，但也不染红
            （不是失败，是没跑） */}
        {!open && status.interrupted > 0 && (
          <span style={SLOT.status}>{t.chat.interruptedCount(status.interrupted)}</span>
        )}
      </CollapseRow>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {group.calls.map((call) => (
            <ToolLine
              key={call.key}
              toolCallId={call.toolCallId}
              toolName={call.toolName}
              input={call.input}
              result={props.toolResults.get(call.toolCallId)}
              interrupted={props.interruptedCalls.has(call.toolCallId)}
              onOpenTask={props.onOpenTask}
              channel={props.channel}
              skills={props.skills}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * edit 的展开体：pi 的 details.diff 显示格式（VSCode 式两列：行号 | 正文）。
 * 增/上下文行带**新文档（当前文档）行号**、删行带旧文档行号；没有文件头、@@ 头
 * 与 `\ No newline` 噪音（文件名折叠行已经在说），长文件跳段是「...」行。
 * 增删的信号是**整行底色**（-soft token），没有 +/- 标记列——底色说了的事不重复说；
 * 相邻的「1 删 + 1 增」是单行修改，词级对比后真正变动的片段加实底色块
 * （pi TUI 的 inverse 在 DOM 里的等价物）。
 */
function DiffView(props: { diff: string }) {
  const entries = editDiffEntries(parseEditDiff(props.diff));
  return (
    <div
      style={{
        ...EXPANDED_FRAME,
        padding: "var(--space-2) 0",
      }}
    >
      <DiffBody entries={entries} maxHeight={320} />
    </div>
  );
}

/** 行号列（DiffView 与 FileContentView 共用）：右对齐等宽数字、细分隔线、褪色——只作定位不作内容 */
const LINE_NUM_COLUMN = {
  textAlign: "right",
  padding: "0 var(--space-2) 0 var(--space-1)",
  borderRight: "1px solid var(--color-border-subtle)",
  color: "var(--color-text-tertiary)",
  opacity: 0.7,
  fontVariantNumeric: "tabular-nums",
} satisfies React.CSSProperties;

/**
 * 文件内容视图（write 写入的正文）：行号列 + shiki 高亮正文，视觉语言与 DiffView
 * 同源（行号列右对齐褪色、正文列 pre-wrap）。语言推断不出或引擎未就绪时正文退纯色，
 * 行号列照常有——行号是定位工具不依赖语法。pi 的 write 也是调用阶段渲染正文，
 * 只是它无行号；成功后那行英文统计句两边都不再显示。
 */
function FileContentView(props: { text: string; startLine: number; lang: string | null }) {
  // shiki 就绪触发一次重渲（FenceBlock 同款）；之后缓存命中同步返回
  const [, setWarm] = useState(false);
  useEffect(() => {
    void highlighterReady.then(() => setWarm(true));
  }, []);
  // 文件以换行结尾时 split 出一个空的末行，框底多一行空白带行号（同 PlainToolBody 剥尾部空行）
  const text = stripTrailingBlankLines(props.text);
  const lines = props.lang !== null ? highlightLines(text, props.lang) : null;
  const rows: readonly (string | readonly TokenSpan[])[] = lines ?? text.split("\n");
  const lastLine = props.startLine + rows.length - 1;
  // 轨道 = 位数 + 行号格的横向内边距（不算 padding 的话三位数起就顶穿竖线挤进正文）
  const digits = Math.max(3, String(lastLine).length);
  const gutter = `calc(${digits}ch + var(--space-2) + var(--space-1))`;
  return (
    <div
      className="scroll"
      style={{
        display: "grid",
        gridTemplateColumns: `${gutter} 1fr`,
        maxHeight: 320,
        overflow: "auto",
        ...EXPANDED_FRAME,
        padding: "var(--space-2) 0",
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-sm)",
        lineHeight: "var(--line-height-code)",
      }}
    >
      {rows.flatMap((row, index) => [
        <span key={`${index}n`} style={LINE_NUM_COLUMN}>
          {props.startLine + index}
        </span>,
        <span
          key={`${index}b`}
          style={{
            padding: "0 var(--space-2)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            color: "var(--color-text-secondary)",
          }}
        >
          {typeof row === "string" ? row === "" ? " " : row : tokenSpans(row)}
        </span>,
      ])}
    </div>
  );
}

/** 高亮行 → token span 序列；shiki-tok 类挂暗主题切换（styles.css 的 --shiki-dark 翻色） */
function tokenSpans(line: readonly TokenSpan[]) {
  if (line.length === 0) return " ";
  return line.map((token, index) =>
    token.style === undefined ? (
      <span key={index}>{token.text}</span>
    ) : (
      <span key={index} className="shiki-tok" style={token.style as React.CSSProperties}>
        {token.text}
      </span>
    ),
  );
}

/**
 * 其余工具的展开体：逐行渲染的文本底座 + 工具级轻结构化——grep 的
 * 「path:行号: 正文」按匹配/上下文分两档（匹配正文 primary、上下文 secondary，
 * 前缀退成注脚），find / ls 的清单行把文件名亮出来（目录前缀退灰）。
 * 解析不出的行原样渲染，宁可不解析也不猜错。
 * **失败时整块退回原样行并染 danger**（折叠行的红 triangle 在这里续上），
 * 结构化只对成功结果做——错误文本长得不像清单，硬解析是猜。
 * `live` 是跑着的 shell：输出增长贴底跟随（用户上滚脱离、回底恢复），
 * 还没吐出第一个字时显示「等待输出」。
 */
/**
 * MCP 工具的展开体（4-5，规格 §8）：失败时首行讲清错在哪一层（业务失败是
 * server 报的错，传输失败是我们连不上/等不到）；成功时文本照常、图片内联
 * （max-height 240、--radius-md、发丝边框、mimeType 一行 xs）。
 * 相邻同名照常组折叠（组行不在这里，flatten 阶段已按 toolName 归组）。
 */
function McpToolBody(props: { result: ToolTranscriptItem | undefined }) {
  const t = useT();
  // 看大图：放在提前 return 之前（hook 顺序不能随 result 有无变）
  const [viewing, setViewing] = useState<number | null>(null);
  const { result } = props;
  if (result === undefined) return null;
  const isFailure = result.status === "error";
  const texts = result.content.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text");
  const images = result.content.filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image");
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        background: "var(--color-bg-panel)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        minWidth: 0,
      }}
    >
      {isFailure && (
        <p style={{ margin: 0, fontSize: "var(--font-size-sm)", color: "var(--color-danger)" }}>
          {mcpFailureLead(result, t)}
        </p>
      )}
      {texts.map((block, i) => (
        <pre
          key={i}
          style={{
            margin: 0,
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-sm)",
            lineHeight: "var(--line-height-code)",
            color: isFailure ? "var(--color-danger)" : "var(--color-text-primary)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {block.text}
        </pre>
      ))}
      {viewing !== null && <ImageLightbox images={images} startIndex={viewing} onClose={() => setViewing(null)} />}
      {images.map((block, i) => (
        <figure key={`img-${i}`} style={{ margin: 0, display: "grid", gap: 2, minWidth: 0 }}>
          <button
            type="button"
            aria-label={t.lightbox.open}
            onClick={() => setViewing(i)}
            style={{ ...ZOOM_BUTTON_STYLE, justifySelf: "start" }}
          >
            <img
              src={imageSrc(block)}
              alt=""
              style={{
                display: "block",
                maxWidth: "100%",
                maxHeight: 240,
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--color-border-subtle)",
              }}
            />
          </button>
          <figcaption
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-family-mono)",
            }}
          >
            {block.mimeType}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
/**
 * show_image 的合并画廊（2026-09-27 裁决：正文前多个图片收进**一个**画廊窗口水平
 * 滑动）。相邻的非失败 show_image 由渲染循环收集成组交给这里；组内各卡的图片拼成
 * 一条横滑带，行标识报总张数，点开 Lightbox；组内单图退化大图形态。跑动中卡片
 * 未落（details 随终态帧来）时行标识以省略号占位。
 */
const GALLERY_THUMB_SIZE = 120;

function ShowImageGalleryGroup(props: { cards: ShowImageCardView[] }) {
  const t = useT();
  const [viewing, setViewing] = useState<number | null>(null);
  const images = props.cards.flatMap((card) => card.images);
  const total = images.length;
  const lightboxImages = images.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
  return (
    <div style={{ display: "grid", gap: "var(--space-2)", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <Icon name="image" size={13} strokeWidth={1.8} style={{ flex: "0 0 auto" }} />
        <span
          style={{
            fontSize: "var(--font-size-sm)",
            fontFamily: "var(--font-family-mono)",
            color: "var(--color-text-secondary)",
          }}
        >
          {/* 组首自己还在跑（卡片未落）时组是空的——省略号占位，别显示「0 张图片」 */}
          {props.cards.length === 0 ? "…" : t.chat.images(total)}
        </span>
      </div>
      {total === 1 ? (
        images.map((img, i) => (
          <figure key={`show-${i}`} style={{ margin: 0, display: "grid", gap: 2, minWidth: 0 }}>
            <button
              type="button"
              aria-label={t.lightbox.open}
              onClick={() => setViewing(i)}
              style={{ ...ZOOM_BUTTON_STYLE, justifySelf: "start" }}
            >
              <img
                src={imageSrc({ type: "image", data: img.data, mimeType: img.mimeType })}
                alt={img.name}
                style={{
                  display: "block",
                  maxWidth: "100%",
                  maxHeight: 320,
                  objectFit: "contain",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border-subtle)",
                  background: "var(--color-bg-panel)",
                }}
              />
            </button>
            <figcaption
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-tertiary)",
                fontFamily: "var(--font-family-mono)",
                overflowWrap: "anywhere",
              }}
            >
              {img.name}
            </figcaption>
          </figure>
        ))
      ) : (
        // 多图：与 composer 附图同一张卡（方形裁切 + 单行文件名），顶端对齐，横向滑动
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--space-3)",
            overflowX: "auto",
            padding: "var(--space-1) 0",
            minWidth: 0,
          }}
        >
          {images.map((img, i) => (
            <ImageThumb
              key={`show-${i}`}
              src={imageSrc({ type: "image", data: img.data, mimeType: img.mimeType })}
              name={img.name}
              size={GALLERY_THUMB_SIZE}
              openLabel={t.lightbox.open}
              onOpen={() => setViewing(i)}
              caption
            />
          ))}
        </div>
      )}
      {viewing !== null && (
        <ImageLightbox images={lightboxImages} startIndex={viewing} onClose={() => setViewing(null)} />
      )}
    </div>
  );
}

function PlainToolBody(props: {
  toolName: string;
  text: string;
  failed: boolean;
  live?: boolean;
  images?: readonly { type: "image"; data: string; mimeType: string }[];
}) {
  const t = useT();
  const follow = useFollowScroll(props.live === true);
  // shell 输出几乎总以 \n 结尾，拆行后末尾多一个空行——以前没有下边框看不出来，
  // 套了圆角虚线框后框底会多出一整行空白（2026-10-12 返工），渲染前剥掉尾部空行。
  // 中间的空行是内容结构，保留。
  const text = stripTrailingBlankLines(props.text);
  // 读时投影：展开体是 320px 的滚动区，几万字的工具结果全进 DOM 只是重量。
  // 首尾各留一段（阈值与依据见 tool-body-clamp.ts），会话记录不动。
  const clamped = clampToolBody(text);
  // 截断提示行：切口处的一行次级灰 caption——它是标点不是内容（行几何同 BODY_LINE，
  // 字号退到 xs）。数字是**原文**总量，不是保留量。
  const truncationNote =
    clamped.omitted === null ? null : (
      <div style={TRUNCATION_NOTE}>
        {t.chat.bodyTruncated(clamped.omitted.lines, clamped.omitted.chars)}
      </div>
    );
  // 看大图：放在提前 return 之前（hook 顺序不能随内容变）
  const [viewing, setViewing] = useState<number | null>(null);
  const images = props.images ?? [];
  const imageStrip =
    images.length > 0 ? (
      <div style={{ display: "grid", gap: "var(--space-2)", padding: "var(--space-2) 0 var(--space-2) var(--space-2)" }}>
        {viewing !== null && <ImageLightbox images={images} startIndex={viewing} onClose={() => setViewing(null)} />}
        {images.map((block, i) => (
          <figure key={`toolimg-${i}`} style={{ margin: 0, display: "grid", gap: 2, minWidth: 0 }}>
            <button
              type="button"
              aria-label={t.lightbox.open}
              onClick={() => setViewing(i)}
              style={{ ...ZOOM_BUTTON_STYLE, justifySelf: "start" }}
            >
              <img
                src={imageSrc(block)}
                alt=""
                style={{
                  display: "block",
                  maxWidth: "100%",
                  maxHeight: 240,
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--color-border-subtle)",
                }}
              />
            </button>
            <figcaption
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-tertiary)",
                fontFamily: "var(--font-family-mono)",
              }}
            >
              {block.mimeType}
            </figcaption>
          </figure>
        ))}
      </div>
    ) : null;
  if (text === "" && images.length === 0) {
    return (
      <div
        className="scroll"
        style={{
          ...PLAIN_BODY,
          color: "var(--color-text-secondary)",
          padding: "var(--space-2)",
        }}
      >
        {props.live === true ? t.chat.waitingOutput : t.chat.noOutput}
      </div>
    );
  }
  if (props.failed) {
    return (
      <div ref={follow.ref} onScroll={follow.onScroll} className="scroll" style={PLAIN_BODY}>
        {clamped.head.map((line, index) => (
          <div key={index} style={{ ...BODY_LINE, color: "var(--color-danger)" }}>
            {line === "" ? " " : line}
          </div>
        ))}
        {truncationNote}
        {clamped.tail.map((line, index) => (
          <div key={`tail-${index}`} style={{ ...BODY_LINE, color: "var(--color-danger)" }}>
            {line === "" ? " " : line}
          </div>
        ))}
        {imageStrip}
      </div>
    );
  }
  return (
    <div ref={follow.ref} onScroll={follow.onScroll} className="scroll" style={PLAIN_BODY}>
      {clamped.head.map((line, index) => toolBodyLine(props.toolName, line, index))}
      {truncationNote}
      {clamped.tail.map((line, index) => toolBodyLine(props.toolName, line, clamped.head.length + index))}
      {imageStrip}
    </div>
  );
}

/** 展开体滚动容器的共用形态（无水平内边距——行自带）；套圆角虚线框，同 EXPANDED_BODY。 */
const PLAIN_BODY = {
  ...EXPANDED_FRAME,
  maxHeight: 320,
  overflow: "auto",
  padding: "var(--space-2) 0",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-sm)",
  lineHeight: "var(--line-height-code)",
} satisfies React.CSSProperties;

const BODY_LINE = {
  padding: "0 var(--space-2)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} satisfies React.CSSProperties;

/** 截断提示行：BODY_LINE 的行几何 + 次级灰 caption（设计系统 xs）——它是标点不是内容。 */
const TRUNCATION_NOTE = {
  ...BODY_LINE,
  color: "var(--color-text-tertiary)",
  fontSize: "var(--font-size-xs)",
} satisfies React.CSSProperties;

/** 单行按工具着色；工具没有专门形态的走 secondary 原样行（无结构正文的内容基线） */
function toolBodyLine(toolName: string, line: string, key: number): ReactNode {
  if (toolName === "grep") {
    const parsed = parseGrepLine(line);
    if (parsed !== null) {
      const separator = parsed.kind === "match" ? ":" : "-";
      return (
        <div key={key} style={BODY_LINE}>
          <span style={{ color: "var(--color-text-tertiary)" }}>
            {parsed.path}
            {separator}
            {parsed.lineNum}
            {separator}{" "}
          </span>
          <span
            style={{
              color:
                parsed.kind === "match"
                  ? "var(--color-text-primary)"
                  : "var(--color-text-secondary)",
            }}
          >
            {parsed.text === "" ? " " : parsed.text}
          </span>
        </div>
      );
    }
  }
  if (toolName === "find" || toolName === "ls") {
    const { dir, name } = splitPathTail(line);
    return (
      <div key={key} style={BODY_LINE}>
        {dir !== "" && <span style={{ color: "var(--color-text-secondary)" }}>{dir}</span>}
        <span style={{ color: "var(--color-chat-link)" }}>{name === "" ? " " : name}</span>
      </div>
    );
  }
  return (
    <div key={key} style={{ ...BODY_LINE, color: "var(--color-text-secondary)" }}>
      {line === "" ? " " : line}
    </div>
  );
}

/** 记忆行的数据：气泡 id → 那一轮的账。 */
interface MemoryLines {
  rows: ReadonlyMap<string, MemorySessionTurnView>;
}

/**
 * 记忆行（实验功能 memory-system）：挂在「从这一轮记住了东西」的用户气泡下，只说
 * 记住了什么——确认系统在记、记得对不对（用户 2026-10-29：「我只需要知道，有在
 * 记录记忆，记得对……其他的我不需要感知到」）。这一轮用到了哪些记忆是输入，去
 * 上下文面板看；「整理中」不在对话里出现，也没有待确认（agent 判断直接生效）。
 * 与思考 / 工具行同一份 CollapseRow 契约；改 / 删 / 别再用去审查面板的记忆页签。
 */
function MemoryLine(props: { row: MemorySessionTurnView; onOpenReview?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { row } = props;
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0, marginTop: "var(--space-4)" }}>
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        <span style={HEAD_WRAP}>
          <span style={{ color: headIconColor(false) }}>
            <Icon name="brain-circuit" size={14} strokeWidth={1.8} />
          </span>
          <span style={headLabel(false)}>{t.memory.rowLabel}</span>
        </span>
        <span style={{ ...SLOT.sub, fontFamily: "var(--font-family-base)" }}>
          {t.memory.rowRemembered(row.remembered.length)}
        </span>
      </CollapseRow>
      {open && (
        <div style={{ ...EXPANDED_BODY, fontFamily: "var(--font-family-base)", whiteSpace: "normal", display: "grid", gap: "var(--space-1)" }}>
          {row.remembered.map((item) => (
            <span key={item.entry.id} style={{ color: "var(--color-text-primary)" }}>
              {item.entry.text}
            </span>
          ))}
          {props.onOpenReview !== undefined && (
            <button type="button" className="mem-link" onClick={props.onOpenReview}>
              {t.memory.openReview}
              <Icon name="arrow-right" size={12} strokeWidth={1.8} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 思考行：brain 图标（进行中保持 info 蓝——全转写里唯一的蓝记号）+「思考」
 * label + 副标。副标是时间态：**流式中**是活尾预览（新的一行顶替上一行）；
 * **落定**换成秒数（`3s`，现场计时，重开的旧会话量不到就什么都不显示）。
 * 行首呼吸同其它过程行：进行中 secondary + 呼吸，写完呼吸与高亮一起消失。
 * 要看全文点开，展开体 160px 封顶滚动；**流式中展开会贴底跟随**（上滚脱离、
 * 回底恢复），落定后内容定格，跟随停止。
 */
function ThinkingLine(props: { text: string; active: boolean; blockKey: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { active } = props;
  const body = props.text.trim();
  const follow = useFollowScroll(active);
  const duration = thinkingDurationText(props.blockKey, active, t);
  const preview = active ? thinkingPreview(body) : "";
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span style={{ color: active ? "var(--color-info)" : headIconColor(active) }}>
            <Icon name="brain" size={14} strokeWidth={1.8} />
          </span>
          <span style={headLabel(active)}>{t.chat.thinking}</span>
        </span>
        {/* 展开时预览让位——正文已经是更全的信息，同一行不必再放一遍尾巴 */}
        {active && !open && preview !== "" && <span style={SLOT.sub}>{preview}</span>}
        {!active && duration !== null && <span style={SLOT.sub}>{duration}</span>}
      </CollapseRow>
      {open && body !== "" && (
        <div
          ref={follow.ref}
          onScroll={follow.onScroll}
          className="scroll"
          style={{
            ...EXPANDED_BODY,
            color: "var(--color-text-tertiary)",
            maxHeight: 160,
          }}
        >
          {body}
        </div>
      )}
    </div>
  );
}

/**
 * 压缩界碑行：折叠时一行（Compacted + token 数变化），点开看摘要全文。
 * 头部与工具/思考行同一份 CollapseRow 契约（32px 热区、hover、三槽）；无图标——
 * archive 与侧栏「归档」撞车，文字本身已足够指认。label 是落定时间态（headLabel(false)），
 * 界碑永远不是「正在进行的事」，没有呼吸。
 * 界碑语义由外层 wrapper 承担：上方一条 hairline + 多留一倍间距——「分段，
 * 不是上一轮回复的一部分」，不随壳统一抹掉。
 * 展开体 320px 封顶（摘要值得读，但也不许顶走输入卡）；摘要是 markdown——
 * 走 MarkdownBlock 与 agent 回复同一套渲染，容器用 MARKDOWN_EXPANDED_BODY。
 */
function CompactedLine(props: { record: CompactedRecord }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-1)",
        minWidth: 0,
        marginTop: "var(--space-4)",
        borderTop: "1px solid var(--color-border-subtle)",
        paddingTop: "var(--space-3)",
      }}
    >
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        <span style={HEAD_WRAP}>
          <span style={headLabel(false)}>{t.chat.compacted}</span>
        </span>
        <span style={SLOT.status}>{compactionBoundaryStatus(props.record, t)}</span>
      </CollapseRow>
      {open && (
        <div className="scroll" style={MARKDOWN_EXPANDED_BODY}>
          <MarkdownBlock text={props.record.summary} />
        </div>
      )}
    </div>
  );
}

function Responding(props: { transcript: readonly TranscriptItem[] }) {
  const t = useT();
  const { transcript } = props;
  // 秒针：Responding 只在回答期间挂载，一秒一跳不白算（Retrying 同款）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // 耗时：本轮用户发话至今——「agent 回答了多久」是人感知的那段时间
  let userTs: number | null = null;
  for (const item of transcript) {
    if (item.role === "user") userTs = item.timestamp;
  }
  const elapsed = userTs !== null ? formatThinkingDuration(Math.max(0, now - userTs), t) : null;
  // 流式速度：in-flight 的字符估算（estimateStreamingTokens，英文校准的粗账——
  // 中文会低估数倍，落定即被回答旁的真值顶替）÷ 本条消息已生成的秒数
  let speedText: string | null = null;
  const streaming = transcript.at(-1);
  if (streaming !== undefined && streaming.role === "assistant" && streaming.status === "streaming") {
    const chars = streaming.content.reduce(
      (sum, block) =>
        sum + (block.type === "text" ? block.text.length : block.type === "thinking" ? block.thinking.length : 0),
      0,
    );
    const start = streamingStart(streaming.id);
    const speed = start !== null ? messageSpeed(now - start, estimateStreamingTokens(chars)) : null;
    if (speed !== null) speedText = formatSpeed(speed, t);
  }
  return (
    <p
      className="orbita-breath"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "fit-content",
        margin: 0,
        color: "var(--color-text-secondary)",
        fontSize: "var(--font-size-base)",
      }}
    >
      <span style={{ display: "inline-flex", color: "var(--color-warning)" }}>
        <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
      </span>
      {t.chat.responding}
      {elapsed !== null && <span>· {elapsed}</span>}
      {speedText !== null && (
        <span
          style={{
            fontFamily: "var(--font-family-business)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          · {speedText}
        </span>
      )}
    </p>
  );
}

/**
 * 压缩进行态：转录末尾、内容列内居中的一行，整体呼吸（styles.css 的 orbita-breath）。
 * 图标旋转表示「在干活」，整行呼吸表示「后台维护中，别急」——两层信号叠在一起
 * （旋转与呼吸都是设计系统 Motion 段认可的持续动效）。完成后本行卸载，界碑按时间落进流里。
 */
function Compacting() {
  const t = useT();
  return (
    <p
      className="orbita-breath"
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: 0,
        color: "var(--color-text-secondary)",
        fontSize: "var(--font-size-base)",
      }}
    >
      <span style={{ display: "inline-flex", color: "var(--color-warning)" }}>
        <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
      </span>
      {t.chat.compacting}
    </p>
  );
}

/**
 * 自动重试进行态：转录末尾一行（重试等待中替换 Responding），或压缩行下的居中补充行
 * （摘要调用的重试）。倒数是活的——挂载期间每秒重算，锚点在 agent 进程盖的 startedAt
 * 上，切走再切回不重启。视觉语法与 Responding / Compacting 同一套（呼吸 + 旋转 +
 * warning 图标），失败原因是最淡一档的注脚、悬停看全文——断网还是限流一眼可辨。
 */
function Retrying(props: { status: RetryStatus }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const cause = retryCauseText(props.status.errorMessage);
  return (
    <p
      className="orbita-breath"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "fit-content",
        maxWidth: "100%",
        margin: 0,
        color: "var(--color-text-secondary)",
        fontSize: "var(--font-size-base)",
      }}
    >
      <span style={{ display: "inline-flex", color: "var(--color-warning)" }}>
        <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
      </span>
      {retryLineText(props.status, now, t)}
      {cause !== null && (
        <span
          title={props.status.errorMessage}
          style={{
            color: "var(--color-text-tertiary)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {cause}
        </span>
      )}
    </p>
  );
}

/**
 * 提示行：文字是主信号，颜色是第二信号。样式口径见 notice.ts（文字断行 / 图标挂在血线外）。
 * 阻塞类提示带一个**出口**（exit）：句尾一个文字按钮，说下一步去哪——只说「不行」
 * 不说往哪走，读的人只能自己找（2026-10-29 精装第六笔）。
 */
function Notice(props: {
  tone?: "bad";
  /** 挂在血线外的图标；bad 档缺省 triangle-alert */
  icon?: IconName;
  exit?: { label: string; onClick: () => void } | undefined;
  children: React.ReactNode;
}) {
  const icon = props.icon ?? (props.tone === "bad" ? "triangle-alert" : undefined);
  return (
    <p
      role={props.tone === "bad" ? "alert" : undefined}
      style={noticeParagraphStyle(props.tone === "bad")}
    >
      {icon !== undefined && (
        <span style={noticeIconBoxStyle}>
          <Icon name={icon} size={12} strokeWidth={1.8} />
        </span>
      )}
      <span style={noticeTextStyle}>
        {props.children}
        {props.exit !== undefined && (
          <button type="button" className="notice-exit" onClick={props.exit.onClick}>
            {props.exit.label}
          </button>
        )}
      </span>
    </p>
  );
}

/**
 * 正文区的状态行（空会话提示 / 历史恢复加载）：居中一行 tertiary，
 * 唯一的动效是 loader 的旋转（设计系统：continuous motion 只有 rotation 与 breathing）。
 */
function StatusLine(props: { children: React.ReactNode; spin?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-2)",
        width: "100%",
        padding: "var(--space-4) 0",
        color: "var(--color-text-tertiary)",
        fontSize: "var(--font-size-sm)",
      }}
    >
      {props.spin === true && (
        <span style={{ display: "inline-flex", flex: "0 0 auto" }}>
          <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
        </span>
      )}
      {props.children}
    </div>
  );
}

/**
 * 还没落盘那条会话的标题：第一条用户消息的第一行。落盘之后以 `meta.title` 为准。
 * **截断规则走 shared 的 `deriveSessionTitle`**——主进程落盘时用的是同一条，
 * 两边不一致的话同一条会话会在侧栏和标题栏显示两个名字。
 */
function sessionTitle(transcript: readonly TranscriptItem[]): string | null {
  for (const item of transcript) {
    if (item.role !== "user") continue;
    for (const block of item.content) {
      if (block.type !== "text") continue;
      const title = deriveSessionTitle(block.text);
      if (title !== "") return title;
    }
  }
  return null;
}
