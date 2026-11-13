import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { ChannelMessage } from "@shared/channel";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { StatusPie } from "../../shell/StatusPie";
import { Menu, type MenuItem } from "../../shell/Menu";
import { Chip } from "../../shell/Chip";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import type { PendingApproval, SessionEntry } from "./session-states.ts";
import {
  automationLine,
  bgInlineCap,
  bgSummary,
  bgSummaryParts,
  bgToolLabel,
  foldBgItems,
  needsClock,
  stepText,
  visibleBgItems,
  type BgItem,
  type BgSubItem,
  type BgSummaryPart,
} from "./background-strip.ts";
import { subSessionBarFill } from "./sub-sessions-rows.ts";
import { toolWord } from "./builtin-commands.ts";
import { formatRunClock, rollupToolKey } from "./tool-results.ts";
import type { HomeCardLineText } from "./home-cards.ts";

/** 浮层清单最多露出几行，再多在清单内部滚（面板高 = 行数 × 行高 + 上下内边距） */
const LIST_ROWS = 6;
/** 清单一行高 = `--control-height-md`（32）；面板内边距上下各 `--space-1`（4） */
const LIST_MAX_HEIGHT = LIST_ROWS * 32 + 8;

/**
 * 后台任务状态位（2026-11-13 起；2026-11-14 用户：「空间利用率太低了，占用太多看聊天记录的空间」
 * ——所以它**不是一张卡、不推版面**）。两种落点，数据与交互是同一套：
 *   - line（细条，默认）：输入框上沿的一行小字，没有自己的外框 / 底色 / 阴影，左缘与输入框文字
 *     对齐；「后台」+ 计数 + 按宽度并排的前几项（饼 + 名字 + 当前一步）+「+N」。整行是一个触发器；
 *   - capsule（胶囊）：输入框底栏里的一颗（饼 + 「后台 3 · 1 等你」），不占对话区一个像素；
 *     底栏收窄时分三档收：全文 / 「后台 3」/ 只留总数（styles.css）。
 * 点开都是同一个浮层清单（复用 `Menu`：`.glass-float` + `.menu-panel` 那一套，盖在对话区上，
 * 不推版面）：每项一行——饼、名字、当前一步、行尾已跑多久（自动化是下次运行时间）；等你的排最前；
 * 超过 6 项在清单内部滚。整行可点：子会话 → 右栏子会话面板的会话层，自动化 → 自动化面板里那一条。
 * 键盘：触发器 Tab 可达，Enter / 空格打开，上下键在行间走，Enter 进那一条，Esc 关并把焦点还给触发器。
 *
 * 没有后台项时渲染 null。完成项停留片刻后退场，失败项留到母会话处理过为止（background-strip.ts）。
 *
 * **性能**：memo 组件，props 全是稳定引用（`items` 由 useBackgroundItems 逐字段比较后才换），流式输出的
 * 每个 token 不会让它重画；要扫转录的「当前一步」按槽对象缓存，且只在有在跑 / 停留中的项时才开 1 秒时钟。
 */
export const BackgroundStatus = memo(function BackgroundStatus(props: {
  variant: "line" | "capsule";
  items: readonly BgItem[];
  /** 各子会话的通道全文（在问你 / 完成的结语、没载过槽时的最近一句） */
  channels: ReadonlyMap<string, readonly ChannelMessage[]>;
  entryOf: (id: string) => SessionEntry | undefined;
  approvalsOf: (id: string) => readonly PendingApproval[];
  onOpenSubSession: (childId: string) => void;
  onOpenAutomation: (automationId: string) => void;
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
  const lineText = useMemo(() => lineTextOf(t), [t]);
  const steps = useRef(new Map<string, StepCache>());

  // 细条自己的宽度（决定并排几项）：回调 ref 在它出现 / 消失时接上 / 断开观察；
  // 宽度只在跨过换档线时才进状态，拖窗口的每一帧不让它重画
  const [width, setWidth] = useState(Infinity);
  const observer = useRef<ResizeObserver | null>(null);
  const measure = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (el === null) return;
    const apply = (next: number): void => setWidth((prev) => (bgInlineCap(prev) === bgInlineCap(next) ? prev : next));
    apply(el.getBoundingClientRect().width);
    observer.current = new ResizeObserver(() => apply(el.getBoundingClientRect().width));
    observer.current.observe(el);
  }, []);

  const visible = visibleBgItems(props.items, now);
  if (visible.length === 0) return null;

  const stepOf = (item: BgSubItem): string => cachedStep(steps.current, item, props, t, lineText);
  const menuItems: MenuItem[] = visible.map((item): MenuItem => {
    if (item.kind === "automation") {
      return {
        id: item.key,
        label: item.title,
        glyph: <Icon name={FEATURE_ICON.automation} size={12} />,
        badge: <span className="bg-menu-time">{automationLine(item, Date.now(), t)}</span>,
        onSelect: () => props.onOpenAutomation(item.automationId),
      };
    }
    return {
      id: item.key,
      label: item.title === "" ? t.subSessions.untitled : item.title,
      glyph: <SubPie item={item} />,
      hint: stepOf(item),
      ...(item.status === "running"
        ? { badge: <span className="bg-menu-time">{formatRunClock(now - item.startedAt)}</span> }
        : null),
      onSelect: () => props.onOpenSubSession(item.childId),
    };
  });
  const summaryText = bgSummary(visible, t);
  const menuProps = {
    items: menuItems,
    placement: "above" as const,
    align: "start" as const,
    panelMinWidth: 360,
    panelMaxWidth: 560,
    panelMaxHeight: LIST_MAX_HEIGHT,
    // 浮层开合时把焦点交给面板 / 还给触发器：只有这里 opt-in，别的菜单行为不变
    manageFocus: true,
  };

  if (props.variant === "capsule") {
    const lead = visible[0];
    const waiting = visible.filter(
      (item) => item.kind === "sub" && (item.status === "waiting" || item.status === "approval"),
    ).length;
    return (
      <Menu
        {...menuProps}
        // 胶囊在底栏靠右：清单右缘对齐胶囊右缘，不探到右栏上
        align="end"
        trigger={({ open, toggle }) => (
          <Chip
              active={open}
              title={`${t.bgStrip.aria}: ${summaryText}`}
              ariaLabel={`${t.bgStrip.aria}: ${summaryText}`}
              onClick={toggle}
              className="chip-bg"
            >
              <span className="bg-cap">
                {lead !== undefined && lead.kind === "sub" ? (
                  <SubPie item={lead} />
                ) : (
                  <Icon name={FEATURE_ICON.automation} size={12} />
                )}
                <span className="bg-cap-long">{t.bgStrip.capsule(visible.length, waiting)}</span>
                <span className="bg-cap-mid">{t.bgStrip.capsuleMid(visible.length, waiting)}</span>
                <span className="bg-cap-short">{t.bgStrip.capsuleShort(visible.length, waiting)}</span>
              </span>
          </Chip>
        )}
      />
    );
  }

  const { shown, hidden } = foldBgItems(visible, bgInlineCap(width));
  return (
    <div ref={measure} className="bg-line">
      <Menu
        {...menuProps}
        fill
        trigger={({ open, toggle }) => (
          <button
            type="button"
            className="bg-line-btn"
            data-open={open || undefined}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`${t.bgStrip.aria}: ${summaryText}`}
            title={t.bgStrip.lineTip}
            onClick={toggle}
          >
            <span className="bg-line-label">{t.bgStrip.label}</span>
            <SummaryParts parts={bgSummaryParts(visible, t)} />
            {shown.map((item) => (
              <span key={item.key} className="bg-line-item" data-status={item.kind === "sub" ? item.status : undefined}>
                {item.kind === "sub" ? (
                  <SubPie item={item} />
                ) : (
                  <span className="bg-lead bg-lead-icon">
                    <Icon name={FEATURE_ICON.automation} size={12} />
                  </span>
                )}
                <span className="bg-item-name">{item.title === "" ? t.subSessions.untitled : item.title}</span>
                <span className="bg-item-text">
                  {item.kind === "sub" ? stepOf(item) : automationLine(item, Date.now(), t)}
                </span>
              </span>
            ))}
            {hidden.length > 0 && <span className="bg-more">{t.bgStrip.moreInline(hidden.length)}</span>}
            <span className="bg-line-chevron row-trailing">
              <Icon name="chevron-up" size={12} strokeWidth={2} />
            </span>
          </button>
        )}
      />
    </div>
  );
});

/** 条头 / 胶囊里的事实：各段之间一个居中点，「等你」那段染 warning（文字已经说了，颜色是第二信号） */
function SummaryParts(props: { parts: readonly BgSummaryPart[] }) {
  return (
    <span className="bg-strip-count">
      {props.parts.map((part, index) => (
        <span key={part.tone}>
          {index > 0 && <span className="bg-count-dot"> · </span>}
          <span className="bg-count-part" data-tone={part.tone}>
            {part.text}
          </span>
        </span>
      ))}
    </span>
  );
}

/** 行首状态槽（14 宽）里的饼：在跑的饼呼吸，别的档静止 */
function SubPie(props: { item: BgSubItem }) {
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

/** 首页记录行用的那套工具动词文案（ChatView 首页分支的同一份拼法）；只在「在跑却没有计划」时用到 */
function lineTextOf(t: Messages): HomeCardLineText {
  return {
    thinking: t.homeCard.thinking,
    doing: t.homeCard.doing,
    approve: t.homeCard.approve,
    childWaiting: t.homeCard.childWaiting,
    failed: t.homeCard.failed,
    done: t.homeCard.done,
    noText: t.homeCard.noText,
    verb: (toolName, input) => {
      const key = rollupToolKey(toolName, input);
      const word = toolWord(t.chat.rollupTool, key, input);
      // 表里没有的下划线 id（report_to_parent 等）不露给用户：走状态位自己的中文名 / 类别名
      return key.includes("_") && word === key ? bgToolLabel(key, t) : word;
    },
  };
}
