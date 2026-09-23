/**
 * 通道列（子会话 PR4b）——主槽与右栏之间的一列，一个通道一张卡，父子之间的往来
 * 抽出来放在这里，两边主流里只留一行标记指向它（`ChannelViews.tsx`）。
 *
 * 布局：`App.tsx` 常驻挂载（同 `RightPanelSlot` 的先例——壳一直在，`open` 只是
 * class 切换驱动的宽度过渡），`parentId` 为 null（没在看根会话，或看的是子会话 /
 * 设置页）时不显示任何东西。**可拖宽**（用户 2026-09-23 裁决）：区间是 chat 区
 * （主槽 + 本列）的 1/6–1/3（`clampChannelColumnWidth`，`@shared/settings`），
 * 宽度由 App 持有并落盘（同 `rightPanelWidth` 的 App 写法），拖动中只改本地，
 * 松手才 commit。
 *
 * **inline / overlay 由「放不放得下」决定，不只是全局窄窗**（子会话 PR4c fix，
 * CDP 实测发现的挤压 bug：1200px 窗口下右栏 Sub-sessions 面板与通道列同时开着，
 * 主槽被压到 ~200px）。`channelColumnLayout`（`channel-column.ts`，纯函数）按
 * 「用户刚打开的右栏优先，通道列让位」的顺序判定：全局窄窗恒 overlay（那时右栏
 * 也已经是覆盖层，不占 flex 空间，维持 PR4b 原行为）；非窄窗则量 `.pane` 与
 * 右栏此刻的实际宽度，放不下（chat < 480px）就转 overlay——**内部**用同一套
 * narrow-overlay 语言（不自动出现、右图标条入口/点标记以覆盖层出现、Esc 或再点
 * 入口收起），调用方（App.tsx）关心的 Esc 协调与默认显隐判定所以也要知道这个
 * 结果，经 `onLayoutChange` 上报（同 `onVisibilityChange` 先例）。
 *
 * **通道的出现规则**（用户 2026-09-23 裁决，`visibleChannels`）：只派出、子还在
 * 跑但没说过话的通道不再占一整张卡——折叠成一行头部，展开才是「代父插嘴」的入口；
 * 整列的自动出现（没有显式 `shown` 选择时的默认值）只由**有往来**的通道触发。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChannelKey, ChannelMessage, ChannelStatus, ChannelSummary } from "@shared/channel";
import { CHANNEL_COLUMN_WIDTH_DEFAULT, clampChannelColumnWidth } from "@shared/settings";
import { api } from "../../api";
import { isSubmitKey } from "../../shell/composer-keys.ts";
import { composerBoxHeight } from "../../shell/composer-height.ts";
import { Icon, type IconName } from "../../shell/Icon";
import { usePaneAndRightPanelWidth } from "../../shell/side-width.ts";
import { channelColumnLayout, channelWhoLabel, nonTaskMessages, visibleChannels } from "./channel-column.ts";
import { channelKindIcon } from "./ChannelViews";
import { MarkdownBlock } from "./MarkdownBlock";
import { isAtBottom } from "./scroll.ts";
import { useChannelMessages } from "./useChannelMessages";
import { useChannelSummaries } from "./useChannelSummaries";
import type { ChatSession } from "./useChatSession";

/** 点父流里的标记 → 通道列的一次性请求：展开该通道、滚到那条消息（或底部）并高亮。 */
export interface ChannelOpenRequest {
  childId: string;
  messageId: string | null;
  /** 每次请求自增——同一条 childId/messageId 再点一次也要能重新触发滚动与高亮 */
  token: number;
}

export function ChannelColumn(props: {
  /** 主槽此刻看的根会话 id；null = 没在看根会话（子会话 / 设置页 / 首页） */
  parentId: string | null;
  parentTitle: string;
  session: ChatSession;
  /**
   * App 的全局 narrow（<960px）：恒转覆盖层（`channelColumnLayout` 的短路项）。
   * **不是「该不该 overlay」的唯一输入**（子会话 PR4c fix）——非窄窗时还要看
   * `.pane` 与右栏的实际宽度放不放得下，那部分量算在组件内部做，这里只传全局信号。
   */
  narrow: boolean;
  /** 通道列宽度（App 持有，同 `rightPanelWidth` 的宽度记忆）。拖动中只改本地，松手才落盘。 */
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  /**
   * 用户对这个父会话显隐的显式选择（App 按父会话 id 记，ephemeral）。
   * null = 没有显式选择，走默认——放得下（inline）有可见通道即显示，放不下
   * （overlay，全局窄窗或单纯放不下）不自动出现。
   */
  shown: boolean | null;
  /** 只在「隐藏后出现新的可见通道」这一拍调用，让 App 把 shown 记成显式 true（3.2 裁决） */
  onShownChange: (shown: boolean) => void;
  /** 上报「此刻有没有可见通道」——App 的右图标条入口显隐 / 点亮靠它 */
  onVisibilityChange: (hasVisible: boolean) => void;
  /**
   * 上报「此刻该 inline 还是 overlay」（子会话 PR4c fix）——App 的默认显隐判定
   * 与 Esc 协调都要知道这个结果，同 `onVisibilityChange` 先例：值真的变化才报。
   */
  onLayoutChange: (overlay: boolean) => void;
  openRequest: ChannelOpenRequest | null;
}) {
  const { parentId } = props;
  const summaries = useChannelSummaries(parentId);
  const phaseOf = props.session.phaseOf;
  const liveRunning = useCallback((childId: string) => phaseOf(childId) !== "idle", [phaseOf]);
  const { entries, autoShow } = useMemo(() => visibleChannels(summaries, liveRunning), [summaries, liveRunning]);

  // 上报可见性：值真的变化才报，避免每次渲染都推一次相同的布尔值上去
  const hasVisibleRef = useRef<boolean | null>(null);
  const onVisibilityChange = props.onVisibilityChange;
  useEffect(() => {
    const has = entries.length > 0;
    if (hasVisibleRef.current !== has) {
      hasVisibleRef.current = has;
      onVisibilityChange(has);
    }
  }, [entries.length, onVisibilityChange]);

  // 根 div 的 ref：量 `.pane` 与右栏此刻的实际宽度（子会话 PR4c fix；本刀顺带
  // 给拖宽用——C = paneWidth − rightPanelWidth 恰好就是「主槽 + 通道列」的总宽，
  // 不管通道列此刻是 inline 还是 overlay：inline 时它是三者之和减右栏，overlay
  // 时通道列不占 flex 空间，chat 主区独吞这部分，两种情况算出来是同一个数）。
  const columnRef = useRef<HTMLDivElement | null>(null);
  const { paneWidth, rightPanelWidth } = usePaneAndRightPanelWidth(columnRef);
  const chatTotal = paneWidth - rightPanelWidth;
  const width = chatTotal > 0 ? clampChannelColumnWidth(props.width, chatTotal) : props.width;
  const layout = channelColumnLayout({
    narrow: props.narrow,
    paneWidth,
    rightPanelWidth,
    columnWidth: width,
  });
  // 「放不放得下」判定出的 overlay，取代下面所有原先直接读 `props.narrow` 的地方——
  // 全局窄窗只是 overlay 的一种成因（channelColumnLayout 内部已经把 narrow 短路成
  // overlay），非窄窗但放不下是另一种，两种成因走同一套「窄窗行为」
  const overlay = layout === "overlay";
  const overlayRef = useRef<boolean | null>(null);
  const onLayoutChange = props.onLayoutChange;
  useEffect(() => {
    if (overlayRef.current !== overlay) {
      overlayRef.current = overlay;
      onLayoutChange(overlay);
    }
  }, [overlay, onLayoutChange]);

  // 已解析的显隐：没有显式选择时，放得下（inline）且**有往来的通道**触发才默认
  // 显示（用户 2026-09-23 裁决：通信始于子会话有提问需求的时候）；只派出没说话
  // 的通道不该替用户弹出整列，即便此刻放得下。
  const open = parentId !== null && entries.length > 0 && (props.shown ?? (autoShow && !overlay));

  // 隐藏后出现新的「有往来」通道自动重新显示——只认 hasExchange 这一类（同上，
  // 整列的自动出现只由它们触发）；只在**放得下（inline）**成立：overlay 的
  // 默认就是不出现，新通道不该替用户做主弹出一个盖住聊天区的覆盖层。按父会话 id
  // 记「见过」的 childId 集合——这个 ref 活在 ChannelColumn 自己的生命周期（App
  // 里常驻挂载，不随切换根会话卸载），隐藏状态与「见过什么」都能跨会话切换记住。
  const seenRef = useRef<Map<string, ReadonlySet<string>>>(new Map());
  const onShownChange = props.onShownChange;
  useEffect(() => {
    if (parentId === null) return;
    const seen = seenRef.current.get(parentId) ?? new Set<string>();
    const currentExchanging = new Set(
      entries.filter((entry) => entry.summary.hasExchange).map((entry) => entry.summary.childId),
    );
    const hasNew = [...currentExchanging].some((id) => !seen.has(id));
    seenRef.current.set(parentId, currentExchanging);
    if (hasNew && !open && !overlay) onShownChange(true);
    // open/onShownChange 故意不进依赖：只在「出现新可见通道」这一拍判一次要不要
    // 打开，不需要 open 变化本身触发重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, entries, overlay]);

  // 单个通道的折叠：ephemeral，按 childId 记**用户的显式选择**（没有 = 走
  // `defaultCollapsed`）——只派出没说话的通道默认折叠，一旦子说话或用户手动
  // 展开过，交回用户手里，不会被「默认值」重新盖掉。点标记 → 强制展开对应通道
  // （显隐本身已经由 App 的 openChannel 在同一次操作里设成 shown=true，这里只管折叠）。
  const [collapsedOverride, setCollapsedOverride] = useState<ReadonlyMap<string, boolean>>(new Map());
  const toggleCollapsed = useCallback((childId: string, current: boolean) => {
    setCollapsedOverride((prev) => new Map(prev).set(childId, !current));
  }, []);
  const { openRequest } = props;
  useEffect(() => {
    if (openRequest === null) return;
    setCollapsedOverride((prev) => {
      if (prev.get(openRequest.childId) === false) return prev;
      return new Map(prev).set(openRequest.childId, false);
    });
  }, [openRequest]);

  // 拖宽（用户 2026-09-23 裁决）：左移变宽——同 RightPanel.tsx 的 startResize，
  // 通道列的左缘挨着主槽（chat 主区），主槽 flex:1 让出的正是通道列多拿的。
  // 拖动中只改本地宽度，松手才落盘；chatTotal 拖动中恒定（量的是 `.pane` 与
  // 右栏各自的实际渲染宽，不受通道列自己宽度变化的影响），闭包捕获一次够用。
  const [resizing, setResizing] = useState(false);
  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const el = columnRef.current;
    if (el === null) return;
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = el.getBoundingClientRect().width;
    const clamp = (value: number): number => clampChannelColumnWidth(value, chatTotal);
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      props.onWidthChange(clamp(startWidth - (ev.clientX - startX)));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
      setResizing(false);
      props.onWidthCommit(clamp(startWidth - (ev.clientX - startX)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  const overlayStyle: React.CSSProperties =
    overlay && open
      ? {
          position: "absolute",
          top: "var(--space-3)",
          bottom: "var(--space-3)",
          right: "calc(var(--space-3) + 32px + var(--space-3))",
          background: "var(--glass-bg)",
          border: "1px solid var(--glass-border)",
          borderRadius: "var(--radius-xl)",
          boxShadow: "var(--shadow-popover)",
          zIndex: 20,
          animation: "right-panel-in var(--duration-enter) var(--ease-out-quint)",
        }
      : {};

  return (
    <div
      ref={columnRef}
      className={`channel-column${open ? " open" : ""}${resizing ? " dragging" : ""}`}
      style={
        {
          "--channel-column-w": `${props.narrow ? CHANNEL_COLUMN_WIDTH_DEFAULT : width}px`,
          ...overlayStyle,
        } as React.CSSProperties
      }
    >
      {/* 拖宽热区：左缘 6px，骑在与主槽的分界线上；双击回默认（照 RightPanel.tsx 先例） */}
      {!props.narrow && (
        <span
          onPointerDown={startResize}
          onDoubleClick={() => props.onWidthCommit(clampChannelColumnWidth(CHANNEL_COLUMN_WIDTH_DEFAULT, chatTotal))}
          title="Drag to resize · double-click to reset"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: "col-resize",
            zIndex: 5,
          }}
        />
      )}
      <div className="channel-column-inner">
        {entries.map((entry) => {
          const collapsed = collapsedOverride.get(entry.summary.childId) ?? entry.defaultCollapsed;
          return (
            <ChannelCard
              key={entry.summary.childId}
              summary={entry.summary}
              parentTitle={props.parentTitle}
              collapsed={collapsed}
              onToggleCollapsed={() => toggleCollapsed(entry.summary.childId, collapsed)}
              pendingScroll={
                openRequest !== null && openRequest.childId === entry.summary.childId ? openRequest : null
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function statusTone(status: ChannelStatus): { color: string; text: string; icon: IconName; breathing: boolean } {
  switch (status) {
    case "running":
      return { color: "var(--color-accent)", text: "running", icon: "loader-circle", breathing: true };
    case "waiting":
      return { color: "var(--color-warning)", text: "waiting", icon: "message-square", breathing: false };
    case "done":
      return { color: "var(--color-success)", text: "done", icon: "circle-check", breathing: false };
    case "failed":
      return { color: "var(--color-danger)", text: "failed", icon: "triangle-alert", breathing: false };
  }
}

/** 一张通道卡：头部（对子标题 + 状态）、消息区、composer / closed 行。 */
function ChannelCard(props: {
  summary: ChannelSummary;
  parentTitle: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  pendingScroll: ChannelOpenRequest | null;
}) {
  const { summary } = props;
  const key: ChannelKey = useMemo(
    () => ({ parentId: summary.parentId, childId: summary.childId }),
    [summary.parentId, summary.childId],
  );
  const channelMessages = useChannelMessages(key);
  const tone = statusTone(summary.status);

  return (
    <div className={props.collapsed ? "channel-card collapsed" : "channel-card"}>
      <button
        type="button"
        className="channel-card-head"
        aria-expanded={!props.collapsed}
        onClick={props.onToggleCollapsed}
      >
        <span className="channel-card-pair">
          <span className="channel-card-pair-title">{props.parentTitle}</span>
          <Icon name="arrow-left-right" size={11} strokeWidth={1.8} />
          <span className="channel-card-pair-title">{summary.childTitle}</span>
        </span>
        <span className={tone.breathing ? "channel-card-status orbita-breath" : "channel-card-status"} style={{ color: tone.color }}>
          <Icon name={tone.icon} size={11} strokeWidth={1.8} />
          {tone.text}
        </span>
        <Icon name={props.collapsed ? "chevron-down" : "chevron-up"} size={12} strokeWidth={1.8} />
      </button>
      {!props.collapsed && (
        <>
          <ChannelMessageList state={channelMessages} pendingScroll={props.pendingScroll} />
          <ChannelFoot summary={summary} />
        </>
      )}
    </div>
  );
}

function ChannelMessageList(props: {
  state: ReturnType<typeof useChannelMessages>;
  pendingScroll: ChannelOpenRequest | null;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // task 消息不在通道列里重复显示（用户 2026-09-23 裁决①：任务回到子会话自己的
  // session 里渲染成完整任务卡）——通道从第一条非 task 消息开始。
  const messages = useMemo(() => nonTaskMessages(props.state.messages), [props.state.messages]);

  const handleScroll = () => {
    const el = listRef.current;
    if (el !== null) followRef.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  // 新消息到达时若用户在底部则跟着滚——不是每条都强制滚（跟 ChatView 主流同一条纪律）
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // 点父流里的标记：滚到具体消息（找不到——数据还没到——等下一次消息更新再试）或滚到底，短暂高亮。
  // `handledToken` 挡住重复触发：同一个 token 处理过一次之后，这个通道之后再来新消息
  // （props.state.messages 变化）不该把用户已经看过的那次高亮又放一遍。
  const handledToken = useRef<number | null>(null);
  useEffect(() => {
    const request = props.pendingScroll;
    if (request === null || handledToken.current === request.token) return;
    const el = listRef.current;
    if (el === null) return;
    if (request.messageId === null) {
      el.scrollTop = el.scrollHeight;
      handledToken.current = request.token;
      return;
    }
    const node = el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(request.messageId)}"]`);
    if (node === null) return; // 消息还没到——不标记已处理，等 messages 更新再试一次
    node.scrollIntoView({ block: "center" });
    handledToken.current = request.token;
    setHighlightId(request.messageId);
    const timer = window.setTimeout(() => setHighlightId(null), 1200);
    return () => window.clearTimeout(timer);
  }, [props.pendingScroll, props.state.messages]);

  return (
    <div className="channel-card-body" ref={listRef} onScroll={handleScroll}>
      {props.state.loading && <ChannelStatusLine>Loading…</ChannelStatusLine>}
      {props.state.error !== null && <ChannelStatusLine danger>{props.state.error}</ChannelStatusLine>}
      {!props.state.loading && props.state.error === null && messages.length === 0 && (
        <ChannelStatusLine>No messages yet — speak as parent to steer it.</ChannelStatusLine>
      )}
      {messages.map((message) => (
        <ChannelMessageRow key={message.id} message={message} highlighted={message.id === highlightId} />
      ))}
    </div>
  );
}

function ChannelStatusLine(props: { children: React.ReactNode; danger?: boolean }) {
  return (
    <p
      role={props.danger === true ? "alert" : undefined}
      style={{
        margin: 0,
        fontSize: "var(--font-size-caption)",
        color: props.danger === true ? "var(--color-danger)" : "var(--color-text-tertiary)",
      }}
    >
      {props.children}
    </p>
  );
}

function whoToneColor(tone: ReturnType<typeof channelWhoLabel>["tone"]): string {
  switch (tone) {
    case "question":
      return "var(--color-warning)";
    case "reply":
      return "var(--color-accent)";
    case "done":
      return "var(--color-success)";
    case "failed":
      return "var(--color-danger)";
    default:
      return "var(--color-text-tertiary)";
  }
}

/** 单条通道消息：父左子右（谁说话靠哪边——两个 agent 的对话，不是 user/assistant）。 */
function ChannelMessageRow(props: { message: ChannelMessage; highlighted: boolean }) {
  const { message } = props;
  const side = message.from === "parent" ? "from-parent" : "from-child";
  const label = channelWhoLabel(message);
  return (
    <div
      data-message-id={message.id}
      className={`channel-message ${side}${props.highlighted ? " highlight" : ""}`}
    >
      <span className="channel-message-who" style={{ color: whoToneColor(label.tone) }}>
        <Icon name={channelKindIcon(message.kind)} size={10} strokeWidth={1.8} />
        {label.text}
        {label.you && <span style={{ color: "var(--color-text-primary)" }}> · you</span>}
      </span>
      <MarkdownBlock text={message.text} variant="bubble" />
    </div>
  );
}

const DELIVERY_TITLE =
  "steer: injects at the next tool call without stopping it · turn end: waits until its current turn ends";

/** running / waiting 状态的 composer，或 done / failed 的 closed 行（reopen 后换成同一个 composer）。 */
function ChannelFoot(props: { summary: ChannelSummary }) {
  const { summary } = props;
  const closed = summary.status === "done" || summary.status === "failed";
  const [reopened, setReopened] = useState(false);
  // reopen 只对**这一次** closed 有效：reply 送达后 status 翻回 running（第 2 节），
  // 之后子若再报一次 done/failed（新的一次 closed），要重新显示「closed · reopen
  // to speak」——不能因为用户之前点过一次 reopen 就让 composer 永远留着。
  const prevStatusRef = useRef(summary.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = summary.status;
    if (closed && prev !== summary.status) setReopened(false);
  }, [summary.status, closed]);
  if (closed && !reopened) {
    return (
      <div className="channel-card-foot channel-card-foot-closed">
        <span>closed ·</span>
        <button type="button" className="channel-reopen" onClick={() => setReopened(true)}>
          <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
          reopen to speak
        </button>
      </div>
    );
  }
  return <ChannelComposer parentId={summary.parentId} childId={summary.childId} />;
}

function ChannelComposer(props: { parentId: string; childId: string }) {
  const [text, setText] = useState("");
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = "auto";
    const computed = getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight);
    const padding = Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom);
    const { height, scrollable } = composerBoxHeight(
      el.scrollHeight,
      Number.isFinite(lineHeight) ? lineHeight : 18,
      Number.isFinite(padding) ? padding : 0,
      1,
      6,
    );
    el.style.height = `${height}px`;
    el.style.overflowY = scrollable ? "auto" : "hidden";
  }, [text]);

  const send = (): void => {
    const value = text.trim();
    if (value === "" || sending) return;
    setSending(true);
    setError(null);
    void api.channel
      .speak({ parentId: props.parentId, childId: props.childId, text: value, delivery })
      .then(() => setText(""))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setSending(false));
  };

  return (
    <div className="channel-card-foot channel-card-foot-composer">
      {error !== null && <ChannelStatusLine danger>{error}</ChannelStatusLine>}
      <div className="channel-composer-row">
        <button
          type="button"
          className="channel-delivery-chip"
          title={DELIVERY_TITLE}
          onClick={() => setDelivery((prev) => (prev === "steer" ? "followUp" : "steer"))}
        >
          {delivery === "steer" ? "steer" : "turn end"}
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          className="channel-composer-input"
          placeholder="Speak as parent…"
          value={text}
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              !isSubmitKey({
                key: event.key,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.keyCode,
              })
            ) {
              return;
            }
            event.preventDefault();
            send();
          }}
        />
        <button
          type="button"
          className="channel-composer-send"
          aria-label="Send"
          title="Send"
          disabled={sending || text.trim() === ""}
          onClick={send}
        >
          <Icon name="arrow-up" size={14} />
        </button>
      </div>
    </div>
  );
}
