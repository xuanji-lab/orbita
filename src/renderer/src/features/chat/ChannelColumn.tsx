/**
 * 父子会话面板（通道列，子会话 PR4b）——一个通道一张卡，父子之间的往来抽出来放在
 * 这里，两边主流里只留一行标记指向它（`ChannelViews.tsx`）。
 *
 * **放在哪由宽窄决定**（用户 2026-09-25 裁决，判定见 `channel-column.ts` 的
 * `channelPanelWide`）：
 *   - 够宽：`ChannelColumn`——主槽与右栏之间独立的一列，**只有它**能把页面变成
 *     二分屏 / 三分屏。`App.tsx` 常驻挂载（同 `RightPanelSlot` 的先例——壳一直在，
 *     `open` 只是 class 切换驱动的宽度过渡）。**可拖宽**（用户 2026-09-23 裁决）：
 *     区间是 chat 区（主槽 + 本列）的 1/6–1/3，且不越过「三栏放得下」的上限；宽度由
 *     App 持有并落盘，拖动中只改本地，松手才 commit。
 *   - 不够宽：同一份卡片（`ChannelCards`）住进右栏槽（`RightPanelKind` 的
 *     `"channels"`），与其它入口互斥、继承槽宽。**不再有覆盖层**：以前放不下时整列
 *     浮起、压在右栏上，底下的字漏上来（2026-09-25 实测）。
 *
 * 卡片不带自己的面板框：第一张卡的头部就是这一列 / 这个槽的页头，与两侧页头同高
 * （styles.css `.channel-card-head`）——两种位置长得一样，只是宽度来源不同。
 *
 * **通道的出现规则**（用户 2026-09-23 裁决，`visibleChannels`）：只派出、子还在
 * 跑但没说过话的通道不再占一整张卡——折叠成一行头部，展开才是「代父插嘴」的入口；
 * 整列的自动出现（没有显式 `shown` 选择时的默认值）只由**有往来**的通道触发，且只在
 * 够宽时——不够宽时它只能进槽，不替用户换掉槽里的东西。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChannelKey, ChannelMessage, ChannelStatus, ChannelSummary } from "@shared/channel";
import { CHANNEL_COLUMN_WIDTH_DEFAULT, clampChannelColumnWidth } from "@shared/settings";
import { api } from "../../api";
import { isSubmitKey } from "../../shell/composer-keys.ts";
import { composerBoxHeight } from "../../shell/composer-height.ts";
import { Icon, type IconName } from "../../shell/Icon";
import { channelWhoLabel, nonTaskMessages, type ChannelColumnEntry } from "./channel-column.ts";
import { channelKindIcon } from "./ChannelViews";
import { MarkdownBlock } from "./MarkdownBlock";
import { isAtBottom } from "./scroll.ts";
import { useChannelMessages } from "./useChannelMessages";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";

/** 点父流里的标记 → 父子会话面板的一次性请求：展开该通道、滚到那条消息（或底部）并高亮。 */
export interface ChannelOpenRequest {
  childId: string;
  messageId: string | null;
  /** 每次请求自增——同一条 childId/messageId 再点一次也要能重新触发滚动与高亮 */
  token: number;
}

/**
 * 卡片列表：内联列与右栏槽共用。单卡的折叠是 ephemeral 的，按 childId 记**用户的
 * 显式选择**（没有 = 走 `defaultCollapsed`）——只派出没说话的通道默认折叠，一旦子
 * 说话或用户手动展开过，交回用户手里，不会被「默认值」重新盖掉。点标记 → 强制展开
 * 对应通道（显隐本身已经由 App 在同一次操作里定好，这里只管折叠）。
 */
export function ChannelCards(props: {
  parentTitle: string;
  entries: readonly ChannelColumnEntry[];
  openRequest: ChannelOpenRequest | null;
  /** 容器的 class：内联列要 `channel-column-inner`（定宽），槽里不要 */
  className?: string;
}) {
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

  return (
    <div className={props.className === undefined ? "channel-cards" : `channel-cards ${props.className}`}>
      {props.entries.map((entry) => {
        const collapsed = collapsedOverride.get(entry.summary.childId) ?? entry.defaultCollapsed;
        return (
          <ChannelCard
            key={entry.summary.childId}
            summary={entry.summary}
            parentTitle={props.parentTitle}
            collapsed={collapsed}
            onToggleCollapsed={() => toggleCollapsed(entry.summary.childId, collapsed)}
            pendingScroll={openRequest !== null && openRequest.childId === entry.summary.childId ? openRequest : null}
          />
        );
      })}
    </div>
  );
}

/** 够宽时的内联列：宽度过渡、拖宽热区、「隐藏后出现新的有往来通道自动重新显示」。 */
export function ChannelColumn(props: {
  /** 主槽此刻看的根会话 id；null = 没在看根会话（子会话 / 设置页 / 首页） */
  parentId: string | null;
  parentTitle: string;
  entries: readonly ChannelColumnEntry[];
  /** 内联列此刻是否展开（App 按模式、显式选择与默认值算好，`channelInlineOpen`） */
  open: boolean;
  /** 够宽与否：不够宽时这一列不出现，新通道也不替用户弹出（那时它只能进槽） */
  wide: boolean;
  /** `.pane` 与右栏此刻的实际渲染宽（App 量好传下来，`usePaneAndRightPanelWidth`） */
  paneWidth: number;
  rightPanelWidth: number;
  /** 拖宽上限（`channelInlineMaxWidth`）：再宽三栏放不下，列会被挤进槽里 */
  maxWidth: number;
  /** 通道列宽度（App 持有，同 `rightPanelWidth` 的宽度记忆）。拖动中只改本地，松手才落盘。 */
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  /** 只在「隐藏后出现新的有往来通道」这一拍调用，让 App 把 shown 记成显式 true（3.2 裁决） */
  onShownChange: (shown: boolean) => void;
  openRequest: ChannelOpenRequest | null;
}) {
  const t = useT();
  const { parentId, entries, open, wide } = props;

  // C = paneWidth − rightPanelWidth 恰好是「主槽 + 通道列」的总宽：主槽 flex:1，
  // 通道列拿多少它就让多少，拖动中恒定
  const chatTotal = props.paneWidth - props.rightPanelWidth;
  const clamp = (value: number): number => {
    const clamped = chatTotal > 0 ? clampChannelColumnWidth(value, chatTotal) : value;
    // pane 还没量到时上限是负数：那时列本来就不显示（不够宽），不拿它夹出负宽度
    return props.maxWidth > 0 ? Math.min(clamped, props.maxWidth) : clamped;
  };
  const width = clamp(props.width);

  // 隐藏后出现新的「有往来」通道自动重新显示——只认 hasExchange 这一类（整列的自动
  // 出现只由它们触发）；只在够宽时成立：不够宽时它只能进槽，不替用户换掉槽里的东西。
  // 按父会话 id 记「见过」的 childId 集合——这个 ref 活在 ChannelColumn 自己的生命
  // 周期（App 里常驻挂载，不随切换根会话卸载），隐藏状态与「见过什么」都能跨会话切换记住。
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
    if (hasNew && !open && wide) onShownChange(true);
    // open/onShownChange 故意不进依赖：只在「出现新可见通道」这一拍判一次要不要
    // 打开，不需要 open 变化本身触发重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, entries, wide]);

  // 拖宽（用户 2026-09-23 裁决）：左移变宽——同 RightPanel.tsx 的 startResize，
  // 通道列的左缘挨着主槽（chat 主区），主槽 flex:1 让出的正是通道列多拿的。
  // 拖动中只改本地宽度，松手才落盘；chatTotal 拖动中恒定，闭包捕获一次够用。
  const columnRef = useRef<HTMLDivElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const el = columnRef.current;
    if (el === null) return;
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = el.getBoundingClientRect().width;
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

  return (
    <div
      ref={columnRef}
      className={`channel-column${open ? " open" : ""}${resizing ? " dragging" : ""}`}
      style={{ "--channel-column-w": `${width}px` } as React.CSSProperties}
    >
      {/* 拖宽热区：左缘 6px，骑在与主槽的分界线上；双击回默认（照 RightPanel.tsx 先例） */}
      <span
        onPointerDown={startResize}
        onDoubleClick={() => props.onWidthCommit(clamp(CHANNEL_COLUMN_WIDTH_DEFAULT))}
        title={t.common.dragResize}
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
      <ChannelCards
        className="channel-column-inner"
        parentTitle={props.parentTitle}
        entries={entries}
        openRequest={props.openRequest}
      />
    </div>
  );
}

function statusTone(
  status: ChannelStatus,
  t: Messages,
): { color: string; text: string; icon: IconName; breathing: boolean } {
  const text = t.channel.status[status];
  switch (status) {
    case "running":
      return { color: "var(--color-accent)", text, icon: "loader-circle", breathing: true };
    case "waiting":
      return { color: "var(--color-warning)", text, icon: "message-square", breathing: false };
    case "done":
      return { color: "var(--color-success)", text, icon: "circle-check", breathing: false };
    case "failed":
      return { color: "var(--color-danger)", text, icon: "triangle-alert", breathing: false };
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
  const t = useT();
  const { summary } = props;
  const key: ChannelKey = useMemo(
    () => ({ parentId: summary.parentId, childId: summary.childId }),
    [summary.parentId, summary.childId],
  );
  const channelMessages = useChannelMessages(key);
  const tone = statusTone(summary.status, t);

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
  const t = useT();
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
      {props.state.loading && <ChannelStatusLine>{t.common.loading}</ChannelStatusLine>}
      {props.state.error !== null && <ChannelStatusLine danger>{props.state.error}</ChannelStatusLine>}
      {!props.state.loading && props.state.error === null && messages.length === 0 && (
        <ChannelStatusLine>{t.channel.empty}</ChannelStatusLine>
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
  const t = useT();
  const { message } = props;
  const side = message.from === "parent" ? "from-parent" : "from-child";
  const label = channelWhoLabel(message, t);
  return (
    <div
      data-message-id={message.id}
      className={`channel-message ${side}${props.highlighted ? " highlight" : ""}`}
    >
      <span className="channel-message-who" style={{ color: whoToneColor(label.tone) }}>
        <Icon name={channelKindIcon(message.kind)} size={10} strokeWidth={1.8} />
        {label.text}
        {label.you && <span style={{ color: "var(--color-text-primary)" }}> · {t.channel.you}</span>}
      </span>
      <MarkdownBlock text={message.text} variant="bubble" />
    </div>
  );
}


/** running / waiting 状态的 composer，或 done / failed 的 closed 行（reopen 后换成同一个 composer）。 */
function ChannelFoot(props: { summary: ChannelSummary }) {
  const t = useT();
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
        <span>{t.channel.closed}</span>
        <button type="button" className="channel-reopen" onClick={() => setReopened(true)}>
          <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
          {t.channel.reopenToSpeak}
        </button>
      </div>
    );
  }
  return <ChannelComposer parentId={summary.parentId} childId={summary.childId} />;
}

function ChannelComposer(props: { parentId: string; childId: string }) {
  const t = useT();
  const [text, setText] = useState("");
  const [delivery, setDelivery] = useState<"steer" | "followUp">("steer");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 按内容定高（1–6 行）。**文字变了要重算，宽度变了也要**：内联列隐藏时宽 0，
  // 这时挂上的输入框按逐字换行算出一个撑满 6 行的高度；列展开、拖宽都不改文字，
  // 只听文字就一直顶着那个高度（2026-09-25 CDP 实测：不够宽→够宽后 114px，正常 24px）
  const fitHeight = useCallback(() => {
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
  }, []);
  useLayoutEffect(fitHeight, [text, fitHeight]);
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    let lastWidth = el.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const width = el.getBoundingClientRect().width;
      // 只认宽度：fitHeight 自己改高度也会触发回调，认高度就是自己触发自己
      if (width === lastWidth) return;
      lastWidth = width;
      fitHeight();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fitHeight]);

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
          title={t.channel.deliveryTip}
          onClick={() => setDelivery((prev) => (prev === "steer" ? "followUp" : "steer"))}
        >
          {delivery === "steer" ? t.channel.steer : t.channel.turnEnd}
        </button>
        <textarea
          ref={textareaRef}
          rows={1}
          className="channel-composer-input"
          placeholder={t.channel.speakAsParent}
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
          aria-label={t.composer.send}
          title={t.composer.send}
          disabled={sending || text.trim() === ""}
          onClick={send}
        >
          <Icon name="arrow-up" size={14} />
        </button>
      </div>
    </div>
  );
}
