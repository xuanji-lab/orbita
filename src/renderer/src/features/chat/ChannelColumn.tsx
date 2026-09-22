/**
 * 通道列（子会话 PR4b）——主槽与右栏之间的一列，一个通道一张卡，父子之间的往来
 * 抽出来放在这里，两边主流里只留一行标记指向它（`ChannelViews.tsx`）。
 *
 * 布局：`App.tsx` 常驻挂载（同 `RightPanelSlot` 的先例——壳一直在，`open` 只是
 * class 切换驱动的宽度过渡），`parentId` 为 null（没在看根会话，或看的是子会话 /
 * 设置页）时不显示任何东西。宽 300px，不参与拖宽。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChannelKey, ChannelMessage, ChannelStatus, ChannelSummary } from "@shared/channel";
import { api } from "../../api";
import { isSubmitKey } from "../../shell/composer-keys.ts";
import { composerBoxHeight } from "../../shell/composer-height.ts";
import { Icon, type IconName } from "../../shell/Icon";
import { channelWhoLabel, visibleChannels } from "./channel-column.ts";
import { channelKindIcon } from "./ChannelViews";
import { MarkdownBlock } from "./MarkdownBlock";
import { isAtBottom } from "./scroll.ts";
import { useChannelMessages } from "./useChannelMessages";
import { useChannelSummaries } from "./useChannelSummaries";
import type { ChatSession } from "./useChatSession";

const COLUMN_WIDTH = 300;

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
  /** App 的 narrow（<960px）：不自动出现，改以右侧锚定覆盖层形式出现 */
  narrow: boolean;
  /**
   * 用户对这个父会话显隐的显式选择（App 按父会话 id 记，ephemeral）。
   * null = 没有显式选择，走默认——宽窗有可见通道即显示，窄窗不自动出现。
   */
  shown: boolean | null;
  /** 只在「隐藏后出现新的可见通道」这一拍调用，让 App 把 shown 记成显式 true（3.2 裁决） */
  onShownChange: (shown: boolean) => void;
  /** 上报「此刻有没有可见通道」——App 的右图标条入口显隐 / 点亮靠它 */
  onVisibilityChange: (hasVisible: boolean) => void;
  openRequest: ChannelOpenRequest | null;
}) {
  const { parentId } = props;
  const summaries = useChannelSummaries(parentId);
  const phaseOf = props.session.phaseOf;
  const liveRunning = useCallback((childId: string) => phaseOf(childId) !== "idle", [phaseOf]);
  const visible = useMemo(() => visibleChannels(summaries, liveRunning), [summaries, liveRunning]);

  // 上报可见性：值真的变化才报，避免每次渲染都推一次相同的布尔值上去
  const hasVisibleRef = useRef<boolean | null>(null);
  const onVisibilityChange = props.onVisibilityChange;
  useEffect(() => {
    const has = visible.length > 0;
    if (hasVisibleRef.current !== has) {
      hasVisibleRef.current = has;
      onVisibilityChange(has);
    }
  }, [visible.length, onVisibilityChange]);

  // 已解析的显隐：没有显式选择时，宽窗默认显示、窄窗默认不自动出现（3.2 裁决）。
  const open = parentId !== null && visible.length > 0 && (props.shown ?? !props.narrow);

  // 隐藏后出现新的可见通道自动重新显示——只在**宽窗**成立：窄窗的默认就是不出现，
  // 新通道不该替用户做主弹出一个盖住聊天区的覆盖层。按父会话 id 记「见过」的
  // childId 集合——这个 ref 活在 ChannelColumn 自己的生命周期（App 里常驻挂载，
  // 不随切换根会话卸载），隐藏状态与「见过什么」都能跨会话切换记住。
  const seenRef = useRef<Map<string, ReadonlySet<string>>>(new Map());
  const onShownChange = props.onShownChange;
  const narrow = props.narrow;
  useEffect(() => {
    if (parentId === null) return;
    const seen = seenRef.current.get(parentId) ?? new Set<string>();
    const currentIds = new Set(visible.map((summary) => summary.childId));
    const hasNew = [...currentIds].some((id) => !seen.has(id));
    seenRef.current.set(parentId, currentIds);
    if (hasNew && !open && !narrow) onShownChange(true);
    // open/onShownChange 故意不进依赖：只在「出现新可见通道」这一拍判一次要不要
    // 打开，不需要 open 变化本身触发重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parentId, visible, narrow]);

  // 单个通道的折叠：ephemeral，按 childId 记。点标记 → 强制展开对应通道
  // （显隐本身已经由 App 的 openChannel 在同一次操作里设成 shown=true，这里只管折叠）。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleCollapsed = useCallback((childId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(childId)) next.delete(childId);
      else next.add(childId);
      return next;
    });
  }, []);
  const { openRequest } = props;
  useEffect(() => {
    if (openRequest === null) return;
    setCollapsed((prev) => {
      if (!prev.has(openRequest.childId)) return prev;
      const next = new Set(prev);
      next.delete(openRequest.childId);
      return next;
    });
  }, [openRequest]);

  const narrowOverlayStyle: React.CSSProperties =
    props.narrow && open
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
      className={`channel-column${open ? " open" : ""}`}
      style={{ "--channel-column-w": `${COLUMN_WIDTH}px`, ...narrowOverlayStyle } as React.CSSProperties}
    >
      <div className="channel-column-inner">
        {visible.map((summary) => (
          <ChannelCard
            key={summary.childId}
            summary={summary}
            parentTitle={props.parentTitle}
            collapsed={collapsed.has(summary.childId)}
            onToggleCollapsed={() => toggleCollapsed(summary.childId)}
            pendingScroll={openRequest !== null && openRequest.childId === summary.childId ? openRequest : null}
          />
        ))}
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
    <div
      className="channel-card"
      style={{ flex: props.collapsed ? "0 0 auto" : "1 1 0", minHeight: props.collapsed ? undefined : 0 }}
    >
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

  const handleScroll = () => {
    const el = listRef.current;
    if (el !== null) followRef.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
  };

  // 新消息到达时若用户在底部则跟着滚——不是每条都强制滚（跟 ChatView 主流同一条纪律）
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
  }, [props.state.messages.length]);

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
      {props.state.messages.map((message) => (
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
