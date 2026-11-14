import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { QuoteToolbar, type QuoteCandidate } from "../../shell/QuoteToolbar";
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
import { HOME_CARD_QUERY_ROWS, homeCardLine, selectHomeCards, selectHomeLog, type HomeCardLineText } from "./home-cards";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import { relativeTime } from "../../shell/relative-time.ts";
import { InlineMarks } from "../../shell/InlineMarks";
import { isAtBottom, isBeyondScrollDown, shouldJumpToEnd, shouldLoadOlder } from "./scroll.ts";
import { shouldInterceptSelectAll, transcriptCopyText } from "./transcript-copy.ts";
// 显式跟随态（Latest | Reading）：用户意图捕获与钉底判定全在这个纯模块里，聊天面只接线
import {
  createFollowTracker,
  forceFollowLatest,
  forceReading,
  isFollowing,
  isScrollbarPointer,
  mayPinToBottom,
  noteFollowIntent,
  noteFollowJump,
  noteFollowScroll,
  notePinnedScroll,
  scrollIntentDirection,
  type FollowTracker,
} from "./scroll-follow.ts";
// 历史段 / 实时尾段的切分与派生复用（纯模块，可与整段一次性计算等价）
import { deriveHistorySegment, type HistoryCache } from "./history-segment.ts";
import { splitAtLastUser } from "./transcript-split.ts";
import { readFoldState, writeFoldState } from "./fold-state.ts";
// 历史段虚拟化：行过滤 / 下标映射 / 高度 LRU / 锚点换算（纯模块）
import {
  createHeightCache,
  createRowHeightEstimator,
  DEFAULT_ROW_ESTIMATE,
  estimateRowHeight,
  messageRowIndex,
  prependAnchorTarget,
  rowIndexByKey,
  viewRowIndex,
  virtualHistoryRows,
  type HeightCache,
  type RowHeightEstimator,
  type VirtualHistoryRow,
} from "./virtual-history.ts";
import { bubbleClampStyle, isBubbleOverflowing } from "./user-bubble-clamp.ts";
import { EXPANDED_FRAME, RAIL_X } from "./expanded-body.ts";
import { clampToolBody } from "./tool-body-clamp.ts";
import { noticeIconBoxStyle, noticeParagraphStyle, noticeTextStyle } from "./notice.ts";
import { PluginInstallLine } from "../plugins/PluginInstallLine.tsx";
import { PluginBoardResultView } from "../board/PluginBoardResult.tsx";
import { builtinCommand, type DetailRow, docEditLabel, docEditPath, docEditSection, docEditSummary, toolWord } from "./builtin-commands.ts";
import { getOpenDocumentText } from "../doc-panel/open-document.ts";
import { CommandCard } from "./CommandCard.tsx";
import { ExitCard } from "./ExitCard";
import { PanelButton } from "../../shell/RightPanel";
import { ProcessViewContext } from "./process-view-context";
import { sessionRunState, type SessionRunState } from "../notify/completion-notice.ts";
import { REVEAL_ENTRY_EVENT } from "../context/task-progress.ts";
import { planAwaitingIn, planNoticeOf, planTimeline, type PlanTimeline, type PlanVersion } from "../context/plan-timeline.ts";
import { PlanCard } from "./PlanCard";
import { goalNoticeText, planNoticeText } from "../context/plan-text.ts";
import { useGoalLedger } from "../context/useGoalLedger.ts";
import { GOAL_TOOL_NAME } from "../../../../shared/goal.ts";
import type { GoalLedger } from "../../../../shared/goal-ledger.ts";
import { PLAN_TOOL_NAME } from "../../../../shared/plan.ts";
import {
  CHAPTER_STEPS_SHOWN,
  processOutcome,
  SLOW_GAP_MS,
  TAIL_AFTER_MS,
  processChapters,
  processCounts,
  processCalls,
  processLive,
  type ProcessChapter,
} from "./turn-process.ts";
import {
  branchAnchorEntries,
  branchAnchorIds,
  answerText,
  delegateCard,
  pluginBoardOf,
  pluginInstallRowOf,
  automationModeRowOf,
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
  // bash 活行：交还会话的认领、事实槽与秒针外推
  bashLiveFacts,
  bashLiveSeconds,
  bashLostFacts,
  bashResultFacts,
  bashResultOf,
  detachedBashNotice,
  formatSessionClock,
  showsCallSummary,
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
  toolCallSummaryForRow,
  toolDurationText,
  toolExpandable,
  toolGroupStatus,
  toolResultText,
  rollupLead,
  scanAnswerCards,
  streamingRecordIds,
  turnAssistantRecords,
  turnStats,
  type ProcessStep,
  type ScanAnswerCard,
  type TurnProcessUnit,
  writeLineCount,
  type ChannelMarkTone,
  type IntraToken,
  type RenderEntry,
  type ToolGroupUnit,
  type ToolResultIndex,
  type TurnGroupUnit,
  type TurnViewEntry,
} from "./tool-results";
import { useToday } from "./today.ts";
import { formatMessageTime, fullTimestamp } from "./message-time.ts";
import { highlighterReady, highlightLines, langFromPath, type TokenSpan } from "./highlight";
import { Composer } from "../../shell/Composer";
import {
  insertToken,
  type TokenPickResult,
} from "../../shell/panel-token.ts";
import { SessionCard } from "../../shell/SessionCard";
import { Chip } from "../../shell/Chip";
import { Menu, menuFooterRowStyle, type MenuItem } from "../../shell/Menu";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { InlineName } from "../../shell/InlineName";
import { IconButton } from "../../shell/IconButton";
import { Icon, type IconName } from "../../shell/Icon";
import { MarkdownBlock } from "./MarkdownBlock";
import { HomeHero } from "./HomeHero";
import { HomeLog, type HomeLogRowView } from "./HomeLog";
import { heroFace } from "./home-hero.ts";
import { WrapupCard } from "./WrapupCard";
import { useExperimentalFeature } from "../../experimental.ts";
import { FileTurnCard, RevertMarkView } from "./FileTurnCard";
import type { MemorySessionTurnView, MemorySessionView } from "@shared/memory";
import { useMemorySession } from "../memory/useMemory.ts";
import { liveRemembered, pairMemoryTurns } from "../memory/memory-view.ts";
import "../memory/memory.css";
import { DiffBody } from "../../shell/DiffView";
import { RevertPreviewBar } from "./RevertPreviewBar";
import { collectCitations } from "./citation-markers.ts";
import { CitationTableContext } from "./citation-context.ts";
import { RevertPreviewContext, type RevertPreview } from "./revert-preview.ts";
import { CarryoverScanCard } from "./CarryoverScanCard";
import { AutomationModeLine } from "../automation/AutomationModeLine";
import { AutomationRunBar } from "../automation/AutomationRunBar";
import { AutomationToolLine } from "../automation/AutomationToolLine";
import { AutomationWakeLine } from "../automation/AutomationWakeLine";
import { useAutomationRunSessions } from "../automation/automation-context.ts";
import { parseAutomationHeader } from "../../../../shared/automation.ts";
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
  type SessionMeta,
  type TranscriptRecord,
} from "@shared/session";
import type { FileTurnView, RevertRecord, UndoRecord } from "@shared/revert";
import type { RetryStatus } from "@shared/agent-ipc";
import { detachedNoticeIsLive, type BashSessionsSnapshot } from "@shared/bash-session";
import type { ChatSession } from "./useChatSession";
import type { ModelPair, ThemePreference } from "@shared/settings";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { scopeChipAction } from "./scope-chip.ts";

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
  const [candidate, setCandidate] = useState<QuoteCandidate | null>(null);
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

  const dismiss = useCallback(() => setCandidate(null), []);
  const clearSelection = useCallback(() => window.getSelection()?.removeAllRanges(), []);
  if (candidate === null) return null;
  return (
    <QuoteToolbar
      candidate={candidate}
      onDismiss={dismiss}
      onClearSelection={clearSelection}
      {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
      {...(props.onExcerpt === undefined ? {} : { onExcerpt: props.onExcerpt })}
    />
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
  // 插件里的技能也要认：read 它的 SKILL.md 同样标成「在用 skill」
  const reload = useCallback(() => {
    void Promise.all([api.skill.list(), api.plugin.skills().catch((): SkillMeta[] => [])])
      .then(([own, fromPlugins]) => setSkills([...own, ...fromPlugins]))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { skills };
}

/*
 * 右栏选取回执的消费水位（模块级）：只有主槽的 ChatView 拿
 * tokenPickResult，不会串合；但主槽会在设置页来回切时重挂——
 * 实例 ref 会归零，旧回执被重放、token 插两遍。水位放模块级，重挂也记得
 * 消费过哪一条。
 */
let consumedPickNonce = 0;

/** 主槽输入框（选取回执的插入目标）：面板 / 抽屉里的 Composer 不算 */
const mainComposerTextarea = (): HTMLTextAreaElement | null =>
  document.querySelector<HTMLTextAreaElement>(".pane-main textarea.composer-input");

/**
 * 剪贴板回退（L3d）：`navigator.clipboard` 不可用或被拒时，用隐藏 textarea +
 * `execCommand("copy")` 再试一次。textarea 放在视口外、不参与布局，复制完把焦点还给
 * 原来的元素（成功路径不碰焦点）。
 */
function execCommandCopy(text: string): boolean {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  previous?.focus({ preventScroll: true });
  return copied;
}

/** 写剪贴板：先走标准 API，失败退回 execCommand；返回是否真的写进去了 */
async function writeClipboardText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (clipboard !== undefined) {
      await clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒 / 没有安全上下文：落到 execCommand 回退
  }
  return execCommandCopy(text);
}

/**
 * 历史段虚拟器向滚动层（ChatViewBody）暴露的最小接口。滚动容器与跟随态在父组件，
 * 历史段派生与行映射在 TranscriptColumn；两者只通过这个接口交接「首个可见行」
 * 与前插锚点，不互传虚拟器实例。
 */
interface HistoryVirtualController {
  /** 引用跳转：按消息 id 找行；不在已加载窗口里先翻页 */
  jumpToMessage(messageId: string): void;
  /** 触顶前一瞬的首个可见行（key + 行顶相对视口偏移）；历史段为空时 null */
  captureAnchor(scrollTop: number): { key: string; offsetTop: number } | null;
  /** 前插后同一 key 的新坐标反算出的目标 scrollTop；行已被过滤/找不到时 null */
  scrollTopForAnchor(key: string, offsetTop: number): number | null;
}

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
  /** 意图系统（实验功能）：新会话的召回默认（settings.intent.newSessionOn 已解缺省）。
   *  可选：副槽（抽屉 / 子会话面板）不传——那里不出开关 */
  intentNewSessionDefault?: boolean;
  /**
   * 传 true：对话卡不再有页头。主槽（2026-10-19 方案 B v2，会话信息住工具栏的会话
   * 胶囊）与辅助对话（2026-11-07，会话名 / 标签住右栏胶囊 DrawerCap）都传；
   * 子会话面板不传，那里的 ChatView 保留卡内标题行。
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

  // 跟随态（pi 的 followingEnd 语义）：贴底时内容增长钉住底部；用户上滚脱离，滚回底部恢复。
  // 用 ref 不用 state——没有 UI 依赖它，不值得为每次滚动触发重渲染。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // 已加载的往来记录（复制用）：与 TranscriptColumn 的 records 里 user/assistant 子集
  // 完全一致（侧记录压缩界碑 / 通道标记 / 轮尾账都会被 transcriptCopyText 跳过）。
  // 用 ref 传值：流式期间 transcript 逐帧换引用，不能因此每帧重挂 window 监听。
  const copySourceRef = useRef(session.transcript);
  copySourceRef.current = session.transcript;
  // —— 整段复制（L3d）——
  // 虚拟化只挂载视口附近的行，跨页拖选拿不到 DOM；Ctrl/Cmd+A 改为从已加载的记录
  // 拼纯文本写剪贴板。监听挂 window 捕获：点正文后焦点常落在 body，挂在滚动容器上
  // 收不到这次按键。多个会话面同时开着时，只有焦点/选区在自己转录里的那个会接管。
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const copyNoticeTimerRef = useRef<number | undefined>(undefined);
  const showCopyNotice = useCallback((text: string) => {
    setCopyNotice(text);
    window.clearTimeout(copyNoticeTimerRef.current);
    copyNoticeTimerRef.current = window.setTimeout(() => {
      copyNoticeTimerRef.current = undefined;
      setCopyNotice(null);
    }, 1500);
  }, []);
  useEffect(() => () => window.clearTimeout(copyNoticeTimerRef.current), []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const el = scrollRef.current;
      if (el === null) return;
      const active = document.activeElement;
      const selection = document.getSelection();
      const inTranscript =
        (active !== null && el.contains(active)) ||
        (selection !== null &&
          ((selection.anchorNode !== null && el.contains(selection.anchorNode)) ||
            (selection.focusNode !== null && el.contains(selection.focusNode))));
      const focus = {
        tagName: active instanceof HTMLElement ? active.tagName : "",
        isContentEditable: active instanceof HTMLElement ? active.isContentEditable : false,
        inTranscript,
      };
      if (!shouldInterceptSelectAll(event, focus)) return;
      const text = transcriptCopyText(copySourceRef.current);
      // 空文本不复制，也不挡原生全选（新任务还没有记录）
      if (text === "") return;
      event.preventDefault();
      void writeClipboardText(text).then((copied) => {
        showCopyNotice(
          copied
            ? t.chat.transcriptCopied(Array.from(text).length)
            : t.chat.transcriptCopyFailed,
        );
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [showCopyNotice, t]);
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

  // —— 历史段虚拟化的跨组件引用 ——
  // 虚拟器住在 TranscriptColumn（它拿得到历史段派生与行数组）；滚动 / 分页锚定在
  // ChatViewBody（它拿得到滚动容器与跟随态）。控制器由子组件每次渲染写入，父组件在
  // 事件与布局 effect 里调用——两边都不需要把虚拟器实例当 prop 传。
  const historyControllerRef = useRef<HistoryVirtualController | null>(null);
  /** 前插锚点落定窗口：窗口内虚拟器的逐行补偿关闭，由按 key 的重算统一接管 */
  const pageSettleRef = useRef<{ key: string; offsetTop: number; until: number } | null>(null);

  const jumpToMessage = useCallback((messageId: string) => {
    const controller = historyControllerRef.current;
    if (controller !== null) {
      controller.jumpToMessage(messageId);
      return;
    }
    // 列还没挂载（极少）：只查当前 DOM，必要时翻页
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
  // 跟随态（Latest | Reading）：显式状态机在 scroll-follow.ts。只有用户意图窗口内的
  // 滚动能改状态；离底后任何程序化贴底 / 测高 / 内容长高都不会把 Reading 拉回底部。
  const followTrackerRef = useRef(createFollowTracker());
  /** 单调时钟：意图窗口与程序化静默期都按它算（墙钟跳变不影响判定） */
  const followNow = useCallback(() => performance.now(), []);
  /**
   * 触顶拉更早一页那一刻的滚动几何（源侧分页的滚动锚定）：
   * - pages = 当时的并入页数（回执后它变了就说明真并进来了一页）；
   * - key / offsetTop = 首个可见历史行的 key 与它相对视口顶的偏移（语义锚点）；
   * - scrollHeight / scrollTop = 没有历史行可锚时的几何差兜底。
   */
  const olderAnchorRef = useRef<{
    pages: number;
    scrollHeight: number;
    scrollTop: number;
    key: string | null;
    offsetTop: number;
  } | null>(null);

  /**
   * 用户意图捕获（捕获阶段）：wheel / touchmove / 滚动条 pointerdown。落在滚动容器上，
   * 内容区的事件也会冒到捕获阶段。意图只说明「接下来的滚动是用户干的」，状态由随后的
   * scroll 事件按位置表态——上滚意图会先暂停钉底，避免那一帧把用户的上滚吃掉。
   */
  const onWheelIntent = (event: React.WheelEvent<HTMLDivElement>) => {
    // 用户重新接管滚动：前插锚点的落定窗口立刻让位，不再按旧锚点纠偏
    pageSettleRef.current = null;
    noteFollowIntent(
      followTrackerRef.current,
      followNow(),
      event.deltaY === 0 ? "unknown" : event.deltaY < 0 ? "up" : "down",
    );
  };
  const onTouchMoveIntent = () => {
    pageSettleRef.current = null;
    noteFollowIntent(followTrackerRef.current, followNow(), "unknown");
  };
  const onPointerDownIntent = (event: React.PointerEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (
      isScrollbarPointer(
        event.target === el,
        event.nativeEvent.offsetX,
        event.nativeEvent.offsetY,
        el.clientWidth,
        el.clientHeight,
      )
    ) {
      pageSettleRef.current = null;
      noteFollowIntent(followTrackerRef.current, followNow(), "unknown");
    }
  };
  // 键盘滚动意图：滚动容器不一定有焦点（点过正文后焦点常在 body），所以挂窗口捕获；
  // 只认翻页 / Home / End / 方向键 / 空格，且焦点不在输入框里（判定见 scrollIntentDirection）。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const direction = scrollIntentDirection(
        event.key,
        { tagName: target.tagName, isContentEditable: target.isContentEditable },
        { ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey },
      );
      if (direction === null) return;
      const el = scrollRef.current;
      if (el === null) return;
      // 焦点在聊天面里，或没有焦点（body / html）：这次按键是在滚这列转录
      if (target !== document.body && target !== document.documentElement && !el.contains(target)) return;
      pageSettleRef.current = null;
      noteFollowIntent(followTrackerRef.current, performance.now(), direction);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

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

  /**
   * 滚动事件：只有「用户意图窗口内」的滚动、或没捕获到意图但位置确实离底的兜底，
   * 才能改跟随态（判定在 noteFollowScroll）。程序化钉底触发的事件不改状态。
   */
  const handleScroll = () => {
    const el = scrollRef.current;
    if (el !== null) {
      noteFollowScroll(
        followTrackerRef.current,
        { scrollTop: el.scrollTop, viewportHeight: el.clientHeight, scrollHeight: el.scrollHeight },
        followNow(),
      );
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
      // 语义锚点：首个可见历史行的 key + 它相对视口顶的偏移。虚拟化后旧可见行可能
      // 在前插那一刻之后被卸下，DOM 不能当锚点；`start` 来自虚拟器的测量缓存，
      // prepend 后同一 key 的新 start 减旧偏移就是目标 scrollTop。
      const captured = historyControllerRef.current?.captureAnchor(el.scrollTop) ?? null;
      pageSettleRef.current = null;
      olderAnchorRef.current = {
        pages: session.olderPages,
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        key: captured === null ? null : captured.key,
        offsetTop: captured === null ? 0 : captured.offsetTop,
      };
      session.loadOlder();
    }
  };

  // 滚动锚定（源侧分页）：更早的一页 prepend 之后，按**同一行的 key** 反算 scrollTop
  // ——前面插进来多高，视口就跟着走多远。有历史行可锚时用虚拟器的 measurement.start；
  // 没有（历史段还是空的）退回新旧 scrollHeight 差。绘制前同步执行（useLayoutEffect），
  // 不会闪一下再跳。**声明在钉底那支之前**：已经回到底部时交给钉底，不拿旧锚点再补。
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
    if (isFollowing(followTrackerRef.current)) return;
    if (anchor.key !== null) {
      const target = historyControllerRef.current?.scrollTopForAnchor(anchor.key, anchor.offsetTop) ?? null;
      if (target !== null) {
        // 同一批新行的逐行测高由这个窗口统一补偿（虚拟器默认补偿被 override 关掉）
        pageSettleRef.current = { key: anchor.key, offsetTop: anchor.offsetTop, until: followNow() + 1500 };
        el.scrollTop = target;
        notePinnedScroll(followTrackerRef.current, followNow());
        return;
      }
    }
    el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
    // 这是程序化改 scrollTop：给「位置离底」的兜底判定一个静默期
    notePinnedScroll(followTrackerRef.current, followNow());
  });

  // 前插锚点的落定窗口：新行从估值变实测会逐条改 start，这里每 commit 按同一 key
  // 重算一次。窗口内虚拟器的逐行补偿被 override 关掉（它的补偿按旧 scrollOffset
  // 累计，会把刚设好的锚点又拉走）；用户重新滚（wheel / 触摸 / 键 / 拖滚动条）时
  // 窗口立即让位，窗口到期后恢复虚拟器的默认补偿。
  useLayoutEffect(() => {
    const settle = pageSettleRef.current;
    if (settle === null) return;
    const el = scrollRef.current;
    if (el === null || isFollowing(followTrackerRef.current) || performance.now() >= settle.until) {
      pageSettleRef.current = null;
      return;
    }
    const target = historyControllerRef.current?.scrollTopForAnchor(settle.key, settle.offsetTop) ?? null;
    if (target === null) {
      pageSettleRef.current = null;
      return;
    }
    if (Math.abs(el.scrollTop - target) > 0.5) {
      el.scrollTop = target;
      notePinnedScroll(followTrackerRef.current, followNow());
    }
  });

  // 每次 commit 后钉底：不挑触发源——流式输出、忙碌指示出现、折叠展开全兜住；scrollTop 赋值廉价。
  // 只在 Latest 且没有「用户正在滚」的未决意图时钉（see mayPinToBottom）；Reading 一律不钉，
  // 新内容只让回底按钮浮出来。绘制前同步执行，用户看不到先长高再滚下去的闪动。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && mayPinToBottom(followTrackerRef.current, followNow())) {
      el.scrollTop = el.scrollHeight;
      notePinnedScroll(followTrackerRef.current, followNow());
    }
    syncScrollToEnd();
  });

  /** 这一屏是哪条会话：活着的优先，否则是打开的那条 */
  const openId = session.sessionId ?? session.opened?.id ?? "";
  // 记忆：用户消息的动作行里挂「用到 N · 记住 M」（UserBubble）。
  // 账本按轮记，这里按时间把轮配到气泡上（不按计数，见 pairMemoryTurns）
  const memorySession = useMemorySession(openId !== "" ? openId : null);
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
  // 输入框那一组：方向 N 的首页里它在中间（slogan → 输入框 → 记录），滑落距离要量它自己的底
  const travelRef = useRef<HTMLDivElement | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const chattedRef = useRef(false);
  const homeActive = session.sessionId === null && session.opened === null;

  /** 滑落距离：composer 现位到窗口底部（聊天页 footer 的大致位置）。外层量——prep 拍里它自己带着 transform。 */
  const measureTravel = () => {
    const el = stageRef.current;
    if (el === null) return;
    // 量输入框那一组的底——它不再是整列的最后一个孩子。回场的 prep 拍这一组自己带着 transform，
    // 所以不能量它的 getBoundingClientRect，改用 offsetTop + offsetHeight（布局值，不含 transform）
    // 加上 offsetParent（.home-stage，不动）的上沿
    const group = travelRef.current;
    const bottom =
      group === null || group.offsetParent === null
        ? el.getBoundingClientRect().bottom
        : group.offsetParent.getBoundingClientRect().top + group.offsetTop + group.offsetHeight;
    el.style.setProperty("--travel-dy", `${Math.max(0, window.innerHeight - bottom - 32)}px`);
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
    forceFollowLatest(followTrackerRef.current);
    // 换会话即作废分页锚点：在途回执并的是**旧会话**的窗口，拿它去补新会话的
    // scrollTop 就是错位（锚点里存的是旧会话的 scrollHeight）
    olderAnchorRef.current = null;
    const el = scrollRef.current;
    if (el !== null) {
      el.scrollTop = el.scrollHeight;
      notePinnedScroll(followTrackerRef.current, followNow());
    }
    syncScrollToEnd();
  }, [openId]);

  // 一键回底：smooth 滚到底（reduced-motion 瞬时）。这是显式用户动作——直接恢复跟随，
  // 动画窗口内锁住状态（途中的 scroll 事件不把它判回 Reading）。
  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    noteFollowJump(followTrackerRef.current, performance.now());
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
        forceFollowLatest(followTrackerRef.current);
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
    // 首页会话卡（选卡与那一句的推导在 home-cards.ts 纯函数，测试覆盖；这里只接线）：
    // 要你注意的（等你 > 出错 > 在跑）先占卡，再是有 open 遗留的、最近活跃的。卡上说「此刻在干
    // 什么」：运行态 + 槽里这一轮的过程 + 计划现算，不另存。不用 useMemo——运行态每个事件都可能
    // 变，而这里只在首页这一支跑、O(n)（子会话表先建好，不按会话各扫一遍全表）。
    // 没在跑的待办卡行位仍是遗留标题（最多 4 行）；遗留事项直接吃引擎缓存（PR-4 的
    // carryoverList 通道，写操作自动刷新），卡不另建缓存、meta 不冗余计数。
    const childrenOf = new Map<string, SessionMeta[]>();
    for (const meta of session.sessions) {
      if (meta.parentId === undefined) continue;
      const list = childrenOf.get(meta.parentId);
      if (list === undefined) childrenOf.set(meta.parentId, [meta]);
      else list.push(meta);
    }
    const stateOf = (meta: SessionMeta): SessionRunState =>
      sessionRunState({
        slot: {
          phase: session.phaseOf(meta.id),
          approvals: session.approvalsOf(meta.id).length,
          planAwaiting: session.planAwaitingOf(meta.id),
        },
        children: (childrenOf.get(meta.id) ?? []).map((child) => ({
          phase: session.phaseOf(child.id),
          approvals: session.approvalsOf(child.id).length,
          planAwaiting: session.planAwaitingOf(child.id),
        })),
        unread: meta.unread ?? null,
      });
    const homeCards = selectHomeCards(session.sessions, stateOf);
    // 纸面两档（小学作业 / 打字稿）首页仍是三张卡：它们的版式是田字格 / 横线的整套，不套方向 N；
    // 别的主题是按状态分组的记录行（2026-11-07）。两条路读同一份运行态推导，只是形状不同。
    const logMode = heroFace(props.theme) === "plain";
    const lineText: HomeCardLineText = {
      thinking: t.homeCard.thinking,
      doing: t.homeCard.doing,
      approve: t.homeCard.approve,
      childWaiting: t.homeCard.childWaiting,
      failed: t.homeCard.failed,
      done: t.homeCard.done,
      noText: t.homeCard.noText,
      verb: (toolName, input) => toolWord(t.chat.rollupTool, rollupToolKey(toolName, input, skills), input),
      summary: (toolName, input) => toolCallSummaryForRow(toolName, input, skills),
    };
    /** 一条会话在首页上的实况：运行态、那一句「此刻在干什么」、在哪、多久前（卡与记录行共用） */
    const homeFacts = (sessionId: string) => {
      const meta = session.sessions.find((m) => m.id === sessionId);
      const state = meta === undefined ? null : stateOf(meta);
      // 槽只在说「此刻」时才读：没在跑的会话说最近一次提问，不碰转录
      const entry = state === null ? undefined : session.entryOf(sessionId);
      const approval = session.approvalsOf(sessionId)[0];
      const where =
        meta?.workspaceId === null || meta === undefined
          ? t.sidebar.tasks
          : (session.workspaces.find((w) => w.id === meta.workspaceId)?.name ?? t.sidebar.tasks);
      const line = homeCardLine(
        {
          state,
          records: entry === undefined ? null : selectTranscript(entry.transcript),
          approval: approval === undefined ? null : { toolName: approval.toolName, input: approval.input },
          turnError: session.turnErrorOf(sessionId),
          lastAsk: meta?.recentQueries[0] ?? null,
        },
        lineText,
      );
      // 在跑 / 等你不写时间：不走表的「刚刚」比不写更误导
      const time =
        state === "running" || state === "waiting" || meta === undefined ? null : relativeTime(meta.updatedAt, t);
      return { state, where, line, time };
    };
    // 点击：卡与行都进该会话（openSession）——滚动定位到 sourceMessageRange 的基建
    // 还未立项（PR-4 面板同款 TODO），落定后行点击可升级为定位，卡保持进会话
    const openFromHome = (sessionId: string): void => {
      startLeave();
      session.openSession(sessionId);
    };
    const logGroups = logMode
      ? selectHomeLog(session.sessions, stateOf).map((group) => ({
          group: group.group,
          rows: group.rows.map((row): HomeLogRowView => {
            const facts = homeFacts(row.sessionId);
            return {
              sessionId: row.sessionId,
              title: row.title,
              state: facts.state,
              line: facts.line,
              where: facts.where,
              time: facts.time,
            };
          }),
        }))
      : [];
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
          overflow: "hidden",
        }}
      >
        <div ref={stageRef} className="home-col" data-mode={logMode ? "log" : "cards"}>
          {/* 淡出组：slogan（与纸面档的会话卡）一起向上走（--transition-layer，220ms） */}
          <div className="home-fade home-fade-head">
            {/* 门面：slogan（纸面两档再加红笔批语），样子与理由在 HomeHero.tsx */}
            <HomeHero theme={props.theme} />
            {/* 纸面档：一排最近会话卡（SessionCard 规格：恒三槽、等高、hover 只抬阴影） */}
            {!logMode &&
              (!session.sessionsLoaded ? (
                <div style={{ width: "100%", display: "flex", gap: "var(--space-3)" }}>
                  {[0, 1, 2].map((index) => (
                    <SessionCard key={index} name="" loading />
                  ))}
                </div>
              ) : (
                homeCards.length > 0 && (
                  <div style={{ width: "100%", display: "flex", gap: "var(--space-3)" }}>
                    {homeCards.map((card) => {
                      const facts = homeFacts(card.sessionId);
                      const metaLine = [
                        facts.where,
                        ...(facts.state === null ? [] : [t.homeCard.state[facts.state]]),
                        ...(facts.time === null ? [] : [facts.time]),
                      ].join(" · ");
                      return (
                        <SessionCard
                          key={card.sessionId}
                          name={card.title}
                          items={card.rows.map((row) => ({ text: row.text }))}
                          slots={HOME_CARD_QUERY_ROWS}
                          line={facts.line}
                          meta={metaLine}
                          state={facts.state}
                          onClick={() => openFromHome(card.sessionId)}
                        />
                      );
                    })}
                  </div>
                )
              ))}
          </div>
          {/* 滑落组：notices 与 composer 一起滑向窗口底部（--transition-composer-exit，240ms） */}
          <div
            ref={travelRef}
            className="home-travel"
            style={{ width: "100%", display: "grid", gap: "var(--space-2)" }}
          >
            {notices}
            {composer}
          </div>
          {/* 记录组：在输入框下面（先写，再读别的活的进展），随 slogan 一起淡出 */}
          {logMode && (
            <div className="home-fade home-fade-log">
              <HomeLog groups={logGroups} loading={!session.sessionsLoaded} onOpen={openFromHome} />
            </div>
          )}
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
        onWheelIntent={onWheelIntent}
        onTouchMoveIntent={onTouchMoveIntent}
        onPointerDownIntent={onPointerDownIntent}
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
        transcriptNotice={copyNotice}
        banner={
          openMeta != null && openMeta.automationId !== undefined && openMeta.promoted !== true ? (
            <AutomationRunBar meta={openMeta} onPromoted={session.reloadSessions} />
          ) : undefined
        }
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
          memoryView={memorySession.data}
          onOpenMemoryReview={props.onOpenMemoryReview}
          sessionId={openId}
          scrollRef={scrollRef}
          followTrackerRef={followTrackerRef}
          pageSettleRef={pageSettleRef}
          historyControllerRef={historyControllerRef}
          hasMoreOlderRef={hasMoreRef}
          loadOlderRef={loadOlderRef}
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
  /** 记忆查询（会话作用域）：历史段据此配「记忆 · 用到 N 条」行；null = 关着 / 没数据 */
  memoryView: MemorySessionView | null;
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
  /** 滚动容器（ChatViewBody 持有）：历史段虚拟器按它测视口、挂滚动监听 */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 跟随态（Latest | Reading）：测高补偿 override 要读它，避免把 Reading 拉回 */
  followTrackerRef: React.RefObject<FollowTracker>;
  /** 前插锚点落定窗口（父组件置位）：窗口内虚拟器的逐行测高补偿一律关闭 */
  pageSettleRef: React.RefObject<{ key: string; offsetTop: number; until: number } | null>;
  /** 回父组件的跳转 / 锚点入口（每次渲染覆写，方法在调用时读最新行映射） */
  historyControllerRef: React.RefObject<HistoryVirtualController | null>;
  /** 还有更早的历史可翻（引用随记录窗口变） */
  hasMoreOlderRef: React.RefObject<boolean>;
  /** 翻更早一页（引用稳定） */
  loadOlderRef: React.RefObject<() => void>;
}) {
  const t = useT();
  // 意图系统开关：关着时终态记录照渲染（历史还在），运行卡与入口全藏
  const intentOn = useExperimentalFeature("intent-system");
  const { transcript } = props;
  // 计划的版本线（对话里每个过程块的「计划改了：…」一行、现场块里「在做哪一步」都吃它）：
  // 只挑 update_plan 那几条算。实时尾段的现场块要读「现在在做哪一步」，所以按整段算。
  const plan = useMemo(
    () => planTimeline(transcript.filter((item) => item.role === "tool" && item.toolName === PLAN_TOOL_NAME)),
    [transcript],
  );
  // 目标与计划的改动账：对话里「目标改了：…」那一行读它（按签名记忆，流式吐字不重算）
  const ledger = useGoalLedger(transcript);
  // 停在「计划等你确认」上的那一版（最后一次 update_plan 要求确认、之后用户还没回应）：画成计划卡
  const awaitingPlan = useMemo(
    () => (plan !== null && plan.current.awaiting && planAwaitingIn(transcript) ? plan.current : null),
    [plan, transcript],
  );
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
  // 被撤销的轮 id 集：轮尾卡据此挂「已撤销」徽标（undo 记录不是渲染单元）。
  // 按 props.undos 记忆（引用只在真的撤销时变），不按逐帧重建的 records——否则历史行每帧重渲染
  const undoneTurnIds = useMemo(
    () => new Set(props.undos.map((record) => record.turnId)),
    [props.undos],
  );
  // 组行的展开是时间态：活跃轮里铺开，整轮落定一次性收纳（见 ToolGroupLine）
  const turnActive = props.phase === "turn";
  // 过程显示（设置 › 过程显示）：一轮一行 = groupTurnsByTurn（旁白收进块、活跃轮成现场块）；
  // 逐步铺开 = groupTurns（落定轮按旁白收成几条 Worked，活跃轮原样铺开）
  const processView = useContext(ProcessViewContext);

  // —— 历史段 / 实时尾段分离 ——
  // 最后一条 user 记录之后是流式期间唯一还在增长的一段；切段规则（user / 压缩界碑 /
  // 通道标记都是段边界）保证两段各自派生与整段一次性计算等价（推导与测试见
  // history-segment.ts / transcript-split.ts）。历史段的派生物在记录前缀不变时按引用
  // 复用，尾段每帧重建——目标是不做虚拟化也让流式只重算尾轮。
  const boundary = useMemo(() => splitAtLastUser(records).boundary, [records]);
  const historyCacheRef = useRef<HistoryCache | null>(null);
  const history = useMemo(() => {
    const next = deriveHistorySegment(historyCacheRef.current, {
      records,
      boundary,
      skills: props.skills,
      processView,
    });
    historyCacheRef.current = next;
    return next;
  }, [records, boundary, props.skills, processView]);
  const historySegment = history.segment;
  const tailRecords = useMemo(() => records.slice(boundary), [records, boundary]);
  const tailToolResults = useMemo(() => indexToolResults(tailRecords), [tailRecords]);
  const tailUnits = useMemo(() => flattenRenderUnits(tailRecords), [tailRecords]);
  const tailEntries = useMemo(() => groupToolUnits(tailUnits, props.skills), [tailUnits, props.skills]);
  const tailTurnView = useMemo(
    () =>
      processView === "turn"
        ? groupTurnsByTurn(tailEntries, turnActive, tailToolResults)
        : groupTurns(tailEntries, turnActive, tailToolResults),
    [tailEntries, turnActive, tailToolResults, processView],
  );
  // 流式中的 assistant 记录 id 集：这些消息的 text 块渲染时传 streaming——
  // 流式帧省掉公式排版与代码高亮（stream-render.ts），落定帧再补渲
  const tailStreamingIds = useMemo(() => streamingRecordIds(tailRecords), [tailRecords]);
  // 已中断的工具调用（interruptedToolCallIds）：结果永远不会来的调用按静止的
  // 「已中断」渲染，不再呼吸/转圈——委派卡「委派中…」停不下来就是这类（2026-10-09）
  const tailInterruptedCalls = useMemo(
    () => interruptedToolCallIds(tailRecords, tailToolResults, turnActive),
    [tailRecords, tailToolResults, turnActive],
  );
  // 收尾扫描回答卡（记录 id → 卡片与首个 text 单元）：历史段与尾段各按自己的记录算，
  // 引用随记录稳定（历史段卡片不会因为流式吐字换新 Map）
  const tailCarryoverCards = useMemo(() => scanAnswerCards(tailRecords), [tailRecords]);
  // 分支锚点（C-2）：每轮最终完整输出的最后一个单元后面挂一条分支按钮行；
  // 本轮还在跑（turnActive）时末尾候选不确认——复制/分支行等回答结束再出现；速度不在此列：
  // 实时速度本就在 Responding 行（估算，每秒一跳），这里整行藏着的是落定后的 BranchRow
  // （复制 + 分支 + 随记录落盘的真值速度）。有工具还在跑时分支按钮全部禁用（历史锚点
  // 同）——它的结果没齐，此刻切出去的上下文是畸形的。锚点算在**大折叠视图**上：锚点的
  // 正文永远在折叠外面，按钮跟着正文走。
  const tailBranchRows = useMemo(
    () => branchAnchorEntries(branchAnchorIds(tailRecords, tailToolResults, turnActive), tailTurnView),
    [tailRecords, tailToolResults, turnActive, tailTurnView],
  );
  // 现场块在场且后面没有正文在流时，它自己就是「在干活」的那一行——底下的 Responding 不再重复
  const liveBlockShown = tailTurnView.some(
    (entry) => entry.kind === "turnProcess" && entry.live && !entry.answering,
  );
  // 流式中的思考块（行首呼吸的判定）：本轮未结束且它是流式 assistant 消息的最后一块
  const activeThinkingKey = useMemo(
    () => streamingThinkingKey(tailRecords, turnActive),
    [tailRecords, turnActive],
  );
  const toolsRunning = useMemo(
    () => transcript.some((item) => item.role === "tool" && item.status === "running"),
    [transcript],
  );
  // 回合级失败（网络中断 / 重试耗尽）的红 triangle 只挂**失败那轮**的折叠（见 failedFoldKey）；
  // 那轮没折叠就不挂，红字自带的图标是全部。失败轮永远在尾段，所以在尾段视图上找。
  // 工具类失败不配图标（各自的红色 failed 计数已经跟在工具后面）。
  // 局部名叫 failedFold：failedFoldKey 是 turn-rollup 里的函数，不能重名遮蔽。
  const failedFold = props.turnError !== null ? failedFoldKey(tailTurnView) : null;
  const hasEntries = historySegment.entries.length + tailEntries.length > 0;
  // 记忆行（用户消息全部落在历史段——最后一条 user 就是边界）：按历史段记录配账，
  // 引用随历史段与记忆查询稳定，流式吐字不换对象（历史行 memo 才命中）。
  // 随回退停用的条目不挂在对话里（重说的那一轮与被撤回的同轮号，见 liveRemembered）。
  const memoryLines = useMemo((): MemoryLines | null => {
    const view = props.memoryView;
    if (view === null) return null;
    const users = historySegment.records.flatMap((item) =>
      item.role === "user" ? [{ id: item.id, timestamp: item.timestamp }] : [],
    );
    const rows = new Map([...pairMemoryTurns(users, view)].map(([id, row]) => [id, liveRemembered(row)]));
    return { rows };
  }, [props.memoryView, historySegment.records]);
  // 回退预演的切点：要撤回的那条用户消息在视图里的位置（-1 = 没在预演 / 不在视图里）。
  // 先找历史段、再找尾段；下标按整列算（历史段在前、尾段接在后面）。
  const previewMessageId = props.preview?.kind === "revert" ? props.preview.messageId : null;
  const cutIndex = useMemo(() => {
    if (previewMessageId === null) return -1;
    const isTarget = (entry: TurnViewEntry) => entry.kind === "user" && entry.item.id === previewMessageId;
    const inHistory = historySegment.turnView.findIndex(isTarget);
    if (inHistory >= 0) return inHistory;
    const inTail = tailTurnView.findIndex(isTarget);
    return inTail >= 0 ? historySegment.turnView.length + inTail : -1;
  }, [previewMessageId, historySegment.turnView, tailTurnView]);
  const cutRef = useRef<HTMLDivElement | null>(null);

  // 回调的稳定引用：行组件是 memo，回调本身逐帧换引用会让历史行整列重渲染。
  // 调用的永远是最新一版（ref 在渲染期更新，见 useStableCallback）。
  const onBranch = useStableCallback(props.onBranch);
  const onOpenTask = useStableCallback(props.onOpenTask);
  const onUndoTurn = useStableCallback(props.onUndoTurn);
  const onRevertTo = useStableCallback(props.onRevertTo);

  // 行作用域：历史段一份（字段全稳定 ⇒ 历史行 memo 命中）、尾段一份（每帧重建）
  const historyScope = useMemo<RowScope>(
    () => ({
      view: historySegment.turnView,
      records: historySegment.records,
      toolResults: historySegment.toolResults,
      plan: historySegment.plan,
      ledger,
      // 历史段的计划不可能是「等你确认」的那一版：最后一条 user 记录是边界，回应已经给了
      awaitingPlan: null,
      branchRows: historySegment.branchRows,
      carryoverCards: historySegment.carryoverCards,
      interruptedCalls: historySegment.interruptedCalls,
      streamingIds: historySegment.streamingIds,
      activeThinkingKey: null,
      turnActive: false,
      failedFold: null,
      toolsRunning,
      skills: props.skills,
      channel: props.channel,
      cwd: props.cwd,
      undoneTurnIds,
      memory: memoryLines,
      actionsBusy: props.actionsBusy,
      sessionId: props.sessionId,
      onBranch,
      onOpenTask,
      onUndoTurn,
      onRevertTo,
      onOpenReviewAt: props.onOpenReviewAt,
      onOpenIntentPanel: props.onOpenIntentPanel,
      onOpenMemoryReview: props.onOpenMemoryReview,
      cutRef,
    }),
    [
      historySegment,
      ledger,
      toolsRunning,
      props.skills,
      props.channel,
      props.cwd,
      undoneTurnIds,
      memoryLines,
      props.actionsBusy,
      props.sessionId,
      onBranch,
      onOpenTask,
      onUndoTurn,
      onRevertTo,
      props.onOpenReviewAt,
      props.onOpenIntentPanel,
      props.onOpenMemoryReview,
    ],
  );
  const tailScope = useMemo<RowScope>(
    () => ({
      view: tailTurnView,
      records: tailRecords,
      toolResults: tailToolResults,
      // 现场块要读「现在在做哪一步」：用整段的计划线（写计划的那一轮可能在历史段）
      plan,
      ledger,
      awaitingPlan,
      branchRows: tailBranchRows,
      carryoverCards: tailCarryoverCards,
      interruptedCalls: tailInterruptedCalls,
      streamingIds: tailStreamingIds,
      activeThinkingKey,
      turnActive,
      failedFold,
      toolsRunning,
      skills: props.skills,
      channel: props.channel,
      cwd: props.cwd,
      undoneTurnIds,
      memory: memoryLines,
      actionsBusy: props.actionsBusy,
      sessionId: props.sessionId,
      onBranch,
      onOpenTask,
      onUndoTurn,
      onRevertTo,
      onOpenReviewAt: props.onOpenReviewAt,
      onOpenIntentPanel: props.onOpenIntentPanel,
      onOpenMemoryReview: props.onOpenMemoryReview,
      cutRef,
    }),
    [
      tailTurnView,
      tailRecords,
      tailToolResults,
      plan,
      ledger,
      awaitingPlan,
      tailBranchRows,
      tailCarryoverCards,
      tailInterruptedCalls,
      tailStreamingIds,
      activeThinkingKey,
      turnActive,
      failedFold,
      toolsRunning,
      props.skills,
      props.channel,
      props.cwd,
      undoneTurnIds,
      memoryLines,
      props.actionsBusy,
      props.sessionId,
      onBranch,
      onOpenTask,
      onUndoTurn,
      onRevertTo,
      props.onOpenReviewAt,
      props.onOpenIntentPanel,
      props.onOpenMemoryReview,
    ],
  );
  // —— 历史段虚拟化的本地状态 ——
  // 滚动容器 / 跟随态 / 前插落定窗口归父组件（ChatViewBody）；这里只持有虚拟器、
  // 行映射与高度缓存。把所有方法写进父组件的 controller ref，父组件的事件与
  // layout effect 调它时总能读到最新一版行数组。
  const scrollRef = props.scrollRef;
  const followTrackerRef = props.followTrackerRef;
  const pageSettleRef = props.pageSettleRef;
  const hasMoreRef = props.hasMoreOlderRef;
  const loadOlderRef = props.loadOlderRef;
  const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLDivElement> | null>(null);
  const virtualRowsRef = useRef<readonly VirtualHistoryRow[]>([]);
  const rowIndexByKeyRef = useRef<ReadonlyMap<string, number>>(new Map());
  const messageRowIndexRef = useRef<ReadonlyMap<string, number>>(new Map());
  const viewRowIndexRef = useRef<ReadonlyMap<number, number>>(new Map());
  const heightCacheRef = useRef<HeightCache | null>(null);
  if (heightCacheRef.current === null) heightCacheRef.current = createHeightCache(4000);
  // 未测行的在线典型高度：由 measureElement 的真实高度喂出来的滑动均值（全局 + 按 kind，
  // ref，不触发渲染）。L3a 用「一屏高」估，逐行换成实测值时总高一路收缩；这里让它从
  // 首帧就接近真实。
  const typicalHeightRef = useRef<RowHeightEstimator | null>(null);
  if (typicalHeightRef.current === null) typicalHeightRef.current = createRowHeightEstimator();
  // 测高补偿的合并窗口：同一次提交 / 同一批 ResizeObserver 里多行的实测高度差先
  // 累加，等本列提交后一次性写一次 scrollTop。逐行同步写会让每个刻度都产生一次
  // 强制 layout + 滚动事件（L3b 实测慢帧 33.1–33.6 ms 的主因之一）。
  const pendingCorrectionRef = useRef(0);

  /**
   * 把一个历史行滚进视口：先用虚拟器按未测估值粗定位，等 `data-index` 对上的
   * 那一行真的挂载、测高落定、且落在视口内后再交给 `done` 精确对齐。未挂载时不能只靠
   * `querySelector`——虚拟化之后「没挂载」不等于「没加载」。
   *
   * 深跳（底部 → 最老行）不能挂载后立即交付：上方几十行是估值，它们逐帧测高后
   * 内容会继续位移，一行会从「已挂载」滑到视口上方（L3b 实测落点 top −771）。
   * 所以这里等到同一行连续两帧高度一致、且视口中心落在行内再交付。
   */
  const revealVirtualRow = useCallback((key: string, done: (row: HTMLElement) => void) => {
    // 程序化跳转先脱离跟随：否则 Latest 的钉底 effect 会在下一帧把视口拉回底部，
    // 和 scrollIntoView 抢滚动权（回退预演切点尤其明显）。
    forceReading(followTrackerRef.current);
    const virtualizer = virtualizerRef.current;
    if (virtualizer === null) return;
    const selector = `.chat-virtual-row[data-virtual-key="${CSS.escape(key)}"]`;
    const mounted = document.querySelector<HTMLElement>(selector);
    if (mounted !== null) {
      done(mounted);
      return;
    }
    const firstIndex = rowIndexByKeyRef.current.get(key);
    if (firstIndex === undefined) return;
    virtualizer.scrollToIndex(firstIndex, { align: "center" });
    let lastIndex = firstIndex;
    let frames = 0;
    let lastHeight = -1;
    let stable = 0;
    const settle = () => {
      const row = document.querySelector<HTMLElement>(selector);
      // 前插可能在这几帧里发生：index 会变，按 key 重新解析后再粗定位一次
      const index = rowIndexByKeyRef.current.get(key);
      if (row !== null && index !== undefined) {
        const pane = scrollRef.current;
        let inView = false;
        if (pane !== null) {
          const r = row.getBoundingClientRect();
          const p = pane.getBoundingClientRect();
          const center = (p.top + p.bottom) / 2;
          // 高过一屏的行也满足：视口中心落在行内
          inView = r.top <= center && r.bottom >= center;
        }
        const height = Math.round(row.getBoundingClientRect().height);
        stable = height === lastHeight ? stable + 1 : 0;
        lastHeight = height;
        if (inView && stable >= 1) {
          done(row);
          return;
        }
        // 还没稳：按最新的 measurements 再居中一次（估值已换成实测）
        virtualizer.scrollToIndex(index, { align: "center" });
      } else if (index !== undefined && index !== lastIndex) {
        lastIndex = index;
        virtualizer.scrollToIndex(index, { align: "center" });
      }
      frames += 1;
      if (frames <= 24) {
        window.requestAnimationFrame(settle);
      } else if (row !== null) {
        // 高度始终不稳（图片 / 懒加载内容）：尽力交付当前行，不再等
        done(row);
      }
    };
    window.requestAnimationFrame(settle);
  }, []);

  /** 引用 / 收尾卡跳转：按消息 id 找行；不在已加载窗口里先翻页（最多 20 页） */
  const jumpToMessage = useCallback(
    (messageId: string) => {
      let tries = 0;
      const attempt = () => {
        const pane = scrollRef.current;
        if (pane === null) return;
        if (pane.querySelector(`[data-quote-id="${CSS.escape(messageId)}"]`) !== null) {
          highlightQuote(pane, messageId, "", "auto");
          return;
        }
        // 历史段里的消息可能只是被虚拟化卸下了：按数据索引粗定位，再等它挂载
        const index = messageRowIndexRef.current.get(messageId);
        const row = index === undefined ? undefined : virtualRowsRef.current[index];
        if (row !== undefined) {
          revealVirtualRow(row.entry.key, () => {
            const current = scrollRef.current;
            if (current !== null) highlightQuote(current, messageId, "", "auto");
          });
          return;
        }
        if (!hasMoreRef.current || tries >= 20) return;
        tries += 1;
        loadOlderRef.current();
        window.setTimeout(attempt, 400);
      };
      attempt();
    },
    [revealVirtualRow, scrollRef, hasMoreRef, loadOlderRef],
  );

  // 前插落定：虚拟器的测高通知只重渲本列，不重渲父组件——锚点重算必须挂在这里，
  // 否则父组件的 settle effect 收不到后续测量帧，行会停在估值坐标上。窗口内每帧
  // 按同一 key 把 scrollTop 拉回「新 start − 旧视口偏移」；用户滚动由父组件清窗。
  useLayoutEffect(() => {
    const settle = pageSettleRef.current;
    if (settle === null) return;
    const el = scrollRef.current;
    if (el === null || isFollowing(followTrackerRef.current) || performance.now() >= settle.until) {
      pageSettleRef.current = null;
      return;
    }
    const index = rowIndexByKeyRef.current.get(settle.key);
    const measurement = index === undefined ? undefined : virtualizer.measurementsCache[index];
    const target = prependAnchorTarget(measurement?.start, settle.offsetTop);
    if (target === null) {
      pageSettleRef.current = null;
      return;
    }
    if (Math.abs(el.scrollTop - target) > 0.5) {
      el.scrollTop = target;
      notePinnedScroll(followTrackerRef.current, performance.now());
    }
  });

  // 历史段真正会产出 DOM 的行（相邻 show_image 的吸收行 / 被扫描卡吸收的后续正文块
  // 不进虚拟列表，否则会留下空行与假 gap）。
  const historyVirtualRows = useMemo(
    () =>
      virtualHistoryRows(
        historySegment.turnView,
        historySegment.toolResults,
        historySegment.carryoverCards,
        props.channel.ownSide,
        historySegment.branchRows,
      ),
    [
      historySegment.turnView,
      historySegment.toolResults,
      historySegment.carryoverCards,
      historySegment.branchRows,
      props.channel.ownSide,
    ],
  );
  // 事件 / 布局 effect 里读最新映射（它们不在渲染期执行，但闭包不能拿旧数组）
  const historyRowByKey = useMemo(() => rowIndexByKey(historyVirtualRows), [historyVirtualRows]);
  const historyRowByMessage = useMemo(() => messageRowIndex(historyVirtualRows), [historyVirtualRows]);
  const historyRowByViewIndex = useMemo(() => viewRowIndex(historyVirtualRows), [historyVirtualRows]);
  virtualRowsRef.current = historyVirtualRows;
  rowIndexByKeyRef.current = historyRowByKey;
  messageRowIndexRef.current = historyRowByMessage;
  viewRowIndexRef.current = historyRowByViewIndex;

  // 只虚拟化历史段；实时尾段继续按普通流渲染在虚拟占位之后。行仍是 `TurnViewEntry`
  // 粗粒度行（user / 回合折叠 / 过程块 / 正文），保留 `.chat-col` 原有的子午线几何。
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    // 滚动事件里同步 flushSync 渲染会把滚动管线本身拖慢（每个刻度一次同步
    // render+commit）；异步渲染由 React 合并到帧内，视口内容晚一帧但不再挡滚动。
    useFlushSync: false,
    count: historyVirtualRows.length,
    getScrollElement: useCallback(() => scrollRef.current, []),
    // 未测行估值：同一 key 有实测缓存就用缓存，否则用在线典型行高（初值 230，
    // 之后由真实高度校准，夹 80–1200）。不再用「一屏高」——那会让滚动期每测一行
    // 都收缩一次总高，Layout 跟着抖（L3a 实测 B2 17.5%，卡帧 32/38 含 Layout）。
    estimateSize: useCallback((index: number) => {
      const row = virtualRowsRef.current[index];
      const key = row?.entry.key;
      const cache = heightCacheRef.current;
      const typical = typicalHeightRef.current;
      if (key === undefined || cache === null || typical === null) return DEFAULT_ROW_ESTIMATE;
      return estimateRowHeight(key, row?.entry.kind ?? null, cache, typical);
    }, []),
    getItemKey: useCallback((index: number) => virtualRowsRef.current[index]?.entry.key ?? `#${index}`, []),
    overscan: 4,
    measureElement: useCallback((element: Element, entry: ResizeObserverEntry | undefined) => {
      // ResizeObserver 的 borderBox 是内容真实高度；测量值回写 LRU，抗重挂 / StrictMode。
      // 同一份实测也喂给典型行高估计器——下一次未测行重算时就有了数据驱动的估值。
      const box = entry?.borderBoxSize[0];
      const height = Math.round(box?.blockSize ?? element.getBoundingClientRect().height);
      const key = element.getAttribute("data-virtual-key");
      if (key !== null) {
        // data-kind 在行内的 .revert-keep 上：同类行分开积累估值（文字行远高于工具行）
        const kind = element.querySelector("[data-kind]")?.getAttribute("data-kind") ?? null;
        const cache = heightCacheRef.current;
        const typical = typicalHeightRef.current;
        // prev 与 estimateSize 同口径：有实测缓存用缓存，否则用该类估值。
        const prev = cache?.get(key) ?? typical?.value(kind) ?? DEFAULT_ROW_ESTIMATE;
        cache?.set(key, height);
        typical?.push(kind, height);
        // 只累加「整行都在视口上方」的实测变化（与虚拟器默认补偿同口径）；跟随 /
        // 前插落定在 flush 时再判一次。行下标来自 data-index，measure 时缓存里
        // 还是本次测高前的坐标。
        const index = Number(element.getAttribute("data-index"));
        const item = Number.isInteger(index) ? virtualizerRef.current?.measurementsCache[index] : undefined;
        const scrollTop = scrollRef.current?.scrollTop ?? 0;
        if (item !== undefined && item.end <= scrollTop + 1) {
          pendingCorrectionRef.current += height - prev;
        }
      }
      return height;
    }, []),
  });
  // 测高补偿改为在本列提交后合并写一次（见 pendingCorrectionRef）：虚拟器自带的
  // 逐行补偿（resizeItem 里同步写 scrollTop）关掉，否则会和合并那次叠成两次写入。
  // 跟随中不补（钉底统一接管）；前插落定窗口里也不补——那段由 settle effect 按
  // 同一行的 key 每帧重算。
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
  virtualizerRef.current = virtualizer;

  // 合并补偿：一次提交里攒下的高度差只写一次 scrollTop。测高回调在 layout 之后、
  // 绘制之前触发，notify 后的这次提交里写完，视口不会先跳一下再回来。
  useLayoutEffect(() => {
    const pending = pendingCorrectionRef.current;
    if (pending === 0) return;
    pendingCorrectionRef.current = 0;
    if (isFollowing(followTrackerRef.current) || pageSettleRef.current !== null) return;
    const el = scrollRef.current;
    if (el === null) return;
    const next = Math.max(0, el.scrollTop + pending);
    if (Math.abs(next - el.scrollTop) > 0.5) el.scrollTop = next;
  });

  // 回父组件的锚点 / 跳转入口。每次渲染覆写：方法体读的是本次渲染的行映射与
  // 虚拟器，父组件在事件 / layout effect 里调用时不会拿到过期闭包。
  props.historyControllerRef.current = {
    jumpToMessage,
    captureAnchor: (scrollTop: number) => {
      const item = virtualizer.getVirtualItemForOffset(scrollTop);
      const row = item === undefined ? undefined : virtualRowsRef.current[item.index];
      if (item === undefined || row === undefined) return null;
      return { key: row.entry.key, offsetTop: item.start - scrollTop };
    },
    scrollTopForAnchor: (key: string, offsetTop: number) => {
      const index = rowIndexByKeyRef.current.get(key);
      const measurement = index === undefined ? undefined : virtualizer.measurementsCache[index];
      return prependAnchorTarget(measurement?.start, offsetTop);
    },
  };

  const virtualHistoryItems = virtualizer.getVirtualItems();
  const historyVirtualSize = virtualizer.getTotalSize();
  // 「这条任务 › 进度」点一章：对话滚到那个过程块并闪一下（面板与对话不共享状态，走一次性事件）
  const flashEntry = useCallback((target: HTMLElement) => {
    // 瞬时定位：虚拟化后 smooth 动画会被测高补偿打断，位置可能停在半路
    target.scrollIntoView({ block: "center", behavior: "auto" });
    target.classList.remove("entry-revealed");
    void target.offsetWidth;
    target.classList.add("entry-revealed");
  }, []);
  useEffect(() => {
    const onReveal = (event: Event) => {
      const key = (event as CustomEvent<string>).detail;
      const findMounted = (): HTMLElement | null => {
        const target = document.querySelector(`[data-entry-key="${CSS.escape(key)}"]`);
        return target instanceof HTMLElement ? target : null;
      };
      const index = rowIndexByKeyRef.current.get(key);
      if (index !== undefined) {
        revealVirtualRow(key, (row) => {
          const target = findMounted();
          if (target !== null) {
            flashEntry(target);
            return;
          }
          // 行已挂载但目标条目在折叠里 / 被画廊吸收：闪整行，至少把人带到位置
          flashEntry(row);
        });
        return;
      }
      const mounted = findMounted();
      if (mounted !== null) {
        flashEntry(mounted);
        return;
      }
      // 不在已加载窗口里：先翻页（最多 20 页），每次回来再试
      let loads = 0;
      const retry = () => {
        const target = findMounted();
        if (target !== null) {
          flashEntry(target);
          return;
        }
        const nextIndex = rowIndexByKeyRef.current.get(key);
        if (nextIndex !== undefined) {
          revealVirtualRow(key, (row) => flashEntry(findMounted() ?? row));
          return;
        }
        if (!hasMoreRef.current || loads >= 20) return;
        loads += 1;
        loadOlderRef.current();
        window.setTimeout(retry, 400);
      };
      retry();
    };
    window.addEventListener(REVEAL_ENTRY_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_ENTRY_EVENT, onReveal);
  }, [flashEntry, revealVirtualRow]);
  useEffect(() => {
    if (cutIndex < 0) return;
    forceReading(followTrackerRef.current);
    // 切点在历史段：先让虚拟器把那一行挂上，再对虚线与切点行做精确对齐
    const virtualIndex = viewRowIndexRef.current.get(cutIndex);
    const cutRow = virtualIndex === undefined ? undefined : virtualRowsRef.current[virtualIndex];
    if (cutRow !== undefined) {
      revealVirtualRow(cutRow.entry.key, () => {
        // 瞬时定位：smooth 动画期间虚拟器的测高补偿会改写 scrollTop，动画会被打断
        cutRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
      });
      return;
    }
    cutRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [cutIndex, revealVirtualRow]);

  return (
    <>
      {/* 历史恢复在途：一行安静的加载指示，正文区不再是一片无解释的空白 */}
      {props.loadingHistory && !hasEntries && <StatusLine spin>{t.common.loading}</StatusLine>}
      {/* 触顶拉更早的一页：列首一行次级灰（设计系统的 caption 惯例）。import 耗尽了就不出现 */}
      {props.loadingOlder && <StatusLine spin>{t.chat.loadingOlder}</StatusLine>}
      {/* 空会话（没发过消息）：一行 tertiary 交代「这里为什么是空的」 */}
      {!hasEntries &&
        !props.loadingHistory &&
        props.phase === "idle" &&
        props.turnError === null && (
          <StatusLine>{t.chat.noMessages}</StatusLine>
        )}
      {/* 历史段：只挂视口 + overscan 内的行；尾段与状态行仍在虚拟占位块之后按普通流渲染。
          虚拟行仍是 .revert-keep（data-kind 不变），子午线选择器在 styles.css 里同步认
          .chat-virtual-row 这层包裹。行距用行自身 padding-bottom；容器负 margin 抵消
          最后一行的那一段，使「历史段末尾 → 尾段首行」仍只有一个行列间距。 */}
      {historyVirtualRows.length > 0 && (
        <div className="chat-virtual" style={{ height: historyVirtualSize }}>
          {virtualHistoryItems.map((item) => {
            const row = historyVirtualRows[item.index];
            if (row === undefined) return null;
            return (
              <div
                key={item.key}
                className="chat-virtual-row"
                data-index={item.index}
                data-virtual-key={row.entry.key}
                ref={virtualizer.measureElement}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <TranscriptRow
                  entry={row.entry}
                  index={row.index}
                  isCut={row.index === cutIndex}
                  doomed={cutIndex >= 0 && row.index >= cutIndex}
                  branchAfter={historySegment.branchRows.get(row.index)}
                  scope={historyScope}
                />
              </div>
            );
          })}
        </div>
      )}
      {tailTurnView.map((entry, index) => {
        const globalIndex = historySegment.turnView.length + index;
        return (
          <TranscriptRow
            key={entry.key}
            entry={entry}
            index={index}
            isCut={globalIndex === cutIndex}
            doomed={cutIndex >= 0 && globalIndex >= cutIndex}
            branchAfter={tailBranchRows.get(index)}
            scope={tailScope}
          />
        );
      })}
      {props.pendingEcho !== null && (
        // 与真回显同一个包裹层与 data-kind：发出即画的这一行也要有空心星 / 时间（子午线认 data-kind）
        <div className="revert-keep" data-kind="user">
          <PendingEchoRow blocks={props.pendingEcho.blocks} />
        </div>
      )}
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
          <div className="revert-keep" data-kind="responding">
            <Responding transcript={transcript} />
          </div>
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
 * 一行渲染的输入：历史段 / 尾段各一份作用域。历史段的 scope 在流式期间引用不变，
 * 行组件的 memo 才会命中（因此所有回调字段都是稳定引用，见 useStableCallback）。
 */
interface RowScope {
  /** 本段的大折叠视图（show_image 组要看前一个单元 / 向后扫画廊） */
  view: readonly TurnViewEntry[];
  /** 本段的记录（分支行的「复制回答」按整轮取文本） */
  records: readonly TranscriptRecord[];
  toolResults: ToolResultIndex;
  plan: PlanTimeline | null;
  ledger: GoalLedger;
  awaitingPlan: PlanVersion | null;
  branchRows: ReadonlyMap<number, string>;
  carryoverCards: ReadonlyMap<string, ScanAnswerCard>;
  interruptedCalls: ReadonlySet<string>;
  streamingIds: ReadonlySet<string>;
  activeThinkingKey: string | null;
  turnActive: boolean;
  /** 失败那轮的折叠 key（只可能落在尾段） */
  failedFold: string | null;
  toolsRunning: boolean;
  skills: SkillMeta[];
  channel: ChannelViewContext;
  cwd: string | null;
  undoneTurnIds: ReadonlySet<string>;
  memory: MemoryLines | null;
  actionsBusy: boolean;
  sessionId: string;
  onBranch: (anchorItemId: string) => void;
  onOpenTask: (sessionId: string) => void;
  onUndoTurn: (turnId: string) => void;
  onRevertTo: (messageId: string) => void;
  onOpenReviewAt?: (path: string) => void;
  onOpenIntentPanel?: () => void;
  onOpenMemoryReview?: () => void;
  /** 回退预演切点那条虚线的落点 */
  cutRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * 展开态记忆（模块级 Map，上限 1000）：行被虚拟化卸下再挂回来时恢复用户/自动
 * 最后选择的状态；没有记录时用组件自己的默认值。key 必须是稳定标识。
 */
function useFoldState(
  key: string,
  fallback = false,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const [open, setOpen] = useState(() => readFoldState(key) ?? fallback);
  const update = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setOpen((prev) => {
        const value = typeof next === "function" ? next(prev) : next;
        writeFoldState(key, value);
        return value;
      });
    },
    [key],
  );
  return [open, update];
}

/**
 * 稳定引用包装：行组件是 memo，回调本身逐帧换引用会让历史行整列重渲染。
 * 调用的永远是最新一版（ref 在渲染期更新；渲染期写 ref 是幂等的）。
 */
function useStableCallback<Args extends unknown[], R>(fn: (...args: Args) => R): (...args: Args) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: Args) => ref.current(...args), []);
}

/** 转录里的一行（memo）：流式期间只有尾段的 scope 变，历史行按引用复用。 */
const TranscriptRow = memo(function TranscriptRow(props: {
  entry: TurnViewEntry;
  /** 本段内的下标（show_image 看前一个单元用） */
  index: number;
  /** 回退预演的切点就在这一行之前（渲染那条虚线） */
  isCut: boolean;
  /** 在回退切点之后（变淡加删除线） */
  doomed: boolean;
  /** 这一行后面挂分支行（锚点消息 id） */
  branchAfter: string | undefined;
  scope: RowScope;
}) {
  const t = useT();
  const { entry, index, scope } = props;
  const branchAfter = props.branchAfter;
  // 复制与速度都按锚点所在的**整轮**取：轮内可能有多条 assistant 记录（每次 toolCall 切一条）
  const turnRecords = branchAfter !== undefined ? turnAssistantRecords(scope.records, branchAfter) : [];
  // 相邻 show_image 合并成一个画廊（2026-09-27 裁决）：首张渲染合并画廊，后续
  // 兄弟渲染 null（数据数组不动，branchRows 索引不乱）；失败的 show_image 不进
  // 合并——照通用红色骨架。判「组首」：自己是 show_image 且前一个不是
  const isShowCall =
    entry.kind === "toolCall" && entry.toolName === "show_image" && scope.toolResults.get(entry.toolCallId)?.status !== "error";
  const prevEntry = index > 0 ? scope.view[index - 1] : undefined;
  const prevIsShowCall =
    prevEntry !== undefined &&
    prevEntry.kind === "toolCall" &&
    prevEntry.toolName === "show_image" &&
    scope.toolResults.get(prevEntry.toolCallId)?.status !== "error";
  if (isShowCall) {
    if (prevIsShowCall) return null; // 已被前面的组吸收
    const cards: ShowImageCardView[] = [];
    for (let scan = index; scan < scope.view.length; scan++) {
      const candidate = scope.view[scan];
      if (
        candidate === undefined ||
        candidate.kind !== "toolCall" ||
        candidate.toolName !== "show_image"
      ) {
        break;
      }
      const card = showImageCard(scope.toolResults.get(candidate.toolCallId));
      if (card === null) break;
      cards.push(card);
    }
    return (
      <Fragment>
        {props.isCut && (
          <div ref={scope.cutRef} className="revert-cut">
            <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
            {t.chat.previewCut}
          </div>
        )}
        <div className={props.doomed ? "revert-doomed" : "revert-keep"} data-kind="toolCall">
        <ShowImageGalleryGroup cards={cards} />
        {branchAfter !== undefined && (
          <BranchRow
            /* 挂点照常渲染：被吸收的 entry 只把主行换 null，分支行各归各 */
            anchorItemId={branchAfter}
            speed={replySpeed(turnRecords)}
            copyText={answerText(turnRecords)}
            disabled={scope.toolsRunning}
            onBranch={scope.onBranch}
          />
        )}
        </div>
      </Fragment>
    );
  }
  const doomed = props.doomed;
  return (
    <Fragment>
      {props.isCut && (
        <div ref={scope.cutRef} className="revert-cut">
          <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
          {t.chat.previewCut}
        </div>
      )}
      <div className={doomed ? "revert-doomed" : "revert-keep"} data-entry-key={entry.key} data-kind={entry.kind}>
      {entry.kind === "turnProcess" ? (
        <TurnProcessLine
          unit={entry}
          plan={scope.plan}
          ledger={scope.ledger}
          awaitingPlan={scope.awaitingPlan}
          toolResults={scope.toolResults}
          turnFailed={entry.key === scope.failedFold}
          skills={scope.skills}
          interruptedCalls={scope.interruptedCalls}
          renderStep={(step) => (
            <EntryView
              key={step.key}
              entry={step}
              toolResults={scope.toolResults}
              activeThinkingKey={null}
              turnActive={false}
              interruptedCalls={scope.interruptedCalls}
              onOpenTask={scope.onOpenTask}
              carryoverCards={scope.carryoverCards}
              channel={scope.channel}
              skills={scope.skills}
              cwd={scope.cwd}
              undoneTurnIds={scope.undoneTurnIds}
              onUndoTurn={scope.onUndoTurn}
              actionsBusy={scope.actionsBusy}
              onOpenReviewAt={scope.onOpenReviewAt}
              onOpenIntentPanel={scope.onOpenIntentPanel}
              sessionId={scope.sessionId}
              onRevertTo={scope.onRevertTo}
              streamingIds={scope.streamingIds}
            />
          )}
        />
      ) : entry.kind === "turnGroup" ? (
        <TurnRollupLine
          group={entry}
          toolResults={scope.toolResults}
          turnFailed={entry.key === scope.failedFold}
          onOpenTask={scope.onOpenTask}
          carryoverCards={scope.carryoverCards}
          channel={scope.channel}
          skills={scope.skills}
          cwd={scope.cwd}
          undoneTurnIds={scope.undoneTurnIds}
          onUndoTurn={scope.onUndoTurn}
          actionsBusy={scope.actionsBusy}
          onOpenReviewAt={scope.onOpenReviewAt}
          sessionId={scope.sessionId}
          interruptedCalls={scope.interruptedCalls}
        />
      ) : (
        <EntryView
          entry={entry}
          toolResults={scope.toolResults}
          activeThinkingKey={scope.activeThinkingKey}
          turnActive={scope.turnActive}
          interruptedCalls={scope.interruptedCalls}
          onOpenTask={scope.onOpenTask}
          carryoverCards={scope.carryoverCards}
          channel={scope.channel}
          skills={scope.skills}
          cwd={scope.cwd}
          undoneTurnIds={scope.undoneTurnIds}
          onUndoTurn={scope.onUndoTurn}
          actionsBusy={scope.actionsBusy}
          onOpenReviewAt={scope.onOpenReviewAt}
          onOpenIntentPanel={scope.onOpenIntentPanel}
          sessionId={scope.sessionId}
          onRevertTo={scope.onRevertTo}
          streamingIds={scope.streamingIds}
          memory={scope.memory}
          onOpenMemoryReview={scope.onOpenMemoryReview}
        />
      )}
      {branchAfter !== undefined && (
        <BranchRow
          anchorItemId={branchAfter}
          speed={replySpeed(turnRecords)}
          copyText={answerText(turnRecords)}
          disabled={scope.toolsRunning}
          onBranch={scope.onBranch}
        />
      )}
      </div>
    </Fragment>
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
  /** 用户滚动意图（捕获阶段）：跟随态靠它区分用户滚动与程序化滚动，见 ChatViewBody */
  onWheelIntent?: ((event: React.WheelEvent<HTMLDivElement>) => void) | undefined;
  onTouchMoveIntent?: (() => void) | undefined;
  onPointerDownIntent?: ((event: React.PointerEvent<HTMLDivElement>) => void) | undefined;
  /**
   * 一键回底浮钮（feat/scroll-to-bottom-X）：非 null 才挂（只有主槽给）——浮在消息列
   * 底端靠右、输入卡上方；visible 由 ChatView 按距底 300px 重算，点击回底。骨架只管
   * 摆位，判定在 ChatViewBody。
   */
  scrollToEnd?: { visible: boolean; onClick: () => void } | null;
  /**
   * 传 true：不渲染卡内页头（主槽：会话信息住工具栏的会话胶囊；辅助对话：住右栏胶囊，
   * 对话卡从面板顶上直接开始）；子会话面板里的 ChatView 保留页头。
   */
  hideHeader?: boolean;
  /** 页头与消息列之间的一条通栏（自动化新开的会话：「任务名 · 第 n 次」+ 转成普通会话）；缺席不渲染 */
  banner?: React.ReactNode;
  /**
   * 转录上的悬浮提示（整段复制成功/失败）：绝对定位在滚动段底缘，不进文档流、
   * 不改变滚动高度；null 不渲染。
   */
  transcriptNotice?: string | null;
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
      className="chat-pane"
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        // 行数随页头有无切换（2026-10-19 修复：主槽删页头后若仍是三行，滚动区会
        // 掉进第一行 auto、输入卡掉进第二行 1fr——composer 卡在半空、下方一片空白）
        // 通栏（banner，自动化运行会话的顶部条）自己占一行 auto，不抢滚动区那一行 1fr
        gridTemplateRows: `${props.hideHeader === true ? "" : "auto "}${props.banner === undefined ? "" : "auto "}minmax(0,1fr) auto`,
      }}
    >
      {/* 卡内页头：主槽与辅助对话都 hideHeader（会话信息住顶部胶囊），目前只有子会话
          面板还在用；窗口拖拽由顶部工具栏整条接管，这里只是内容行 */}
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

      {props.banner}

      {/* 滚动段套一层定位容器：回底浮钮要浮在这段的底缘上，而不是随内容滚走。
          样式在 styles.css 的 .chat-scroll-seg（含 overflow: hidden——页脚很高时滚动段不越界盖到页脚下） */}
      <div className="chat-scroll-seg">
        <div
          ref={props.scrollRef}
          onScroll={props.onScroll}
          onWheelCapture={props.onWheelIntent}
          onTouchMoveCapture={props.onTouchMoveIntent}
          onPointerDownCapture={props.onPointerDownIntent}
          className="scroll chat-transcript"
          style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}
        >
          {/* 消息列：宽 / 居中 / 间距在 styles.css 的 .chat-col（非纸面主题要在左侧留一条索引边栏） */}
          <div className="chat-col">{props.children}</div>
        </div>
        {props.transcriptNotice != null && (
          <div className="chat-copy-notice" role="status" aria-live="polite">
            {props.transcriptNotice}
          </div>
        )}
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
            <div className="chat-float-col">
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
        <div className="chat-foot-col">{props.footer}</div>
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
      <Icon name={FEATURE_ICON.subsessions} size={12} strokeWidth={1.8} style={{ flex: "0 0 auto" }} />
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

  /**
   * 芯片的两种语义（2026-10-31 用户认可）：首页 = 「新任务放在哪」；对话里 = 「把这条移到哪」
   * ——以前对话里选别的工作区会清掉对话、去那边开空白新任务，这条会话本身不动，
   * 聊着发现该换地方时毫无办法。移动连工作目录一起换（session:move），在跑的不能移：
   * 项灰掉并说明原因，不弹窗。
   */
  const moving = session.inConversation;
  /** 一项菜单的行为：按 scopeChipAction 接到 onSelect / disabled 上 */
  const scopeEntry = (target: string | null, newTask: () => void): Partial<MenuItem> => {
    const action = scopeChipAction({
      inConversation: moving,
      running: session.phase !== "idle",
      isCurrent: session.workspaceId === target,
    });
    if (action === "new-task") return { onSelect: newTask };
    if (action === "move") return { onSelect: () => session.moveCurrentTo(target) };
    if (action === "blocked") return { disabled: true, hint: t.chat.moveBlocked };
    return { onSelect: () => undefined };
  };
  const scopeItems: MenuItem[] = [
    ...(moving ? [{ id: "move-header", label: t.chat.moveHeader, header: true } satisfies MenuItem] : []),
    {
      id: "home",
      label: t.chat.home,
      icon: "folder",
      // 路径副行（mono 注脚）：主行报名字，副行说它在哪。路径的**尾段才是名字**
      // （/Users/dama/Desktop/orbita → orbita），所以从头部省略，别把唯一有信息量的那段切掉
      subLabel: session.defaultCwd,
      subLabelMono: true,
      subLabelEllipsis: "head",
      checked: session.workspaceId === null && (moving || session.cwd === null),
      ...scopeEntry(null, session.newTask),
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
      ...scopeEntry(item.id, () => session.newTaskIn(item)),
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
                // 对话里：加进来的文件夹直接成为这条会话的新家（在跑时只加不移，主进程会跳过）
                session.addWorkspace({ moveCurrent: moving });
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
                if (trimmed !== "") session.createWorkspace(trimmed, { moveCurrent: moving });
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
          icon={FEATURE_ICON.intent}
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
          // 关着的服务商不列，菜单底部灰字行的「去模型服务打开」走同一个去向
          onOpenProviders={props.onOpenProviders}
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
            // 档位芯片：宽 84 是为了「Off → Extra high」切换时不跳；挤的时候要能让（见 styles.css 的 .chip-think）
            className="chip-think"
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
  carryoverCards: ReadonlyMap<string, ScanAnswerCard>;
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
  /** 记忆行：挂在用户气泡下；undefined = 不画 */
  memory?: MemoryLines | null;
  onOpenMemoryReview?: () => void;
  /** 产物打开按钮的会话对账（主进程白名单按它查） */
  sessionId: string;
}) {
  const t = useT();
  const runSessionIds = useAutomationRunSessions();
  const { entry } = props;
  if (entry.kind === "compacted") return <CompactedLine record={entry.record} />;
  if (entry.kind === "user") {
    // this_session 的自动化叫醒这条会话的那一轮：细分隔线（指令正文点开看）。
    // 自动化新开的运行会话里第一条消息照常画气泡——那里顶部有「任务名 · 第 n 次」的条
    const firstText = entry.item.content.find((block) => block.type === "text");
    const wake =
      firstText !== undefined && firstText.type === "text" && !runSessionIds.has(props.sessionId)
        ? parseAutomationHeader(firstText.text)
        : null;
    if (wake !== null) {
      return (
        <AutomationWakeLine title={wake.title} number={wake.number} max={wake.max} stamp={wake.stamp} body={wake.body} />
      );
    }
    const memoryRow = props.memory?.rows.get(entry.item.id);
    return (
      <UserBubble
        item={entry.item}
        onRevertTo={props.onRevertTo}
        revertDisabled={props.actionsBusy || props.readOnly === true}
        revertDisabledWhy={props.readOnly ? t.chat.revertReadOnly : t.chat.revertBusy}
        memory={memoryRow}
        onOpenMemoryReview={props.onOpenMemoryReview}
      />
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
        sessionId={props.sessionId}
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
      sessionId={props.sessionId}
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
  carryoverCards: ReadonlyMap<string, ScanAnswerCard>;
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
  const [open, setOpen] = useFoldState(`rollup:${props.group.key}`);
  const { group } = props;
  // 「今天只写时分」的档位随日历日走：跨午夜翻档（today.ts 的 useToday）
  const today = useToday();
  const stats = turnStats({ ...group, members: [...group.members, ...group.hoisted] }, props.toolResults, Date.now(), props.skills);
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
        {toolWord(t.chat.rollupTool, toolName)} {count}
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
      {/* 折叠外的后台命令行：在折叠行下面一直铺着（成员里已摘掉，见 TurnGroupUnit.hoisted） */}
      {group.hoisted.map((call) => (
        <EntryView
          key={call.key}
          entry={call}
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
  /** 记忆：这一轮用到 / 记住的；undefined = 这一轮没账（不画） */
  memory?: MemorySessionTurnView;
  /** 展开清单底部的「在审查面板里看」（改 / 删 / 别再用在那里） */
  onOpenMemoryReview?: () => void;
}) {
  const t = useT();
  const today = useToday();
  const [copied, setCopied] = useState(false);
  // 记忆清单开着哪一份（用到 / 记住）；同一时刻至多一份，再点同一个收起
  const [memoryOpen, setMemoryOpen] = useState<"used" | "remembered" | null>(null);
  const usedMemories = props.memory?.used ?? [];
  const rememberedMemories = props.memory?.remembered ?? [];
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
    <div className="user-turn" data-clamped={!expanded && overflowing ? "true" : undefined}>
      {images.length > 0 && <UserImages images={images} />}
      {quotes.length > 0 && (
        <div className="user-mat user-mat-grid">
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
        <div className="user-mat user-mat-wrap">
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
        <div className="user-mat user-mat-wrap">
          {pastedBlocks.map((block, index) => (
            <PastedTextChip key={`pasted:${index}`} text={block.content} lines={block.lines} />
          ))}
        </div>
      )}
      {hasText && (
        <div className="user-bubble" data-quote-id={props.item.id} data-quote-role="user">
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
      <div className="msg-acts">
        {/* 记忆挂在用到它的那句话旁边（原型 .memrow，2026-10-30「信息挂在用到它的地方、按需展开」）：
            「用到 N」= 这一轮开始前召回注入的条目，「记住 M」= 这一轮整理出的新条目。点开在下面列出是哪几条；
            0 条的那枚不画。图标只给排在前面的那一枚 */}
        {usedMemories.length > 0 && (
          <button
            type="button"
            className="memrow-btn"
            title={t.memory.usedHint}
            aria-pressed={memoryOpen === "used"}
            onClick={() => setMemoryOpen((open) => (open === "used" ? null : "used"))}
          >
            <Icon name={FEATURE_ICON.memory} size={12} strokeWidth={1.8} />
            {t.memory.used(usedMemories.length)}
          </button>
        )}
        {rememberedMemories.length > 0 && (
          <button
            type="button"
            className="memrow-btn"
            title={t.memory.rememberedHint}
            aria-pressed={memoryOpen === "remembered"}
            onClick={() => setMemoryOpen((open) => (open === "remembered" ? null : "remembered"))}
          >
            {usedMemories.length === 0 && <Icon name={FEATURE_ICON.memory} size={12} strokeWidth={1.8} />}
            {t.memory.remembered(rememberedMemories.length)}
          </button>
        )}
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
      {memoryOpen !== null && (
        <div className="memrow-list">
          <ul>
            {memoryOpen === "used"
              ? usedMemories.map((hit) => <li key={hit.id}>{hit.text}</li>)
              : rememberedMemories.map((view) => <li key={view.entry.id}>{view.entry.text}</li>)}
          </ul>
          {props.onOpenMemoryReview !== undefined && (
            <button type="button" className="mem-link" onClick={props.onOpenMemoryReview}>
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
 * 旧转录 `<skill>` 块的折叠卡（pi TUI 同款形态）：默认一行「skill 名」，点开看
 * 全文——skill 正文几千字，收着才不淹没对话。2026-10-02 起 `/skill:` 改指令式，
 * 新消息不再产生这种块，这张卡只服务存量会话的显示。在右对齐的气泡列里要
 * fit-content 宽度，不复用 CollapseRow（那套是全宽的工具行骨架）。
 */
function SkillInvocationCard(props: { name: string; content: string }) {
  const [open, setOpen] = useFoldState(`skill:${props.name}`);
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
    // 排版在 styles.css 的 .user-images：靠左还是靠右跟着主题的用户消息版式走，
    // 写在内联 style 里主题块覆盖不到（子午线版式上线后图片就这样落在了右边）
    <div className="user-images">
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
 *
 * `trailing`：行尾的**真按钮**（目前只有 bash 活行的停止钮）。它必须是折叠按钮的
 * 兄弟而不是子元素——button 不能嵌 button（SubSessionsPanel 同一条规矩），否则点击
 * 要 stopPropagation、读屏器也只看到一个奇怪的嵌套控件。
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
  /** 计划的版本线（没写过计划 = null） */
  plan: PlanTimeline | null;
  /** 目标与计划的改动账（目标改了的那一行） */
  ledger: GoalLedger;
  /** 停下来等你回答的那一版；这个块里的计划调用正是它时画（只读的）计划卡 */
  awaitingPlan: PlanVersion | null;
  toolResults: ToolResultIndex;
  turnFailed: boolean;
  skills: SkillMeta[];
  interruptedCalls: ReadonlySet<string>;
  renderStep: (step: ProcessStep) => ReactNode;
}) {
  const t = useT();
  const today = useToday();
  const { unit } = props;
  const [open, setOpen] = useFoldState(`proc:${unit.key}`);
  const live = unit.live && !unit.answering;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!unit.live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [unit.live]);
  const counts = processCounts([...unit.steps, ...unit.hoisted], props.toolResults, props.skills);
  // 这个块里计划改了什么（每块最多一行；只打勾不提示），与现在在做的是计划里哪一步
  const planCallIds = processCalls(unit.steps)
    .filter((call) => call.toolName === PLAN_TOOL_NAME)
    .map((call) => call.toolCallId);
  const planNotice = planNoticeOf(props.plan, planCallIds);
  const planNoticeLine = planNotice === null ? null : planNoticeText(t, planNotice);
  // 这个块里目标改了没有（第一次定目标不算改）
  const goalNoticeLine = goalNoticeText(
    t,
    props.ledger,
    processCalls(unit.steps)
      .filter((call) => call.toolName === GOAL_TOOL_NAME)
      .map((call) => call.toolCallId),
  );
  const planStepNow = props.plan?.current.items.find((item) => item.status === "in_progress")?.text ?? null;
  const toolChips = counts.byTool.slice(0, 4).map(({ key, count }) => (
    <span key={key}>
      {toolWord(t.chat.rollupTool, key)} {count}
    </span>
  ));
  // 折叠外的后台命令行（还在跑的 bash 会话）：**一直在场**，不随块展开/收起消失——
  // 秒针、上限、停止钮都在这一行上，它是人唯一的兜底入口。
  const hoistedRows = unit.hoisted.length === 0 ? null : (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      {unit.hoisted.map((call) => (
        <Fragment key={call.key}>{props.renderStep(call)}</Fragment>
      ))}
    </div>
  );
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
    const verb = (toolName: string, input: unknown) => toolWord(t.chat.rollupTool, rollupToolKey(toolName, input, props.skills), input);
    return (
      <>
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
          <div className={`proc-chapter${snap.chapter?.source === "think" ? " think" : ""}`}>
            {planStepNow !== null && <span className="proc-plan-step">{planStepNow}</span>}
            {snap.chapter !== null && <InlineMarks text={snap.chapter.title} />}
          </div>
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
                <code>{toolCallSummaryForRow(item.call.toolName, item.call.input, props.skills) ?? ""}</code>
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
                  <code>{toolCallSummaryForRow(current.call.toolName, current.call.input, props.skills) ?? ""}</code>
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
          <div className={slow ? "proc-foot slow" : "proc-foot"}>{slow ? t.chat.processSlow : (tail ?? goalNoticeLine ?? planNoticeLine ?? "")}</div>
        </div>
        {hoistedRows}
      </>
    );
  }

  // 一步工具都没跑的轮说它做了什么（想了想 / 更新了计划），不写「0 步」（processOutcome）
  const result = processOutcome(counts, [...unit.steps, ...unit.hoisted]);
  const outcome =
    result.kind === "thought"
      ? t.chat.processThoughtOnly
      : result.kind === "plan"
        ? t.chat.processPlanOnly
        : [...(result.files > 0 ? [t.chat.processWrote(result.files)] : []), t.chat.processSteps(result.steps)].join(" · ");
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
      {hoistedRows}
      {open && (
        <ol className="proc-chapters">
          {processChapters(unit.steps).map((chapter) => (
            <ProcessChapterItem key={chapter.key} chapter={chapter} {...props} />
          ))}
        </ol>
      )}
      {goalNoticeLine !== null && <Notice icon="pencil-line">{goalNoticeLine}</Notice>}
      {planNoticeLine !== null && <Notice icon="pencil-line">{planNoticeLine}</Notice>}
      {props.awaitingPlan !== null && planCallIds.includes(props.awaitingPlan.toolCallId) && (
        <PlanCard version={props.awaitingPlan} />
      )}
    </div>
  );
}

/** 章节时间线的一章：标题 + 前几步的小标签；点开看这一章的每一步（原样的工具行） */
/**
 * 落在文档文件上的 edit / write 的摘要：「文件名 · 第几节」（节取自 edit 结果的 diff 上下文，退到此刻开着的文档全文）。
 * 不是文档上的 edit / write 返回 null，调用方用通用摘要。
 */
function docEditCallLabel(toolName: string, input: unknown, result: ToolTranscriptItem | undefined): string | null {
  const path = docEditPath(toolName, input);
  if (path === null) return null;
  const diff = toolName === "edit" && result !== undefined && result.status !== "running" ? editDiffText(result) : null;
  return docEditSummary(path, diff === null ? null : docEditSection(parseEditDiff(diff), getOpenDocumentText(path)));
}

function ProcessChapterItem(props: {
  chapter: ProcessChapter;
  toolResults: ToolResultIndex;
  skills: SkillMeta[];
  renderStep: (step: ProcessStep) => ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useFoldState(`chapter:${props.chapter.key}`);
  const { chapter } = props;
  const failed = chapter.calls.some((call) => props.toolResults.get(call.toolCallId)?.status === "error");
  const title =
    chapter.title ??
    t.chat.processToolsTitle(
      processCounts(chapter.steps, props.toolResults, props.skills)
        .byTool.map(({ key, count }) => t.chat.processToolPart(toolWord(t.chat.rollupTool, key), count))
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
        <span className={chapter.source === "say" ? "proc-ch-title" : "proc-ch-title think"}>
          <InlineMarks text={title} />
        </span>
        {chapter.calls.length > 0 && (
          <span className="proc-ch-steps">
            {shown.map((call) => (
              <span key={call.toolCallId} className={props.toolResults.get(call.toolCallId)?.status === "error" ? "bad" : undefined}>
                {toolWord(t.chat.rollupTool, rollupToolKey(call.toolName, call.input, props.skills), call.input)}{" "}
                {docEditCallLabel(call.toolName, call.input, props.toolResults.get(call.toolCallId)) ?? toolCallSummaryForRow(call.toolName, call.input, props.skills) ?? ""}
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
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  const interactive = props.disabled !== true;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        minWidth: 0,
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
      }}
    >
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
          flex: "1 1 auto",
          minWidth: 0,
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
      {props.trailing}
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
      // 内置命令（builtin-commands.ts）：图标由注册表项给
      // MCP 工具（mcp__server__tool）：专属插头图标——外部能力，与内置工具一眼区分
      return builtinCommand(toolName)?.icon ?? (parseQualifiedToolName(toolName) !== null ? "plug" : "wrench");
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
  /** 会话 id：后台 bash 会话的 owner，活行的状态轮询拿它去查；
   * install_plugin 那一行点「安装」也要带会话（主进程按它重验工作区） */
  sessionId: string;
}) {
  const t = useT();
  const [open, setOpen] = useFoldState(`tool:${props.toolCallId}`);
  const { result } = props;
  const failed = result?.status === "error";
  // 已中断：无结果帧且判定永不回来——不算运行中（不呼吸、不展开、状态词换「已中断」）
  const interrupted = props.interrupted && result === undefined;
  const active = !interrupted && (result === undefined || result.status === "running");
  // ── 运行中 shell 的可见性（长 bash 不再「一行不动」）。active 已含「中断不算
  // 运行」（PR 168）：被中断的 bash 不计时、不自动展开，与真跑着的命令分流 ──
  const shell = props.toolName === "bash" || props.toolName === "powershell";
  const shellActive = shell && active;
  // ── bash 活行：签到交还之后，这一行原地变成后台会话的观察窗 ──
  // 交还事实从工具结果尾部的 `[orbita] kind=detached session=b1 elapsed=302s` 认出来；
  // 结束事实来自 runtime 写回的那条终态记录（同 toolCallId，details 带 orbitaBash）。
  // 认不出（短命令、旧记录的普通 bash）就没有活行，整块逻辑自然退化成今天的行。
  const bashNotice = shell ? detachedBashNotice(result) : null;
  const bashResult = shell ? bashResultOf(result) : null;
  const bashId = bashNotice?.sessionId ?? bashResult?.sessionId ?? null;
  // 交还了、还没有落定记录：这条命令还在后台跑（或者结果正在回来的路上）
  const bashRunning = bashNotice !== null && bashResult === null;
  // ── 这一行**真的**还活着吗 ──
  // 交还提示是某个 agent 进程写下的事实，而会话表在**那个进程的内存里**：应用一重启
  // 表就空了、命令连同进程树一起没了，转录里这一行却还在。不查就会一直假装在跑
  // （秒针天天涨、停止钮挂着、结果永远不会回来）。
  // 判据交给会话表的 owner（`bashSessions`）：快照带着回答它的进程标识，与提示里的
  // `run=` 对不上就是上个进程留下的（失联）；对不上 id 也一样。
  // null = 没问出来（超时）——那是不知道，维持原判，不拿空快照诬告失联。
  const [bashSnapshot, setBashSnapshot] = useState<BashSessionsSnapshot | null>(null);
  useEffect(() => {
    if (!bashRunning) {
      setBashSnapshot(null);
      return;
    }
    let alive = true;
    const ask = () => {
      void api.agent
        .bashSessions(props.sessionId)
        .then((snapshot) => {
          if (alive && snapshot !== null) setBashSnapshot(snapshot);
        })
        .catch(() => undefined);
    };
    ask();
    // 20 秒复查一次：内核进程半途没了（崩了 / 被换掉），这一行也不该再装一小时的活人。
    // 问不拉进程（主进程直接回空快照），代价只是一次 IPC。
    const timer = window.setInterval(ask, 20_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [bashRunning, props.sessionId]);
  const bashLost = bashNotice !== null && bashSnapshot !== null && !detachedNoticeIsLive(bashNotice, bashSnapshot);
  // 另一种死法：快照的进程标识与提示里的不一样 = 中途换过进程（应用重启 / 内核重启）
  const bashLostToRestart =
    bashLost &&
    bashSnapshot !== null &&
    bashNotice !== null &&
    bashNotice.runId !== undefined &&
    bashNotice.runId !== bashSnapshot.runId;
  // 还在跑的行：交还没落定、也没失联。停止钮、秒针、活色都只认它
  const bashLive = bashRunning && !bashLost;
  // 秒针：只挂「跑着的东西」——运行中的 shell（Responding 同款，一秒一跳）与
  // 后台活行（**本地外推**：从 detach 时已跑的秒数 + 之后本地走过的秒数，
  // 不发任何 IPC）。睡眠中的命令没有任何事件帧，计时只能自己跳。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shellActive && !bashLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shellActive, bashLive]);
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

  // install_plugin：留下的是一行「已装上 X · [卸载]」或「装上 X　[安装] [看详情]」，不是「调用 + 摘要」。
  // 失败 / 没有那一行（already）/ 还在跑照通用骨架走
  if (props.toolName === "install_plugin") {
    const row = pluginInstallRowOf(result);
    if (row !== null) return <PluginInstallLine row={row} sessionId={props.sessionId ?? null} />;
  }
  // show_plugin_board：留下的是一块看板（BoardGrid，按快照画），不是「调用 + 摘要」。
  // 失败 / 还在跑 / 形状不对照通用骨架走
  if (props.toolName === "show_plugin_board") {
    const board = pluginBoardOf(result);
    if (board !== null) return <PluginBoardResultView toolCallId={props.toolCallId} board={board} />;
  }
  // 子会话通道工具（子会话 PR4a）：三个工具的信息形状不是「调用 + 摘要」，各自
  // 早退，不复用下面的通用骨架。**三个都不在失败时早退**——照 ToolLine 的失败
  // 样式走（红色 triangle-alert + 可展开看错误），不能被派出卡/标记行的「成功
  // 语气」盖过去。delegate 若在此早退，一次真实失败会被 DelegateCardView 的
  // running 帧（`card === null` 时的「delegating…」呼吸）悄悄吞掉，永远显示
  // 「派出中」而不是「失败了」。
  // 自动化：automation_create 的结果是一张卡（在右栏查看 / 暂停）；失败照通用骨架走
  if (props.toolName === "automation_create" && !failed) {
    return <AutomationToolLine result={result} interrupted={interrupted} sessionId={props.sessionId} />;
  }
  // automation_update：留下的是一行「已改成放行 [改回只读]」或「让它到点能写文件？[允许] [保持只读]」；
  // 失败 / 没留行（改成只读、本来就是放行）/ 还在跑照通用骨架走
  if (props.toolName === "automation_update") {
    const modeRow = automationModeRowOf(result);
    if (modeRow !== null) return <AutomationModeLine row={modeRow} sessionId={props.sessionId ?? null} />;
  }
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
  const builtin = builtinCommand(props.toolName);
  // 落在文档文件上的 edit / write：药丸写「改文档 / 写文档」（其余照旧）
  const docEdit = docEditLabel(props.toolName, props.input);
  // 路径类工具的摘要只显示文件名——Windows 上模型几乎总传绝对路径，整条 C:\... 是噪音；
  // 完整路径进 tooltip。toolCallSummary 本身保持原始 path 语义（editGroupFileCount 靠它去重）
  const pathTool =
    props.toolName === "read" ||
    props.toolName === "write" ||
    props.toolName === "edit" ||
    props.toolName === "ls";
  // 收起态不显示命令（A 版，用户已拍板）：长命令会把行尾的机器事实与停止钮挤掉，
  // 命令全文在展开体顶部的命令专位。这里一并把摘要置空，省于后续每帧的比较。
  const baseCallLabel = !showsCallSummary(props.toolName)
    ? null
    : callSummary !== null && pathTool
      ? splitPathTail(callSummary).name
      : callSummary;
  // 命令全文（bash 的入参里就是它）：收起态不再显示，展开体顶部的命令专位用
  const command = shell ? callSummary : null;
  // 跑着的 shell 有实时增量可展，其余工具跑完才有完整结果（见 toolExpandable）
  const expandable = toolExpandable(result, props.toolName);
  const live = expandable && active;
  const finished = result !== undefined && result.status !== "running";
  // B-1：read_task 落定后 details 里带任务卡（running/error 帧没有）；别的工具不解析
  const taskCard = props.toolName === "read_task" && finished ? readTaskCard(result) : null;
  const diff = finished ? editDiffText(result) : null;
  // 落在文档上的 edit / write：摘要写「文件名 · 第几节」
  const docLabel = docEditCallLabel(props.toolName, props.input, finished ? result : undefined);
  const callLabel = docLabel ?? baseCallLabel;
  const stats = finished ? editDiffStats(result) : null;
  // 正文只在**真要用**时才拼：`toolResultText` 把结果里每个 text 块 join 成一整条
  // （实测单条最大 479KB），而折叠着的工具行只有两处需要它——展开体（open）与
  // 跑着的 shell 的活尾预览（shellActive）。活跃轮的组行默认铺开，一轮几十个工具时
  // 这条 join 会随每一帧流式更新重跑几十遍，全是白付的分配；落定的成员行更不必说。
  // 内置命令成功后展开：给人看的几行（失败 / 没有 detail 的命令走原样结果文本）
  const builtinRows = builtin !== null && finished && !failed && result !== undefined ? (builtin.detail?.(props.input, result.details) ?? null) : null;
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

  // ── bash 活行的事实槽（A 版）──
  // 收起态**一个字都不给命令**（用户拍了 A 版）：长命令会把行尾的机器事实与停止钮
  // 挤掉，而命令全文在展开体的命令专位。跑着的行只给一个本地秒针，落定后换成结果词。
  const bashFacts =
    bashResult !== null
      ? bashResultFacts(bashResult, t)
      : bashNotice !== null && bashLost
        ? bashLostFacts(bashNotice, t, bashLostToRestart)
        : bashNotice !== null
          ? bashLiveFacts(
              bashNotice,
              bashLiveSeconds(
                bashNotice,
                bashNotice.elapsedSeconds,
                now - (result?.timestamp ?? now),
              ),
              t,
            )
          : null;
  const bashFactsColor =
    bashFacts === null
      ? undefined
      : bashFacts.tone === "danger"
        ? "var(--color-danger)"
        : bashFacts.tone === "live"
          ? "var(--color-text-secondary)"
          : "var(--color-text-tertiary)";
  // 活行的图标：被停 / 被上限杀掉不再假装是终端（同「已中断」那一枚 circle-off）；
  // 失联也一样——这一行没有任何东西在跑了
  const bashIcon: IconName | null = bashResult?.status === "killed" || bashLost ? "circle-off" : null;
  // 只有 shell 类值得看耗时（read/edit 毫秒级是噪音）；旧会话没见过 running 帧，量不到就没有。
  // 交还成后台会话的行不给这个数：它只是「交还时已经跑了多久」，真总量在事实槽的共 X 里
  const shellDuration =
    shell && !active && bashFacts === null ? toolDurationText(props.toolCallId, t) : null;
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

  // 事实槽占位时，摘要与耗时都是同一件事的第二遍（且会把行尾挤爆）——让位
  const showSummary =
    summary !== null && !active && stats === null && writeLines === null && builtin === null && bashFacts === null;

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
              {skillUse !== null ? t.chat.rollupTool("skill") : "mcp"}
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
      <CollapseRow
        open={open}
        disabled={!expandable}
        onToggle={toggleOpen}
        // 停止钮是真按钮，只能是折叠按钮的兄弟（button 不能嵌 button）。
        // 常驻而不是悬停：这条行可能挂一小时，想停的时候人不该先学会悬停。
        trailing={
          bashLive && bashId !== null ? <BashStopButton sessionId={props.sessionId} bashId={bashId} /> : undefined
        }
      >
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span
            style={{
              color: failed
                ? "var(--color-danger)"
                : bashFacts?.tone === "danger"
                  ? "var(--color-danger)"
                  : headIconColor(active || bashLive),
            }}
          >
            <Icon
              name={
                failed
                  ? "triangle-alert"
                  : interrupted
                    ? "circle-off"
                    : skillUse !== null
                      ? "book-open"
                      : (bashIcon ?? toolIcon(props.toolName))
              }
              size={14}
              strokeWidth={1.8}
            />
          </span>
          {builtin !== null || docEdit !== null ? (
            <span className="command-pill" style={headLabel(active || bashLive)}>
              {builtin?.label ?? docEdit}
            </span>
          ) : (
            <span style={headLabel(active || bashLive)}>{props.toolName}</span>
          )}
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
        {/* bash 活行的事实槽：跑着是 `b1 · 已 12:34 · 无输出 2:10`，落定换成
            结果词（退出 0 / 已停止 / 已终止 · 上限）。钉在行的右血线上 */}
        {bashFacts !== null && (
          <span
            className="row-trailing"
            style={{ ...SLOT.status, color: bashFactsColor, fontFamily: "var(--font-family-mono)" }}
          >
            {bashFacts.text}
          </span>
        )}
        {/* 有统计时「N lines」是同一量级的第二遍，让位 */}
        {showSummary && (
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
      {/* 内置命令的完成卡（pinCard 的命令，如 slides_create）：折叠之外、点击在右栏打开 */}
      {builtin?.pinCard === true && finished && !failed && <CommandCard details={result?.details} />}
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
      {open && expandable && diff === null && fileView === null && builtinRows !== null && <BuiltinDetailBody rows={builtinRows} />}
      {open && expandable && diff === null && fileView === null && builtinRows === null && shell && command !== null && (
        // bash 的展开体：命令专位（$ + 全文 + copy）在上，输出在下，同一个虚线框
        <ShellToolBody
          command={command}
          text={imagelessBody}
          failed={failed}
          live={live}
          pendingResult={bashLive}
        />
      )}
      {open && expandable && diff === null && fileView === null && builtinRows === null && (!shell || command === null) && (
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
 * 内置命令的展开体：给人看的几行「标题 / 画幅 / 文件」，替代写给模型的原样结果文本
 * （builtin-commands.ts 的 `detail`）。失败时不走这里——错误原文才有用。
 */
function BuiltinDetailBody(props: { rows: readonly DetailRow[] }) {
  return (
    <div
      style={{
        ...EXPANDED_FRAME,
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr)",
        columnGap: "var(--space-3)",
        rowGap: "var(--space-1)",
        padding: "var(--space-2)",
        fontSize: "var(--font-size-sm)",
        lineHeight: "var(--line-height-code)",
      }}
    >
      {props.rows.map((row) => (
        <Fragment key={row.label}>
          <span style={{ color: "var(--color-text-tertiary)" }}>{row.label}</span>
          <span
            style={{
              color: "var(--color-text-primary)",
              overflowWrap: "anywhere",
              ...(row.mono === true ? { fontFamily: "var(--font-family-mono)" } : {}),
            }}
          >
            {row.value}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * bash 活行的行尾停止钮（**点一下直接停**，没有两段式确认）。
 *
 * 用户 2026-11-13 裁决：命令本来就跑在非交互环境里，误停的代价远小于「点两下才停」
 * 在长构建上耽误的时间。hover 变红与 disabled 态保留——那是「这是个会杀进程的按钮」
 * 的信号，不是确认流程。
 *
 * 走 `agent:bash-stop`（四层契约）：主进程转给 agent 进程按 **owner** 停——只有
 * 这条会话自己的命令停得掉，别的会话的同名 id 在这里当不存在。**没有回执**：
 * 停完的落定态来自 runtime 写回对话的那条终态记录。
 */
function BashStopButton(props: { sessionId: string; bashId: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="bash-stop"
      title={t.chat.stopBash(props.bashId)}
      aria-label={t.chat.stopBash(props.bashId)}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        // 停失败（进程刚退 / runtime 不在）：不抹黑也不装作停掉了，结果记录到了自然落定
        void api.agent.stopBashSession(props.sessionId, props.bashId).catch(() => undefined).finally(() => setBusy(false));
      }}
    >
      <Icon name="square" size={13} strokeWidth={2} />
    </button>
  );
}

/**
 * bash 的展开体（A 版）：**命令专位 + 发丝线 + 输出**，同一个圆角虚线框。
 *
 * 命令是这一行的身份，可它一长就会把行尾的机器事实与停止钮挤掉——所以收起态
 * 一个字都不给（只留 `bash`），全文放到这里：`$` 提示符（不参与选中）、等宽、
 * **只在空格处换行**（`break-word` 会把 `--reporter=verbose` 拆成 `--` + `reporter`，
 * 命令行就读不得了）、可选中、行尾一枚 quiet-control 的 copy。
 *
 * 输出与今天的工具行一致（mono、贴底跟随、首尾截断都照旧），只是从属于同一个框；
 * 交还提示行 `[orbita] kind=…` 是给模型与渲染层看的协议，不进人看的那一面
 * （事实槽已经把它说成「已 12:34」）。
 */
function ShellToolBody(props: {
  command: string;
  text: string;
  failed: boolean;
  live: boolean;
  /** 已交还、结果还没回来：没有输出时说「结果见下方」，不撒谎说「没有输出」 */
  pendingResult: boolean;
}) {
  const t = useT();
  const follow = useFollowScroll(props.live);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  // 协议行进仓库之前就丢掉：它们属于机器，不是命令的输出（交还行与落定行都以
  // `[orbita] ` 开头，那是我们保留的前缀；模型在 pi 本子里仍读得到落定行）
  const text = stripTrailingBlankLines(
    props.text
      .split("\n")
      .filter((line) => !line.startsWith("[orbita] "))
      .join("\n"),
  );
  const clamped = clampToolBody(text);
  const truncationNote =
    clamped.omitted === null ? null : (
      <div style={TRUNCATION_NOTE}>{t.chat.bodyTruncated(clamped.omitted.lines, clamped.omitted.chars)}</div>
    );
  const lineColor = props.failed ? "var(--color-danger)" : "var(--color-text-secondary)";
  return (
    <div style={{ ...EXPANDED_FRAME, minWidth: 0, overflow: "hidden" }}>
      <div className="bash-command">
        <span className="bash-prompt" aria-hidden="true">
          $
        </span>
        <code>{props.command}</code>
        <button
          type="button"
          className={copied ? "bash-copy copied" : "bash-copy"}
          title={copied ? t.chat.copied : t.chat.copyCommand}
          aria-label={copied ? t.chat.copied : t.chat.copyCommand}
          onClick={() => {
            void navigator.clipboard.writeText(props.command).then(
              () => setCopied(true),
              () => undefined,
            );
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={13} strokeWidth={1.8} />
        </button>
      </div>
      <div className="bash-command-sep" />
      <div ref={follow.ref} onScroll={follow.onScroll} className="scroll bash-output">
        {text === "" ? (
          <div style={{ ...BODY_LINE, color: "var(--color-text-tertiary)" }}>
            {props.live
              ? t.chat.waitingOutput
              : props.pendingResult
                ? t.chat.bashResultBelow
                : t.chat.noOutput}
          </div>
        ) : (
          clamped.head.map((line, index) => (
            <div key={index} style={{ ...BODY_LINE, color: lineColor }}>
              {line === "" ? " " : line}
            </div>
          ))
        )}
        {truncationNote}
        {clamped.tail.map((line, index) => (
          <div key={`tail-${index}`} style={{ ...BODY_LINE, color: lineColor }}>
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
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
  /** 成员的 bash 活行靠它查后台会话状态（成员行与组头同一个会话） */
  sessionId: string;
}) {
  const t = useT();
  const { group } = props;
  // 挂载时的相态决定初始展开：活跃轮里长出来的组铺开，idle 会话（旧历史）收着。
  // 卸载再挂回时优先恢复用户最后的选择；只有「活跃 → 落定」这个真转场才自动收。
  const [open, setOpen] = useFoldState(`toolgroup:${group.key}`, props.turnActive);
  const wasActive = useRef(props.turnActive);
  useEffect(() => {
    if (wasActive.current && !props.turnActive) setOpen(false);
    wasActive.current = props.turnActive;
  }, [props.turnActive, setOpen]);

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
              sessionId={props.sessionId}
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
 * 思考行：brain 图标（进行中保持 info 蓝——全转写里唯一的蓝记号）+「思考」
 * label + 副标。副标是时间态：**流式中**是活尾预览（新的一行顶替上一行）；
 * **落定**换成秒数（`3s`，现场计时，重开的旧会话量不到就什么都不显示）。
 * 行首呼吸同其它过程行：进行中 secondary + 呼吸，写完呼吸与高亮一起消失。
 * 要看全文点开，展开体 160px 封顶滚动；**流式中展开会贴底跟随**（上滚脱离、
 * 回底恢复），落定后内容定格，跟随停止。
 */
function ThinkingLine(props: { text: string; active: boolean; blockKey: string }) {
  const t = useT();
  const [open, setOpen] = useFoldState(`thinking:${props.blockKey}`);
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
  const [open, setOpen] = useFoldState(`compacted:${props.record.id}`);
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
