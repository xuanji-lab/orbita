import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { ApprovalBar } from "./ApprovalBar";
import { QueueStrip } from "./QueueStrip";
import { compactionBoundaryStatus, mergeSideRecords } from "./session-states";
import {
  ChannelMarkLine,
  ChannelTaskCard,
  ChannelToolMarkLine,
  DelegateCardView,
  peerTitleOf,
  type ChannelViewContext,
  type DelegateCardStatus,
} from "./ChannelViews";
import { useChannelMessages } from "./useChannelMessages";
import { useChannelSummaries } from "./useChannelSummaries";
import {
  HOME_CARD_CARRYOVER_ROWS,
  HOME_CARD_QUERY_ROWS,
  selectHomeCards,
} from "./home-cards";
import { isAtBottom } from "./scroll";
import {
  branchAnchorEntries,
  branchAnchorIds,
  answerText,
  delegateCard,
  editDiffText,
  failedFoldKey,
  fileViewFor,
  flattenRenderUnits,
  formatToolDuration,
  formatThinkingDuration,
  groupToolUnits,
  groupTurns,
  indexToolResults,
  mcpFailureLead,
  channelSendMessageId,
  mcpInputSummary,
  readTaskCard,
  summarizeMcpResult,
  liveTailLines,
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
  turnAssistantRecords,
  turnStats,
  writeLineCount,
  type ChannelMarkTone,
  type IntraToken,
  type RenderEntry,
  type ToolGroupUnit,
  type ToolResultIndex,
  type TurnGroupUnit,
} from "./tool-results";
import { highlighterReady, highlightLines, langFromPath, type TokenSpan } from "./highlight";
import { Composer } from "../../shell/Composer";
import { MathText } from "../../shell/MathText";
import { SessionCard } from "../../shell/SessionCard";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { InlineName } from "../../shell/InlineName";
import { IconButton } from "../../shell/IconButton";
import { Icon, type IconName } from "../../shell/Icon";
import { MarkdownBlock } from "./MarkdownBlock";
import { HomeHero } from "./HomeHero";
import { CarryoverChecklist } from "./CarryoverChecklist";
import { CarryoverScanCard } from "./CarryoverScanCard";
import { matchCarryoverMessage, type CarryoverDraft } from "./carryover-parse.ts";
import { contextRing, formatSpeed, replySpeed, streamingStart, usageBreakdown, type ContextRing } from "./stats-format";
import { isPlanBilling } from "@shared/known-providers";
import { modelMenuItems, selectedModelAcceptsImage } from "../settings/model-menu";
import { filesOf, imageSrc } from "../../shell/composer-images.ts";
import { ImageLightbox } from "../../shell/ImageLightbox";
import { PaperclipMark } from "../../shell/PaperclipMark";
import { QuoteChip } from "../../shell/QuoteChip";
import { parseQuotedMessage, type TextQuote } from "@shared/quote";
import { pastedTextSize, splitUserTextBlocks } from "@shared/prompt-attachments";
import { FileRefChip, PastedTextChip } from "../../shell/attachment-chips";
import { findQuoteSource, locateQuote, quoteFromSelection } from "./quote-select.ts";
import type { PromptImage } from "@shared/prompt-images";
import { modelThinkingLevels } from "./thinking-choice.ts";
import { estimateStreamingTokens, messageSpeed } from "@shared/message-speed";
import { parseQualifiedToolName } from "@shared/mcp";
import { parseSkillBlock, skillForReadPath } from "@shared/skill";
import type { SkillMeta } from "@shared/skill";
import { api } from "../../api";
import { retryCauseText, retryLineText } from "./retry-text";
import { PERMISSION_MODES } from "@shared/permission";
import { THINKING_LEVELS, THINKING_LEVEL_LABELS } from "@shared/thinking";
import {
  childSessions,
  deriveSessionTitle,
  type ChannelMarkRecord,
  type CompactedRecord,
  type SessionCompletion,
} from "@shared/session";
import type { RetryStatus } from "@shared/agent-ipc";
import type { ChatSession } from "./useChatSession";
import type { ThemePreference } from "@shared/settings";
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
        <ChatViewBody {...props} dropActive={dropActive} />
      </QuoteJumpContext.Provider>
      {accepts && (
        <QuoteSelectionLayer
          paneRef={paneRef}
          transcript={session.transcript}
          onQuote={(quote) => {
            session.addQuote(quote);
            // 引完回到输入框接着写——引用就是为了下一句话
            paneRef.current?.querySelector<HTMLTextAreaElement>("textarea.composer-input")?.focus();
          }}
        />
      )}
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
function scrollToTop(target: Element, rect: DOMRect): void {
  const container = target.closest<HTMLElement>(".scroll");
  if (container === null) {
    target.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  const top = container.scrollTop + rect.top - container.getBoundingClientRect().top - 24;
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

/**
 * 跳回被引用的原文：把那一段滚到转录区顶部、高亮 2.4 秒。一条助手消息可能拆成
 * 几个文本块（都带同一个 data-quote-id），挑包含这段原文的那块；逐字定位不到
 * （原文被 markdown 渲染改写得太多）就整块闪一下——至少把人带到对的地方。
 */
function highlightQuote(pane: HTMLElement, messageId: string, text: string): void {
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
    scrollToTop(block, range.getBoundingClientRect());
    CSS.highlights.set("orbita-quote", new Highlight(range));
    window.setTimeout(() => CSS.highlights.delete("orbita-quote"), 2400);
    return;
  }
  const fallback = blocks[0];
  if (fallback === undefined) return;
  scrollToTop(fallback, fallback.getBoundingClientRect());
  fallback.classList.remove("quote-flash");
  // 强制回流，让同一块连点两次时动画能重新开始
  void fallback.offsetWidth;
  fallback.classList.add("quote-flash");
}

/**
 * 划选引用的入口（Proma 的 AgentHistorySelectionLayer 同款交互）：在转录里划选一段文字，
 * 松手后选区上方浮出「引用」，点了就进输入框的引用 chip。
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
  onQuote: (quote: TextQuote) => void;
}) {
  const t = useT();
  const [candidate, setCandidate] = useState<{ quote: TextQuote; x: number; top: number; bottom: number } | null>(null);
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
      setCandidate({ quote, x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
    };
    const schedule = (): void => {
      window.clearTimeout(timer);
      // 等浏览器把选区落定（双击选词、三击选段的 selection 在 pointerup 之后才定）
      timer = window.setTimeout(capture, 60);
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.shiftKey || event.key.startsWith("Arrow")) schedule();
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

  if (candidate === null) return null;
  // 贴着窗口顶的选区往上弹会被裁掉，改弹到选区下方
  const below = candidate.top < 56;
  return createPortal(
    <button
      type="button"
      data-quote-popover
      title={t.quote.addTitle}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        props.onQuote(candidate.quote);
        window.getSelection()?.removeAllRanges();
        setCandidate(null);
      }}
      style={{
        position: "fixed",
        left: candidate.x,
        top: below ? candidate.bottom + 8 : candidate.top - 8,
        transform: below ? "translateX(-50%)" : "translate(-50%, -100%)",
        zIndex: 40,
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
        height: 30,
        padding: "0 var(--space-3)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-panel)",
        boxShadow: "var(--shadow-popover)",
        color: "var(--color-text-primary)",
        fontSize: "var(--font-size-control)",
        whiteSpace: "nowrap",
        cursor: "pointer",
      }}
    >
      <Icon name="quote" size={13} strokeWidth={1.8} />
      {t.quote.add}
    </button>,
    document.body,
  );
}

/**
 * 会话区的 skill 索引：read SKILL.md 的行要标成「在用 skill」就靠它认 slug。
 * 挂载读一次、失败静默——徽标是锦上添花，不为它报错，也不为它做重读 UI
 * （新建的 skill 下一轮会话自然出现）。
 */
function useSkillIndex(): { skills: SkillMeta[]; reload: () => void } {
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const reload = useCallback(() => {
    void api.skill.list().then(setSkills).catch(() => undefined);
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { skills, reload };
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
  /**
   * 点主流里的通道标记 → 显示 / 展开通道列并跳到那条消息（子会话 PR4b）。
   * App 传一个 `useCallback` 出来的稳定引用给主槽的 ChatView；辅助对话抽屉里的
   * ChatView 不传（undefined），标记保持不可点——那里没有通道列可跳。
   */
  onOpenChannel?: (childId: string, messageId: string | null) => void;
  /**
   * 子会话视图里点标记 → 打开父子会话面板并跳到那条消息（用户 2026-09-25：子会话
   * 工作记录里看到它发给母会话的标记，自己点进去）。只有 Sub-sessions 面板里查看
   * 子会话的 ChatView 拿到它——那时主槽正看着母会话，父子会话面板打得开。子会话
   * 在主槽打开（Open as main）时主槽没有母会话、也就没有父子会话面板，不传，标记
   * 保持不可点，不给一个点了没反应的东西。
   */
  onOpenOwnChannel?: (messageId: string | null) => void;
  /**
   * 点派出卡 → 打开右栏 Sub-sessions 面板并直接进入这条子会话的会话层（子会话
   * PR4c）。只有主槽的 ChatView 拿到它——辅助对话抽屉与 Sub-sessions 面板自己
   * 内部渲染的 ChatView（查看子会话）都不传，派出卡保持不可点，也符合「UI 只做
   * 一层」：面板里查看的子会话不再嵌一层它自己的 Sub-sessions 入口。
   */
  onOpenSubSession?: (childId: string) => void;
  /**
   * 点头部「N sub-sessions」芯片 → 打开右栏 Sub-sessions 面板的**列表层**（子会话
   * PR4c）。只有主槽的 ChatView 拿到它。
   */
  onOpenSubSessions?: () => void;
  /**
   * 子会话被 Open as main 之后：头部标题前的面包屑「↑ 父标题」点了回主槽的父会话
   * （子会话 PR4c）。只有主槽的 ChatView 拿到它。
   */
  onOpenParent?: (parentId: string) => void;
  /**
   * 解析后的主题：只给首页门面用（纸面两档的 slogan 与批语，HomeHero.tsx）。
   * 只有主槽的 ChatView 拿到它；辅助对话是 homeBare，本来就不出门面。
   */
  theme?: Exclude<ThemePreference, "system">;
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
}) {
  const t = useT();
  const { session, providersError, homeBare, hideComposer } = props;
  // read SKILL.md 徽标的识别索引 + 指令面板的 skill 清单（同一份数据）。
  // reload 暴露给 Composer：面板每次打开重拉，新建/删除的 skill 立即可见
  const { skills, reload: reloadSkills } = useSkillIndex();
  const jumpToQuote = useContext(QuoteJumpContext);

  // 跟随态（pi 的 followingEnd 语义）：贴底时内容增长钉住底部；用户上滚脱离，滚回底部恢复。
  // 用 ref 不用 state——没有 UI 依赖它，不值得为每次滚动触发重渲染。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  /** 用户滚动（滚轮/键盘/滚动条都一样）后重判是否在底部；程序化钉底触发的事件判真，不打架 */
  const handleScroll = () => {
    const el = scrollRef.current;
    if (el !== null) {
      followRef.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    }
  };

  // 每次 commit 后钉底：不挑触发源——流式输出、忙碌指示出现、折叠展开全兜住；scrollTop 赋值廉价。
  // 绘制前同步执行，用户看不到先长高再滚下去的闪动。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
  });

  /** 这一屏是哪条会话：活着的优先，否则是打开的那条 */
  const openId = session.sessionId ?? session.opened?.id ?? "";

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
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [openId]);

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
  // 标记点了打开父子会话面板：根会话（ownSide "parent"）走 onOpenChannel，按对面的
  // childId 定位；子会话走 onOpenOwnChannel——通道的 childId 就是它自己，标记里的
  // peerId 是母会话，所以不透传、只要 messageId。主槽的 ChatView 看子会话时两个都
  // 接不上（onOpenChannel 只认根会话，onOpenOwnChannel 只有 Sub-sessions 面板给），
  // 标记不可点；辅助对话抽屉两个都不传。
  const onOpenOwnChannel = props.onOpenOwnChannel;
  const onOpenParentChannel = props.onOpenChannel;
  const openChannel = useMemo<((childId: string, messageId: string | null) => void) | null>(() => {
    if (ownSide === "parent") return onOpenParentChannel ?? null;
    if (onOpenOwnChannel === undefined) return null;
    return (_peerId, messageId) => onOpenOwnChannel(messageId);
  }, [ownSide, onOpenParentChannel, onOpenOwnChannel]);
  // 子会话 PR4c：派出卡的点击与描边同一套「只有主槽才接」的门槛，openChannel 上面已有先例
  const openSubSession = ownSide === "parent" ? (props.onOpenSubSession ?? null) : null;
  const litSubSessionId = props.litSubSessionId ?? null;
  // 子会话 2026-09-23 裁决①：任务卡的正文来自自己父子这条通道的账本——只有
  // `ownSide` 为 "child" 时才有意义（根会话没有 task 标记要渲染），key 为 null
  // 时 `useChannelMessages` 内部直接短路成空态，不发请求（同它自己的既有语义）。
  const taskChannelKey =
    ownSide === "child" && ownParentId !== null && openId !== "" ? { parentId: ownParentId, childId: openId } : null;
  const taskChannel = useChannelMessages(taskChannelKey);
  const channelMessages = useMemo(
    () => new Map(taskChannel.messages.map((message) => [message.id, message])),
    [taskChannel.messages],
  );
  const channel = useMemo<ChannelViewContext>(
    () => ({
      ownSide,
      ownParentId,
      titles,
      channelSummaries,
      childPhaseOf: session.phaseOf,
      openChannel,
      openSubSession,
      litSubSessionId,
      channelMessages,
      channelMessagesLoading: taskChannel.loading,
      channelMessagesError: taskChannel.error,
    }),
    [
      ownSide,
      ownParentId,
      titles,
      channelSummaries,
      session.phaseOf,
      openChannel,
      openSubSession,
      litSubSessionId,
      channelMessages,
      taskChannel.loading,
      taskChannel.error,
    ],
  );

  /**
   * 头部次要芯片「N sub-sessions · M waiting」（子会话 PR4c，2.2）：只在
   * `ownSide` 为 "parent" 且这条根会话确有子会话时才有内容——与派出卡同一条
   * 「子会话没有自己的子会话（今天）」的现状一致。waiting 计通道状态 waiting
   * 的子会话数；为 0 时芯片只显示前半（不拼出 "· 0 waiting"）。点击调用方按
   * `onOpenSubSessions` 是否给了决定是否可点，同 `ChannelMarkPill` 的门槛。
   */
  const subSessionRows = ownSide === "parent" && openId !== "" ? childSessions(session.sessions, openId) : [];
  const subSessionsChip =
    subSessionRows.length === 0
      ? null
      : {
          count: subSessionRows.length,
          waiting: subSessionRows.filter((child) => channelSummaries.get(child.id)?.status === "waiting").length,
        };
  /**
   * 子会话在主槽打开时的面包屑「↑ 父标题」（2.2）：只在 `onOpenParent` 给了
   * （主槽专属，同 `onOpenSubSessions`）且这条会话确有 `parentId` 时出现。
   * 父标题的查找/兜底复用 `peerTitleOf`——同一句「对面是谁」的口径不另写一份。
   */
  const parentId = openMeta?.parentId;
  const onOpenParentProp = props.onOpenParent;
  const parentCrumb =
    onOpenParentProp !== undefined && parentId !== undefined
      ? { title: peerTitleOf(channel, parentId, t), onClick: () => onOpenParentProp(parentId) }
      : null;

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
      skills={skills}
      onReloadSkills={reloadSkills}
      onCommand={(command) => {
        if (command === "compact") {
          // 压缩走既有解析流（忙碌感知、排队同手工输入 /compact）
          session.sendText("/compact");
        } else {
          // /new：清掉打了一半的草稿与挂着的附件再开新会话（先清再切——
          // newTask 换槽后 draftKey 变了，附件就清不到了）
          session.clearComposerExtras();
          session.setDraft("");
          session.newTask();
        }
      }}
      // 按「是不是首页」分，不按 sessionId：从侧栏打开的历史会话 sessionId 还是 null
      // （agent 要等发第一条才起），只有 opened 有值——按 sessionId 判会给它首页那句
      // 有引用时提示按编号逐条回复——编号就是 chip 上的角标，也是模型看到的 index
      placeholder={
        session.quotes.length > 0
          ? t.quote.replyPlaceholder(session.quotes.length)
          : homeActive
            ? t.chat.placeholderNew
            : t.chat.placeholderReply
      }
      disabled={session.usable.length === 0 || session.readOnly}
      running={session.phase !== "idle"}
      bottomSlot={<ComposerBar session={session} />}
      dropActive={props.dropActive === true}
      quotes={session.quotes}
      onRemoveQuote={session.removeQuote}
      jumpToQuote={jumpToQuote}
      attachments={session.attachments}
      onAttach={session.attachIncoming}
      onRemoveAttachment={session.removeAttachment}
      files={session.files}
      pasted={session.pasted}
      onRemoveFile={session.removeFile}
      onRemovePasted={session.removePasted}
      onPasteLargeText={session.addPastedText}
      imageUnsupported={!selectedModelAcceptsImage(session.usable, session.catalog, session.model)}
    />
  );

  const notices = (
    <>
      {providersError != null ? (
        // 加载失败 ≠ 没有 provider：原因说清楚，去设置面重试（打开设置会重新拉取）
        <Notice tone="bad">{t.chat.providersFailed(providersError)}</Notice>
      ) : (
        session.usable.length === 0 && (
          <Notice>{t.chat.noProvider}</Notice>
        )
      )}
      {session.error !== null && <Notice tone="bad">{session.error}</Notice>}
      {/*
        收尾仪式的降级 / 结果反馈：一句中性的话，不当错误报。
        读不懂扫描结果时这行带一个 Retry（重发同一条扫描消息）——失败不该只留一句
        「已标完成」就无路可走。
      */}
      {session.scanNotice !== null && (
        <Notice>
          {session.scanNotice}
          {session.retryClosingScan !== null && (
            <button
              type="button"
              onClick={session.retryClosingScan}
              style={{
                border: 0,
                background: "transparent",
                padding: 0,
                fontFamily: "var(--font-family-base)",
                fontSize: "var(--font-size-control)",
                color: "var(--color-text-primary)",
                textDecoration: "underline",
                cursor: "pointer",
              }}
            >
              {t.common.retry}
            </button>
          )}
        </Notice>
      )}
      {/*
        只能读不能续：pi 没有这条会话的本子。**说清楚，别让输入框看起来能打字**
        （guideline §四把这条代价写明了）。
      */}
      {session.readOnly && (
        <Notice>{t.chat.readOnlyTask}</Notice>
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
        {/*
          首页没有页头，但顶部这一条同样要能拖窗口 / 双击缩放——不给的话用户从会话页
          回到首页就会发现「刚才能拖的地方现在不能拖了」。高度与 Pane 页头对齐（30 + 12×2）。
          压在内容下面（zIndex 0）：窗口矮到内容顶上来时，会话卡的点击优先，不被拖拽区吞掉。
        */}
        <div
          className="titlebar"
          style={{ position: "absolute", insetInlineStart: 0, insetInlineEnd: 0, top: 0, height: 54, zIndex: 0 }}
        />
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
                      running={session.phaseOf(card.sessionId) !== "idle"}
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
        // 只要这条会话已经落盘就能标记完成——与改名同一条门槛，只读会话同样可用
        completion={openId === "" ? null : (openMeta?.completion ?? "open")}
        onSetCompletion={
          openId === "" ? undefined : (next) => session.setCompletionSession(openId, next)
        }
        // open 态点击走收尾仪式（降级矩阵在 hook）；Reopen 仍走 onSetCompletion
        onMarkDone={openId === "" ? undefined : session.startClosingRitual}
        closing={session.closingScan}
        busy={session.phase !== "idle"}
        scanless={openMeta?.piSessionFile == null}
        // 只要这条会话已经落盘就能改名——刚发完第一句正是最想改名的时候
        onRename={openId === "" ? undefined : (title) => session.renameSession(openId, title)}
        subSessionsChip={subSessionsChip}
        onOpenSubSessions={props.onOpenSubSessions}
        parentCrumb={parentCrumb}
        footer={
          <>
            {notices}
            {session.approvals[0] && (
              <ApprovalBar approval={session.approvals[0]} onAnswer={session.answerApproval} />
            )}
            {/* 收尾确认卡：inline 浮层，与审批条同位同配方；只在查看发起会话时显示
                （scanResult 由 hook 查看槽持有，切走再切回还在） */}
            {session.scanResult !== null && session.scanResult.sessionId === openId && (
              <CarryoverChecklist
                drafts={session.scanResult.drafts}
                onConfirm={session.confirmCarryovers}
                onCancel={session.cancelCarryovers}
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
        <TranscriptColumn
          transcript={session.transcript}
          compactions={session.compactions}
          marks={session.marks}
          phase={session.phase}
          retry={session.retry}
          turnError={session.turnError}
          loadingHistory={session.loadingHistory}
          onBranch={session.branchFrom}
          onOpenTask={session.openSession}
          channel={channel}
          skills={skills}
        />
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
  transcript: readonly TranscriptItem[];
  compactions: readonly CompactedRecord[];
  /** 子会话 PR4a：盘上读回的通道标记，与 compactions 同一条纪律（见 mergeSideRecords） */
  marks: readonly ChannelMarkRecord[];
  phase: "idle" | "turn" | "compaction";
  retry: RetryStatus | null;
  turnError: string | null;
  loadingHistory: boolean;
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
}) {
  const t = useT();
  const { transcript } = props;
  // 派生链按引用记忆：没变的部分不重复对账（phase / retry / turnError 槽变化时只补差额）
  const toolResults = useMemo(() => indexToolResults(transcript), [transcript]);
  // 界碑与通道标记按发生位置插回往来流：压缩摘要收进「已压缩」折叠行、通道标记
  // 画成一行虚线标记，历史一条不少
  const records = useMemo(
    () => mergeSideRecords(props.compactions, props.marks, transcript),
    [props.compactions, props.marks, transcript],
  );
  // 摊平 → 相邻同类合并：渲染从「按条」改成「按单元」，连续同类工具收成一行组
  const units = useMemo(() => flattenRenderUnits(records), [records]);
  const entries = useMemo(() => groupToolUnits(units, props.skills), [units, props.skills]);
  // 组行的展开是时间态：活跃轮里铺开，整轮落定一次性收纳（见 ToolGroupLine）
  const turnActive = props.phase === "turn";
  // 大折叠：已落定轮次的思考与工具收成一行统计（活跃轮原样铺开，见 groupTurns）
  const turnView = useMemo(() => groupTurns(entries, turnActive, toolResults), [entries, turnActive, toolResults]);
  // 流式中的思考块（行首呼吸的判定）：本轮未结束且它是流式 assistant 消息的最后一块
  const activeThinkingKey = useMemo(
    () => streamingThinkingKey(records, turnActive),
    [records, turnActive],
  );
  // 分支锚点（C-2）：每轮最终完整输出的最后一个单元后面挂一条分支按钮行；
  // 有工具还在跑时全部禁用——它的结果没齐，此刻切出去的上下文是畸形的。
  // 锚点算在**大折叠视图**上：锚点的正文永远在折叠外面，按钮跟着正文走。
  const branchRows = useMemo(
    () => branchAnchorEntries(branchAnchorIds(records, toolResults), turnView),
    [records, toolResults, turnView],
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
    const cards = new Map<string, { drafts: readonly CarryoverDraft[]; firstKey: string }>();
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
      const drafts = matchCarryoverMessage(parts.join(""));
      if (drafts !== null) cards.set(record.id, { drafts, firstKey });
    }
    return cards;
  }, [records]);
  // 回合级失败（网络中断 / 重试耗尽）的红 triangle 只挂**失败那轮**的折叠（见 failedFoldKey）；
  // 那轮没折叠就不挂，红字自带的图标是全部。
  // 工具类失败不配图标（各自的红色 failed 计数已经跟在工具后面）。
  // 局部名叫 failedFold：failedFoldKey 是 turn-rollup 里的函数，不能重名遮蔽。
  const failedFold = props.turnError !== null ? failedFoldKey(turnView) : null;

  return (
    <>
      {/* 历史恢复在途：一行安静的加载指示，正文区不再是一片无解释的空白 */}
      {props.loadingHistory && entries.length === 0 && <StatusLine spin>{t.common.loading}</StatusLine>}
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
        return (
          <Fragment key={entry.key}>
            {entry.kind === "turnGroup" ? (
              <TurnRollupLine
                group={entry}
                toolResults={toolResults}
                turnFailed={entry.key === failedFold}
                onOpenTask={props.onOpenTask}
                carryoverCards={carryoverCards}
                channel={props.channel}
                skills={props.skills}
              />
            ) : (
              <EntryView
                entry={entry}
                toolResults={toolResults}
                activeThinkingKey={activeThinkingKey}
                turnActive={turnActive}
                onOpenTask={props.onOpenTask}
                carryoverCards={carryoverCards}
                channel={props.channel}
                skills={props.skills}
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
          </Fragment>
        );
      })}
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
        (props.retry !== null ? <Retrying status={props.retry} /> : <Responding transcript={transcript} />)}
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
  /**
   * 头部次要芯片「N sub-sessions · M waiting」（子会话 PR4c，2.2）。null = 不出现
   * （没有子会话）。点击走 `onOpenSubSessions`——不给时芯片仍显示（信息性），
   * 只是不可点，同 `ChannelMarkPill` 的门槛。
   */
  subSessionsChip?: { count: number; waiting: number } | null;
  onOpenSubSessions?: (() => void) | undefined;
  /**
   * 子会话被 Open as main 后头部标题前的面包屑「↑ 父标题」（子会话 PR4c，2.2）。
   * null = 不出现（本会话不是子会话，或调用方不是主槽）。
   */
  parentCrumb?: { title: string; onClick: () => void } | null;
  /** 消息列的滚动容器：跟随/跳底逻辑在 ChatView，骨架只交出节点 */
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: (() => void) | undefined;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr) auto",
      }}
    >
      {/* 页头兼窗口拖拽区：整行可拖可双击缩放，里面的铅笔与输入框由 `.titlebar button/input` 自动豁免 */}
      <header
        className="titlebar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          height: 30,
          padding: "12px 18px",
          boxSizing: "content-box",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        {/* 面包屑「↑ 父标题」：子会话被 Open as main 后，标题前的一句「你是从哪来的」——
            caption tertiary，不与标题抢重量；点击回主槽的父会话（子会话 PR4c，2.2） */}
        {props.parentCrumb != null && (
          <button
            type="button"
            onClick={props.parentCrumb.onClick}
            title={t.chat.backToParent(props.parentCrumb.title)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--space-1)",
              // flex-shrink:1（非 0 0 auto）+ minWidth:0：主槽变窄时它也让路，
              // maxWidth 只是宽松时的上限，不是「永远这么宽」（子会话 PR4c fix）
              flex: "0 1 auto",
              minWidth: 0,
              maxWidth: 160,
              border: 0,
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              font: "inherit",
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <Icon name="arrow-up" size={11} strokeWidth={1.8} style={{ flex: "0 0 auto" }} />
            <span
              style={{
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {props.parentCrumb.title}
            </span>
          </button>
        )}
        <InlineName
          editing={editing}
          value={props.title}
          onCommit={(value) => {
            setEditing(false);
            props.onRename?.(value);
          }}
          onCancel={() => setEditing(false)}
          style={{
            fontSize: "var(--font-size-title)",
            fontWeight: "var(--weight-bold)",
            height: 30,
          }}
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
              fontSize: "var(--font-size-title)",
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
          <IconButton label={t.chat.renameTask} size={24} onClick={() => setEditing(true)}>
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
        {/* 次要芯片「N sub-sessions · M waiting」：信息性，onOpenSubSessions 给了才可点
            （辅助对话里渲染的 ChatView 不传，芯片仍显示、只是不可点） */}
        {props.subSessionsChip != null && (
          <SubSessionsChip chip={props.subSessionsChip} onClick={props.onOpenSubSessions} />
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
            fontSize: "var(--font-size-micro)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          {props.badge}
        </span>
      </header>

      <div
        ref={props.scrollRef}
        onScroll={props.onScroll}
        className="scroll"
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

      <div style={{ padding: "var(--space-1) var(--space-5) 10px" }}>
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

/**
 * 头部次要芯片「N sub-sessions · M waiting」（子会话 PR4c，2.2）。waiting 为 0
 * 时只拼前半——不拼出一句「· 0 waiting」，那不是「有事要你做」，不值得占位。
 * `onClick` 未给时渲染成 `span`（信息性、不可点），同 `ChannelMarkPill` 的做法。
 */
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
    fontSize: "var(--font-size-caption)",
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
function ComposerBar(props: { session: ChatSession }) {
  const t = useT();
  const { session } = props;
  const workspace = session.workspaces.find((w) => w.id === session.workspaceId);
  // 作用域显示**目录名**。老工作区落库的名可能是完整路径（早期创建没截尾），
  // 所以两个分支都要过 basename——显示层截尾，不动落库数据
  const scopeSource = workspace?.name ?? session.cwd;
  const scope = scopeSource === null ? t.chat.home : basename(scopeSource) || t.chat.home;
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
      hint: session.defaultCwd,
      checked: session.workspaceId === null && session.cwd === null,
      onSelect: session.newTask,
    },
    ...session.workspaces.map((item) => ({
      id: item.id,
      label: item.name,
      icon: "folder" as const,
      checked: session.workspaceId === item.id,
      onSelect: () => session.newTaskIn(item),
    })),
    {
      id: "new-workspace",
      label: t.sidebar.newWorkspace,
      icon: "plus",
      onSelect: () => setNamingWorkspace(true),
    },
    { id: "add", label: t.sidebar.addFolder, icon: "folder-plus", onSelect: session.addWorkspace },
  ];

  // 菜单卡片只有词，不带描述——与思考档菜单同一口径（描述是悬停在芯片上的事，
  // 展开卡片里一行行小字只会让它显得吵；宽度也因此能固定）
  const modeItems: MenuItem[] = PERMISSION_MODES.map((value) => ({
    id: value,
    label: t.permissionModes[value].label,
    checked: session.mode === value,
    onSelect: () => session.changeMode(value),
  }));

  // 按厂商分组的模型菜单（与设置面的命名模型同一份构造）
  const modelItems: MenuItem[] = modelMenuItems({
    t,
    providers: session.usable,
    catalog,
    selected: session.model,
    onSelect: (providerId, modelId) => session.chooseModel(providerId, modelId),
  });

  // 思考档菜单按模型真实支持集显示（官方档位表：glm-5.3 只有 low/high/max，
  // claude 按型号——fable 系关不掉思考、opus-4-6 没有 xhigh——写死档位只会递增假选项）。来源三级
  // （modelThinkingLevels，与 useChatSession 的新任务槽起档共用同一份判定）：
  // 白名单 > 开轮事件回的真值（含 clamp 事实）> 目录（BuiltinModel，agent 进程在
  // pi 旁算好过线）。都没有 = 未知：按全量显示、不禁用，开轮后由 thinking 事件
  // 纠真——宁可待验证，不先撒谎
  const thinkingSupported =
    session.model === null ? null : modelThinkingLevels(session.model.modelId, catalog, session.thinkingSupported);
  const thinkingMenuLevels = thinkingSupported ?? THINKING_LEVELS;
  // 逐档判断，不是全局锁：glm-5.3 支持 low/high/max（不含 minimal），全局判
  // 「不含 minimal」会把整个菜单错锁成全灰——那是 reasoning:false 模型（支持集
  // 真只有 off）才有的形状。不支持的档单独禁用并说明，可用的照常可选
  const thinkingItems: MenuItem[] = thinkingMenuLevels.map((value) => {
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
      <Menu
        items={scopeItems}
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
      {modelItems.length > 0 && (
        <Menu
          items={modelItems}
          searchable
          trigger={({ open, toggle }) => (
            <Chip
              active={open}
              title={t.chat.modelTip}
              onClick={toggle}
              chevron
              // 名字随时可省略号截断（styles.css），不等断点
              className="chip-model"
            >
              {session.model?.modelId ?? t.chat.noModel}
            </Chip>
          )}
        />
      )}
      <Menu
        items={thinkingItems}
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
      <UsageRing session={session} />
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
function UsageRing(props: { session: ChatSession }) {
  const t = useT();
  const { session } = props;
  const stats = session.stats;
  const ring = contextRing(stats, t);
  const busy = session.phase !== "idle";
  // 包月制的 provider 不显示花费——那个数字是拿 API 价目表算的估价，不是他的账单。
  // 认不得的 id（自建网关）一律当按量算：藏起真实花费比多一行估价更坏。
  const billing =
    session.model !== null && isPlanBilling(session.model.providerId) ? "plan" : "metered";
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
    ...usageBreakdown(stats, t, billing).map((row) => ({
      id: row.label,
      label: row.label,
      hint: row.value,
      fact: true,
    })),
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
        align="end"
        hoverOpen
        onOpenChange={(next) => {
          if (!next) setConfirming(false);
        }}
        trigger={({ open, toggle }) => (
          <Chip active={open} onClick={toggle} aria-label={ring.label}>
            <Ring ring={ring} />
          </Chip>
        )}
      />
    </span>
  );
}

/** 环的几何：直径、线宽——底栏芯片里 12px 的图标位 */
const RING_SIZE = 14;
const RING_STROKE = 2;

/**
 * 上下文占用环。底环一圈中性边框色，弧从 12 点方向顺时针长——和钟一样，不用学。
 * 颜色是第二信号（设计系统）：过七成前继承文字色，之后才用 warning / danger。
 * `fill` 为 null 时只有底环：没数字就不画数字。
 */
function Ring(props: { ring: ContextRing }) {
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const { fill, tone } = props.ring;
  const color =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warning"
        ? "var(--color-warning)"
        : "currentColor";
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden
      style={{ display: "block" }}
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth={RING_STROKE}
      />
      {fill !== null && fill > 0 && (
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fill} ${circumference}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          style={{ transition: "stroke-dasharray var(--duration-hover) var(--ease-standard)" }}
        />
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
  onOpenTask?: (sessionId: string) => void;
  carryoverCards: ReadonlyMap<string, { drafts: readonly CarryoverDraft[]; firstKey: string }>;
  /** 子会话 PR4a：channelMark / delegate / reply_subsession / report_to_parent 要用 */
  channel: ChannelViewContext;
  /** read SKILL.md 徽标的识别索引（透传自 ChatViewBody） */
  skills: SkillMeta[];
}) {
  const t = useT();
  const { entry } = props;
  if (entry.kind === "compacted") return <CompactedLine record={entry.record} />;
  if (entry.kind === "user") return <UserBubble item={entry.item} />;
  if (entry.kind === "channelMark") {
    // 子会话自己流里的 task 标记：渲染成完整任务卡而不是一行胶囊（子会话
    // 2026-09-23 裁决①）——父给子的第一条任务是这条会话最该显眼的内容。
    // 其它标记（reply 等）与根会话视图仍走下面的胶囊，行为不变。
    if (props.channel.ownSide === "child" && entry.mark.kind === "task") {
      return (
        <ChannelTaskCard
          peerTitle={peerTitleOf(props.channel, entry.mark.peerId, t)}
          message={props.channel.channelMessages.get(entry.mark.messageId)}
          loading={props.channel.channelMessagesLoading}
          error={props.channel.channelMessagesError}
        />
      );
    }
    const openChannel = props.channel.openChannel;
    return (
      <ChannelMarkLine
        mark={entry.mark}
        ownSide={props.channel.ownSide}
        peerTitle={peerTitleOf(props.channel, entry.mark.peerId, t)}
        onClick={openChannel === null ? undefined : () => openChannel(entry.mark.peerId, entry.mark.messageId)}
      />
    );
  }
  if (entry.kind === "text") {
    const card = props.carryoverCards.get(entry.messageId);
    if (card !== undefined) {
      // 同一条消息的多个 text 块只渲染一张卡（第一个块的位置），其余已并进卡里
      if (entry.key !== card.firstKey) return null;
      return <CarryoverScanCard drafts={card.drafts} />;
    }
    // 引用的来源标记：划选要落在单个块里才成引用，跳回原文也按它找
    return (
      <div data-quote-id={entry.messageId} data-quote-role="assistant">
        <MarkdownBlock text={entry.text} />
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
  carryoverCards: ReadonlyMap<string, { drafts: readonly CarryoverDraft[]; firstKey: string }>;
  /** 子会话 PR4a：折叠展开后的成员行仍走 EntryView，需要同一份上下文原样转发 */
  channel: ChannelViewContext;
  /** 透传给成员 EntryView（read SKILL.md 徽标用） */
  skills: SkillMeta[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { group } = props;
  const stats = turnStats(group, props.toolResults, Date.now(), props.skills);
  // 统计段先收集再渲染：段与段之间插 · 分隔——纯 gap 挨在一起分不清边界；
  // 工具次数与它的失败数字是一个段，中间不插
  const segments: ReactNode[] = [];
  if (stats.durationMs !== null) {
    segments.push(
      <span style={headLabel(false)}>
        {t.chat.worked} {formatToolDuration(stats.durationMs, t)}
      </span>,
    );
  }
  if (stats.thinkingCount > 0) {
    segments.push(
      <span style={SLOT.status}>
        {t.chat.thought} {stats.thinkingCount}
      </span>,
    );
  }
  if (stats.calls > 0) {
    segments.push(<span style={SLOT.status}>{t.chat.tools(stats.calls)}</span>);
  }  for (const { toolName, count, failed } of stats.byTool) {
    segments.push(
      <span style={SLOT.status}>
        {t.chat.rollupTool(toolName)} {count}
        {/* 失败数不写词，红色数字直接跟在次数后面——红即失败的语义 */}
        {failed > 0 && <span style={{ color: "var(--color-danger)" }}> {failed}</span>}
      </span>,
    );
  }
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
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
              onOpenTask={props.onOpenTask}
              carryoverCards={props.carryoverCards}
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
 * 用户消息：右对齐的独立气泡；只有 text 块进气泡。text 走 MathText——
 * 公式就地渲染（行内随文、块级居中），**不解析 markdown**：其余一切按原样，
 * 用户气泡与模型回复（MarkdownBlock）刻意是两套渲染。
 * 气泡下方的复制图标（与回答行同款反馈）：拷输入的原文（只含 text，图片不进）。
 */
function UserBubble(props: { item: Extract<TranscriptItem, { role: "user" }> }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  // 垂直 clamp 到约 4 行（composer 上限 12 行的 1/3，wafo 2026-09-20）：溢出时底部
  // 渐变遮罩 + Show more/less 开合。overflowing 只在折叠态量——展开后
  // scrollHeight == clientHeight，结论会丢，按钮就再也收不回了。
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
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
  // `/skill:` 调用展开出的 <skill> 块（主进程拼的）同样拆成折叠卡：skill 正文几千字，
  // 不能平铺进气泡；块后的附加指示才是用户自己的话，照常进气泡、照常被复制
  const split = splitUserTextBlocks(textBlocks.map((block) => block.text));
  const skillBlock = parseSkillBlock(split.body);
  const parsed = skillBlock !== null ? parseQuotedMessage(skillBlock.rest) : parseQuotedMessage(split.body);
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
    const el = bubbleRef.current;
    if (el !== null) setOverflowing(el.scrollHeight > el.clientHeight + 1);
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
              name={ref.path.split(/[\\/]/).filter((part) => part !== "").pop() ?? ref.path}
              path={ref.path}
              kind={ref.kind}
            />
          ))}
        </div>
      )}
      {skillBlock !== null && (
        // skill 卡落在统一排布的第四行：图片 → 引用 → 文件 → **skill** → 粘贴文字 →
        // 文字气泡（2026-09-27 定稿）。它按内容也是「带进来的材料」，排在材料组末尾
        <SkillInvocationCard name={skillBlock.name} content={skillBlock.content} />
      )}
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
          ref={bubbleRef}
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
            fontSize: "var(--font-size-chat)",
            lineHeight: "var(--line-height-bubble)",
            overflowWrap: "anywhere",
            // 约 4 行：行高 1.6em × 4 + 上下 padding 18 + border 2；展开时放开
            ...(expanded ? {} : { maxHeight: "calc(1.6em * 4 + 20px)", overflow: "hidden" }),
          }}
        >
          <MarkdownBlock text={text} variant="bubble" />
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
              padding: 3,
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
              padding: 3,
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
            padding: 3,
            border: "none",
            background: "none",
            color: copied ? "var(--color-success)" : "var(--color-text-tertiary)",
            cursor: copyText === "" ? "default" : "pointer",
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} strokeWidth={1.8} />
        </button>
        )}
      </div>
    </div>
  );
}

/**
 * 用户消息里的图：右对齐、按原比例缩在 240px 框内（同 MCP 工具图的内联口径）。
 * 显示的是 agent 进程缩放后、真正送给模型的那一份——模型看到什么，这里就是什么。
 */
/**
 * `<skill>` 块的折叠卡（pi TUI 同款形态）：默认一行「skill 名」，点开看全文——
 * skill 正文几千字，收着才不淹没对话。在右对齐的气泡列里要 fit-content 宽度，
 * 不复用 CollapseRow（那套是全宽的工具行骨架）。
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
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)", flex: "0 0 auto" }}>
          skill
        </span>
        <span
          style={{
            fontSize: "var(--font-size-caption)",
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
            fontSize: "var(--font-size-caption)",
            lineHeight: 1.6,
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
 * 过不了噪音门的回答没有这个字段，也就不显示。
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
    <div style={{ display: "flex", width: "100%", alignItems: "center", gap: "calc(var(--space-3) / 2)" }}>
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
          padding: 4,
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
          padding: 4,
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
            fontSize: "var(--font-size-micro)",
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
 * 状态词是机器事实（micro mono 等宽数字）。
 */
function CollapseRow(props: {
  open: boolean;
  disabled?: boolean;
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
          minHeight: 32,
          padding: "6px 10px",
          border: "none",
          color: "var(--color-text-secondary)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-control)",
          lineHeight: "var(--line-height-control)",
          textAlign: "left",
          cursor: interactive ? "pointer" : "default",
        }}
      >
        {props.children}
      </button>
    </div>
  );
}

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
    fontSize: "var(--font-size-caption)",
  },
  status: {
    flex: "0 0 auto",
    color: "var(--color-text-tertiary)",
    fontFamily: "var(--font-family-business)",
    fontSize: "var(--font-size-micro)",
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
    fontSize: "var(--font-size-body)",
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
const SEP_DOT = {
  flex: "0 0 auto",
  color: "var(--color-text-tertiary)",
  opacity: 0.6,
} satisfies React.CSSProperties;

/**
 * 展开体的纵向导轨：与行首 icon 的**左缘相切**——x = 10px（按钮内边距，即 icon 的
 * 左缘）。展开内容一律不越过导轨左侧：展开体明确属于它上面那一行，不与
 * 别的行抢左缘；多条展开体并排时导轨与 icon 连成一条竖线。
 */
const RAIL_X = 10;
/** 导轨用 border-default 而非 subtle：深色下 subtle 与地面只差几阶（black #1e1e1e 对
 * #0a0a0a），孤立的 1px 竖线会隐形；default（#262626 / #333534）强一档才立得住。
 * 浅色下两者几乎无差，三主题同一 token。 */
const RAIL_LINE = "1px solid var(--color-border-default)";

/**
 * 展开体共用形态：细分隔线接在折叠行下、无底色、mono caption——chat 内卡片无框无填充。
 * 左侧挂导轨（顶线与导轨在左上角相接成直角），正文从导轨右侧起。
 */
const EXPANDED_BODY = {
  margin: 0,
  marginLeft: RAIL_X,
  padding: "var(--space-2)",
  maxHeight: 320,
  overflow: "auto",
  borderTop: "1px solid var(--color-border-subtle)",
  borderLeft: RAIL_LINE,
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-caption)",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} satisfies React.CSSProperties;

/**
 * markdown 展开体（压缩界碑行用）：EXPANDED_BODY 的骨架（hairline 顶线 + 320 封顶 +
 * 可滚），排版让给 .chat-md——摘要是结构化文档，不套 mono caption / pre-wrap。
 * 导轨照挂：界碑行虽无 icon，竖线仍与其余展开体同一位置（x=10px），内容列全体一致。
 */
const MARKDOWN_EXPANDED_BODY = {
  margin: 0,
  marginLeft: RAIL_X,
  padding: "var(--space-2)",
  maxHeight: 320,
  overflow: "auto",
  borderTop: "1px solid var(--color-border-subtle)",
  borderLeft: RAIL_LINE,
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
  const active = result === undefined || result.status === "running";

  // 子会话通道工具（子会话 PR4a）：三个工具的信息形状不是「调用 + 摘要」，各自
  // 早退，不复用下面的通用骨架。**三个都不在失败时早退**——照 ToolLine 的失败
  // 样式走（红色 triangle-alert + 可展开看错误），不能被派出卡/标记行的「成功
  // 语气」盖过去。delegate 若在此早退，一次真实失败会被 DelegateCardView 的
  // running 帧（`card === null` 时的「delegating…」呼吸）悄悄吞掉，永远显示
  // 「派出中」而不是「失败了」。
  if (props.toolName === "delegate" && !failed) {
    return <DelegateToolLine input={props.input} result={result} channel={props.channel} />;
  }
  if ((props.toolName === "reply_subsession" || props.toolName === "report_to_parent") && !failed) {
    return (
      <ChannelSendToolLine
        toolName={props.toolName}
        input={props.input}
        result={result}
        running={active}
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
  const rawBody = result !== undefined ? toolResultText(result, t) : "";
  // 跑着时只渲染尾部：partial 是累积快照、每帧整条重渲染，万行输出会拖垮 DOM
  const body = live ? liveTailLines(rawBody) : rawBody;
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

  // 外部能力芯片行（2026-09-27 两轮裁决）：skill 使用与 MCP 调用的身份收进一枚
  // 药丸芯片（图标 + 类型词 + 名字），与输入框附件 chip / 引用 chip 同族——「外部
  // 对象」在整个应用里长一个样；后跟灰色摘要，行形态与普通工具行同层、不抢块。
  // 族内分一档：skill 名正文字体（人写的指令），server/tool 是 mono（机器服务）。
  if (skillUse !== null || mcp !== null) {
    const mcpBrief = mcp === null ? null : (callLabel ?? mcpInputSummary(props.input));
    return (
      <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
        <CollapseRow open={open} disabled={!expandable} onToggle={() => setOpen((value) => !value)}>
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
              name={failed ? "triangle-alert" : skillUse !== null ? "book-open" : "plug"}
              size={13}
              strokeWidth={1.8}
              style={{
                color: failed ? "var(--color-danger)" : "var(--color-text-secondary)",
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
                fontSize: "var(--font-size-caption)",
                lineHeight: "18px",
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
        </CollapseRow>
        {open && expandable && (
          <>
            {mcp !== null ? (
              <McpToolBody result={result} />
            ) : (
              <PlainToolBody toolName={props.toolName} text={body} failed={failed} live={live} />
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} disabled={!expandable} onToggle={() => setOpen((value) => !value)}>
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span style={{ color: failed ? "var(--color-danger)" : headIconColor(active) }}>
            <Icon
              name={failed ? "triangle-alert" : skillUse !== null ? "book-open" : toolIcon(props.toolName)}
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
        {/* shell 类的执行耗时——慢命令（install / typecheck）不展开也讲清楚花在哪 */}
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
      {open && expandable && diff !== null && <DiffView diff={diff} />}
      {open && expandable && diff === null && fileView !== null && (
        <FileContentView text={fileView.text} startLine={fileView.startLine} lang={fileLang} />
      )}
      {open && expandable && diff === null && fileView === null && (
        <PlainToolBody toolName={props.toolName} text={body} failed={failed} live={live} />
      )}
    </div>
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
  channel: ChannelViewContext;
}) {
  const card = delegateCard(props.result);
  const taskPreview = deriveSessionTitle(toolCallSummary("delegate", props.input) ?? "");
  if (card === null) {
    return <DelegateCardView card={null} status="running" taskPreview={taskPreview} />;
  }
  const summary = props.channel.channelSummaries.get(card.childId);
  // 状态优先读通道摘要的终态（done/failed/waiting）；否则看子会话在 renderer
  // 会话槽里的 phase——不为 idle 就是还在跑（子会话 PR4a 的「状态从哪来」）。
  const status: DelegateCardStatus =
    summary?.status === "done" || summary?.status === "failed" || summary?.status === "waiting"
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
  channel: ChannelViewContext;
}) {
  const t = useT();
  const record = typeof props.input === "object" && props.input !== null ? (props.input as Record<string, unknown>) : {};
  // 落账那条通道消息的 id（回执 details 里，channel-tools.ts）：点了滚到父子会话面板里
  // 的这一条并高亮。还在跑、或这一刀之前的旧记录没有 → null，退回滚到通道底部
  const messageId = channelSendMessageId(props.result);
  const openChannel = props.channel.openChannel;
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
        onClick={openChannel === null || childId === "" ? undefined : () => openChannel(childId, messageId)}
      />
    );
  }
  // report_to_parent：对面恒是本会话自己的父——ownParentId 是这条会话固定的事实，
  // 不像 reply_subsession 那样按入参里的 id 变化。
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
  // 子会话工作记录里的这一行（用户 2026-09-25：看到它发给母会话的消息，自己点进去）。
  // 子会话视图的 openChannel 不看第一个参数（通道的 childId 就是它自己），传对面的 id 只为
  // 与 reply_subsession 同一个签名
  const parentId = props.channel.ownParentId ?? "";
  return (
    <ChannelToolMarkLine
      icon={label.icon}
      text={label.text}
      tone={label.tone}
      running={props.running}
      onClick={openChannel === null ? undefined : () => openChannel(parentId, messageId)}
    />
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

  const status = toolGroupStatus(group.calls, props.toolResults);
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
      className="scroll"
      style={{
        maxHeight: 320,
        overflow: "auto",
        marginLeft: RAIL_X,
        paddingLeft: "var(--space-2)",
        borderTop: "1px solid var(--color-border-subtle)",
        borderLeft: RAIL_LINE,
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-caption)",
        lineHeight: 1.6,
      }}
    >
      {entries.map((entry, index) =>
        entry.kind === "pair" ? (
          <Fragment key={index}>
            <DiffRow kind="del" lineNum={entry.removed.lineNum}>
              {intraSpans(entry.tokens.removed, "del")}
            </DiffRow>
            <DiffRow kind="add" lineNum={entry.added.lineNum}>
              {intraSpans(entry.tokens.added, "add")}
            </DiffRow>
          </Fragment>
        ) : (
          <DiffRow key={index} kind={entry.row.kind} lineNum={entry.row.lineNum}>
            {entry.row.text === "" ? " " : entry.row.text}
          </DiffRow>
        ),
      )}
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

/** diff 行两列 grid：行号（gutter——细分隔线 + 最低调的褪色，只作定位不作内容）| 正文。
 * 深浅三级：改动行正文 primary（第一眼）> 上下文正文 secondary > 行号（tertiary 再降
 * 不透明度）；增删整行淡底色 */
function DiffRow(props: { kind: "add" | "del" | "ctx"; lineNum: string; children: ReactNode }) {
  const { kind } = props;
  return (
    <div
      style={{
        display: "grid",
        // 轨道要连 LINE_NUM_COLUMN 的横向内边距一起算进去，否则三位数行号顶穿竖线挤进正文
        gridTemplateColumns: "calc(4ch + var(--space-2) + var(--space-1)) 1fr",
        background:
          kind === "add"
            ? "var(--color-success-soft)"
            : kind === "del"
              ? "var(--color-danger-soft)"
              : undefined,
      }}
    >
      <span style={LINE_NUM_COLUMN}>{props.lineNum}</span>
      <span
        style={{
          padding: "0 var(--space-2) 0 var(--space-2)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: kind === "ctx" ? "var(--color-text-secondary)" : "var(--color-text-primary)",
        }}
      >
        {props.children}
      </span>
    </div>
  );
}

/** 词级对比 token → span；changed 片段按角色加底（pi inverse 的 DOM 等价物） */
function intraSpans(tokens: readonly IntraToken[], kind: "del" | "add") {
  return tokens.map((token, index) =>
    token.changed ? (
      <span
        key={index}
        style={{
          backgroundColor: kind === "add" ? "var(--color-success)" : "var(--color-danger)",
          color: "var(--color-bg-panel)",
          borderRadius: 2,
        }}
      >
        {token.text}
      </span>
    ) : (
      <span key={index}>{token.text}</span>
    ),
  );
}

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
  const lines = props.lang !== null ? highlightLines(props.text, props.lang) : null;
  const rows: readonly (string | readonly TokenSpan[])[] = lines ?? props.text.split("\n");
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
        marginLeft: RAIL_X,
        paddingLeft: "var(--space-2)",
        borderTop: "1px solid var(--color-border-subtle)",
        borderLeft: RAIL_LINE,
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-caption)",
        lineHeight: 1.6,
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
 * （max-height 240、--radius-md、发丝边框、mimeType 一行 micro）。
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
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
          {mcpFailureLead(result, t)}
        </p>
      )}
      {texts.map((block, i) => (
        <pre
          key={i}
          style={{
            margin: 0,
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-caption)",
            lineHeight: 1.6,
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
              fontSize: "var(--font-size-micro)",
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

function PlainToolBody(props: {
  toolName: string;
  text: string;
  failed: boolean;
  live?: boolean;
}) {
  const t = useT();
  const follow = useFollowScroll(props.live === true);
  if (props.text === "") {
    return (
      <div
        className="scroll"
        style={{ ...PLAIN_BODY, color: "var(--color-text-secondary)", padding: "0 var(--space-2)" }}
      >
        {props.live === true ? t.chat.waitingOutput : t.chat.noOutput}
      </div>
    );
  }
  if (props.failed) {
    return (
      <div ref={follow.ref} onScroll={follow.onScroll} className="scroll" style={PLAIN_BODY}>
        {props.text.split("\n").map((line, index) => (
          <div key={index} style={{ ...BODY_LINE, color: "var(--color-danger)" }}>
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div ref={follow.ref} onScroll={follow.onScroll} className="scroll" style={PLAIN_BODY}>
      {props.text.split("\n").map((line, index) => toolBodyLine(props.toolName, line, index))}
    </div>
  );
}

/** 展开体滚动容器的共用形态（无水平内边距——行自带）；左侧挂 RAIL 导轨，同 EXPANDED_BODY。 */
const PLAIN_BODY = {
  maxHeight: 320,
  overflow: "auto",
  marginLeft: RAIL_X,
  borderTop: "1px solid var(--color-border-subtle)",
  borderLeft: RAIL_LINE,
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-caption)",
  lineHeight: 1.6,
} satisfies React.CSSProperties;

const BODY_LINE = {
  padding: "0 var(--space-2)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
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
        fontSize: "var(--font-size-control)",
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
        fontSize: "var(--font-size-control)",
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
        fontSize: "var(--font-size-control)",
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

/** 提示行：文字是主信号，颜色是第二信号 */
function Notice(props: { tone?: "bad"; children: React.ReactNode }) {
  return (
    <p
      role={props.tone === "bad" ? "alert" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: 0,
        padding: "0 var(--space-2)",
        color: props.tone === "bad" ? "var(--color-danger)" : "var(--color-text-secondary)",
        fontSize: "var(--font-size-control)",
      }}
    >
      {props.tone === "bad" && (
        <span style={{ display: "inline-flex", flex: "0 0 auto" }}>
          <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
        </span>
      )}
      {props.children}
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
        fontSize: "var(--font-size-caption)",
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

/** 取路径尾段。分隔符 `/` 与 `\` 都认——Windows 的 cwd 是反斜杠，只切 `/` 会整条漏出来 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}
