import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { ChannelMessage } from "@shared/channel";
import type { BackgroundStripStyle } from "@shared/settings";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { StatusPie } from "../../shell/StatusPie";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import type { PendingApproval, SessionEntry } from "./session-states.ts";
import {
  automationLine,
  bgInlineCap,
  bgSummary,
  bgSummaryParts,
  foldBgItems,
  needsClock,
  overflowTarget,
  stepText,
  visibleBgItems,
  type BgItem,
  type BgSummaryPart,
  type BgSubItem,
} from "./background-strip.ts";
import { subSessionBarFill } from "./sub-sessions-rows.ts";
import { toolWord } from "./builtin-commands.ts";
import { formatRunClock, rollupToolKey } from "./tool-results.ts";
import type { HomeCardLineText } from "./home-cards.ts";

/**
 * 输入框上方的后台任务条（2026-11-13）。位置与 QueueStrip / ApprovalBar 同一族：
 * 都在 Pane 的页脚网格里、输入框正上方；本条在三者里最靠上——它是常驻的「背景事实」，
 * 审批要你回答、排队是等发出的话，这两样离输入框更近。
 *
 * 结构与交互只有一套，两种密度只差版式（设置 › 外观）：
 *   - summary（汇总条，默认）：一行。左边「后台 2 项在跑 · 1 项等你」，右边最多并排三项
 *     （饼 + 名字 + 当前那一步），多的折成「+N」；
 *   - rows（分行条）：条头同一句事实，每项一行（饼、名字、当前那一步、已跑多久、「打开」），
 *     最多 4 行，多的折成条头右端的「还有 N 项」。
 * 点一项 = 进它（子会话 → 右栏子会话面板的会话层，同派出卡点击的那条路；自动化 → 自动化面板
 * 里那一条）。每项是个 button：Tab 走得到，Enter 等同点击；没有「全部忽略」——项只随真实状态消失。
 *
 * 没有后台项时整条不渲染（不留空框和分隔线）。完成项停留 `BG_LINGER_MS` 后自己退场，
 * 不弹跳；持续动效只有在跑的饼的呼吸（设计系统：旋转与呼吸两种之一，失焦时暂停）。
 *
 * **性能**：本组件是 memo，props 全是稳定引用（`items` 由 useBackgroundItems 逐字段比较后才换，
 * 按 id 查询的函数引用稳定），流式输出每个 token 都不会让它重画；「当前在做哪一步」要扫转录，
 * 只在条自己的 1 秒时钟（且只在有在跑 / 停留中的项时才走）里重算，并按槽对象缓存。
 */
export const BackgroundStrip = memo(function BackgroundStrip(props: {
  items: readonly BgItem[];
  density: BackgroundStripStyle;
  /** 各子会话的通道全文（在问你 / 完成的结语、没载过槽时的最近一句） */
  channels: ReadonlyMap<string, readonly ChannelMessage[]>;
  entryOf: (id: string) => SessionEntry | undefined;
  approvalsOf: (id: string) => readonly PendingApproval[];
  onOpenSubSession: (childId: string) => void;
  onOpenAutomation: (automationId: string) => void;
  /** 「+N」/「还有 N 项」：打开子会话列表 / 自动化面板 */
  onOpenSubSessionsList: () => void;
  onOpenAutomationPanel: () => void;
}) {
  const t = useT();
  const clock = needsClock(props.items);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!clock) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [clock]);
  // 条自己的宽度（汇总条据此决定并排几项）：回调 ref 在条出现 / 消失时接上 / 断开观察
  const [width, setWidth] = useState(Infinity);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (el === null) return;
    // 宽度只在跨过换档线时才进状态：拖窗口的每一帧不让条重画
    const apply = (next: number): void => setWidth((prev) => (bgInlineCap(prev) === bgInlineCap(next) ? prev : next));
    apply(el.getBoundingClientRect().width);
    observer.current = new ResizeObserver(() => apply(el.getBoundingClientRect().width));
    observer.current.observe(el);
  }, []);
  const lineText = useMemo(() => lineTextOf(t), [t]);
  const steps = useRef(new Map<string, StepCache>());

  const visible = visibleBgItems(props.items, now);
  if (visible.length === 0) return null;
  const { shown, hidden } = foldBgItems(visible, props.density, bgInlineCap(width));
  const overflow = overflowTarget(hidden);
  // 事件对象不能直接当参数往外传（onOpenAutomationPanel 的实现吃一个可选的自动化 id）
  const openOverflow = (): void => {
    if (overflow === "subsessions") props.onOpenSubSessionsList();
    else props.onOpenAutomationPanel();
  };
  const summary = <SummaryParts parts={bgSummaryParts(visible, t)} />;

  const textOf = (item: BgItem): string => {
    if (item.kind === "automation") return automationLine(item, Date.now(), t);
    return cachedStep(steps.current, item, props, t, lineText);
  };
  const views = shown.map((item) => (
    <BgItemView
      key={item.key}
      item={item}
      density={props.density}
      text={textOf(item)}
      now={now}
      onOpen={() =>
        item.kind === "sub" ? props.onOpenSubSession(item.childId) : props.onOpenAutomation(item.automationId)
      }
    />
  ));

  if (props.density === "rows") {
    return (
      <section ref={measure} className="bg-strip glass-card" data-density="rows" aria-label={`${t.bgStrip.aria}: ${bgSummary(visible, t)}`}>
        <div className="bg-strip-head">
          <span className="bg-strip-label">{t.bgStrip.label}</span>
          {summary}
          {hidden.length > 0 && (
            <button type="button" className="bg-more row-trailing" onClick={openOverflow}>
              {t.bgStrip.moreRows(hidden.length)}
            </button>
          )}
        </div>
        <div className="bg-strip-items">{views}</div>
      </section>
    );
  }
  return (
    <section ref={measure} className="bg-strip glass-card" data-density="summary" aria-label={`${t.bgStrip.aria}: ${bgSummary(visible, t)}`}>
      <div className="bg-strip-head">
        <span className="bg-strip-label">{t.bgStrip.label}</span>
        {summary}
      </div>
      <div className="bg-strip-items">
        {views}
        {hidden.length > 0 && (
          <button
            type="button"
            className="bg-more"
            title={t.bgStrip.moreInlineTip(hidden.length)}
            onClick={openOverflow}
          >
            {t.bgStrip.moreInline(hidden.length)}
          </button>
        )}
      </div>
    </section>
  );
});

/** 条头的事实：各段之间一个居中点，「等你」那段染 warning（文字已经说了，颜色是第二信号） */
function SummaryParts(props: { parts: readonly BgSummaryPart[] }) {
  return (
    <span className="bg-strip-count">
      {props.parts.map((part, index) => (
        <span key={part.tone} className="bg-count-part" data-tone={part.tone}>
          {index > 0 && <span className="bg-count-dot"> · </span>}
          {part.text}
        </span>
      ))}
    </span>
  );
}

/** 一项：饼（子会话）或闹钟（自动化）+ 名字 + 当前那一步；分行条再加已跑多久与「打开」 */
function BgItemView(props: {
  item: BgItem;
  density: BackgroundStripStyle;
  text: string;
  now: number;
  onOpen: () => void;
}) {
  const t = useT();
  const { item } = props;
  const name = item.title === "" ? t.subSessions.untitled : item.title;
  const rows = props.density === "rows";
  return (
    <button
      type="button"
      className="bg-item"
      data-kind={item.kind}
      data-status={item.kind === "sub" ? item.status : undefined}
      title={`${name} · ${props.text}`}
      onClick={props.onOpen}
    >
      {item.kind === "sub" ? <SubLead item={item} /> : <AutomationLead />}
      <span className="bg-item-name">{name}</span>
      <span className="bg-item-text">{props.text}</span>
      {rows && item.kind === "sub" && item.status === "running" && (
        <span className="bg-item-clock">{formatRunClock(props.now - item.startedAt)}</span>
      )}
      {rows && <span className="bg-item-open">{t.bgStrip.open}</span>}
    </button>
  );
}

/** 行首状态槽（14 宽，饼与闹钟图标同一根中线）。在跑的饼呼吸，别的档静止 */
function SubLead(props: { item: BgSubItem }) {
  const t = useT();
  const fill = subSessionBarFill(props.item.status) ?? "running";
  return (
    <span className="bg-lead">
      <StatusPie
        state={fill}
        title={t.subSessions.rowStatus[props.item.status]}
        className={props.item.status === "running" ? "orbita-breath" : undefined}
      />
    </span>
  );
}

function AutomationLead() {
  return (
    <span className="bg-lead bg-lead-icon">
      <Icon name={FEATURE_ICON.automation} size={12} />
    </span>
  );
}

/** 「当前那一步」的缓存：槽对象（每个 token 换引用）+ 状态 + 通道账本都没变就不重扫转录 */
interface StepCache {
  entry: SessionEntry | undefined;
  status: BgSubItem["status"];
  messages: readonly ChannelMessage[] | undefined;
  text: string;
  /** 文案表换了（语言切换）要重算 */
  t: Messages;
}

function cachedStep(
  cache: Map<string, StepCache>,
  item: BgSubItem,
  props: {
    channels: ReadonlyMap<string, readonly ChannelMessage[]>;
    entryOf: (id: string) => SessionEntry | undefined;
    approvalsOf: (id: string) => readonly PendingApproval[];
  },
  t: Messages,
  lineText: HomeCardLineText,
): string {
  // 只有「在跑」读转录（计划的在做步 / 最近的动作）；别的状态都从通道账本与审批槽说话
  const entry = item.status === "running" ? props.entryOf(item.childId) : undefined;
  const messages = props.channels.get(item.childId);
  const hit = cache.get(item.key);
  if (hit !== undefined && hit.entry === entry && hit.status === item.status && hit.messages === messages && hit.t === t) {
    return hit.text;
  }
  const approval = props.approvalsOf(item.childId)[0];
  const text = stepText(
    {
      status: item.status,
      records: entry === undefined ? null : selectTranscript(entry.transcript),
      messages,
      approval: approval === undefined ? null : { toolName: approval.toolName, input: approval.input },
    },
    t,
    lineText,
  );
  cache.set(item.key, { entry, status: item.status, messages, text, t });
  return text;
}

/** 首页记录行用的那套工具动词文案（ChatView 首页分支的同一份拼法）；条里只在「在跑却没有计划」时用到 */
function lineTextOf(t: Messages): HomeCardLineText {
  return {
    thinking: t.homeCard.thinking,
    doing: t.homeCard.doing,
    approve: t.homeCard.approve,
    childWaiting: t.homeCard.childWaiting,
    failed: t.homeCard.failed,
    done: t.homeCard.done,
    noText: t.homeCard.noText,
    verb: (toolName, input) => toolWord(t.chat.rollupTool, rollupToolKey(toolName, input), input),
  };
}
