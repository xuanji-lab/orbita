import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { FEATURE_ICON } from "./feature-icons.ts";
import { InlineName } from "./InlineName";
import { useT } from "../locale.ts";
import type { Messages } from "../messages-en.ts";
import type { SessionCompletion } from "@shared/session";

export interface CapCompletionState {
  state: SessionCompletion;
  closing: boolean;
  busy: boolean;
  scanless: boolean;
  onMark: () => void;
  onSet: (next: "open" | "done") => void;
}

/**
 * 会话胶囊（工具栏居中那颗，排法甲 · 地址栏式，2026-10-19 用户裁决）：固定宽，
 * 三栏网格——**标题永远在胶囊正中**（像 Safari 地址栏里的域名）；左端子会话芯片 /
 * 父会话面包屑（同一槽位，没有就留空，不放占位）；右端短 id · 复制（悬停显形，
 * visibility 占位不挤标题）· 细竖线 · 收工键（**一直显示**——它是会话的主要出口，
 * 藏起来就找不到）。复制后按钮变对勾、胶囊下方浮「已复制 a3f9c1」约 1.2s；
 * 重命名时标题就地变输入框，外框不动。
 */
export function SessionCapsule(props: {
  title: string;
  /** 短 id（前 6 位）；null = 会话还没落盘（首条消息未发），右端次要件不摆 */
  shortId: string | null;
  onRename?: (title: string) => void;
  /**
   * 完成入口（open → 收工，非 open → Reopen）；null = 不摆（没落盘 / 生命周期关）。
   * 与 ChatView 页头同源的降级矩阵：扫描中转圈、在跑禁用、只读在 tooltip 说明。
   */
  completion: CapCompletionState | null;
  /** 左端子会话芯片；null = 留空（用户默认：不放「0」占位，可推翻） */
  subChip: { count: number; waiting: number } | null;
  onOpenSubSessions?: () => void;
  /** 左端面包屑「↑ 父标题」（子会话被 Open as main 时才有）；与子会话芯片同一槽位 */
  crumb: { title: string; onClick: () => void } | null;
}) {
  const t = useT();
  const completion = props.completion;

  return (
    <div className="cap-sess" style={{ width: "100%", height: "100%" }}>
      {/* 左端：父会话面包屑 或 子会话芯片；没有就留空 */}
      <div className="cap-sl">
        {props.crumb !== null ? (
          <button
            type="button"
            className="cap-crumb"
            onClick={props.crumb.onClick}
            title={t.chat.backToParent(props.crumb.title)}
          >
            <Icon name="arrow-up" size={11} strokeWidth={1.8} />
            <span>{props.crumb.title}</span>
          </button>
        ) : props.subChip !== null ? (
          <button
            type="button"
            className="cap-subchip"
            onClick={props.onOpenSubSessions}
            title={
              props.subChip.waiting > 0
                ? `${t.chat.subSessionCount(props.subChip.count)} · ${t.chat.subSessionWaiting(props.subChip.waiting)}`
                : t.chat.subSessionCount(props.subChip.count)
            }
          >
            <Icon name={FEATURE_ICON.subsessions} size={12} strokeWidth={1.8} />
            <b>{props.subChip.count}</b>
            {props.subChip.waiting > 0 && <span>· {t.chat.subSessionWaiting(props.subChip.waiting)}</span>}
          </button>
        ) : null}
      </div>

      {/* 正中：标题（重命名就地变输入框，外框不动）。左右各留一个铅笔位，悬停显形 */}
      <div className="cap-sc">
        <CapTitle title={props.title} onRename={props.onRename} balance />
      </div>

      {/* 右端：短 id · 复制（悬停）· 竖线 · 收工（一直显示） */}
      <div className="cap-sr">
        <CapSessionId shortId={props.shortId} />
        {completion !== null && (
          <>
            {props.shortId !== null && <span className="cap-vsep" />}
            <CapCompletion completion={completion} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 会话标题：双击或点铅笔就地改名（InlineName，外框不动）。会话胶囊与辅助对话胶囊共用，
 * 改名的手势、悬停显形的铅笔都只有这一份。`balance`：标题左侧再留一个同宽的隐形铅笔位，
 * 让标题在居中的会话胶囊里真正居中；辅助对话胶囊的标题靠左排，不留。
 */
export function CapTitle(props: {
  title: string;
  onRename?: ((title: string) => void) | undefined;
  balance?: boolean;
  /** 标题前的小图标（辅助对话用会话图标与主会话的分支图标区分），可选 */
  leading?: React.ReactNode;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  return (
    <>
      {props.balance === true && <span className="cap-mini cap-hov" aria-hidden="true" />}
      {props.leading}
      <InlineName
        editing={editing}
        value={props.title}
        onCommit={(value) => {
          setEditing(false);
          props.onRename?.(value);
        }}
        onCancel={() => setEditing(false)}
      >
        <strong
          className="cap-title"
          onDoubleClick={() => props.onRename !== undefined && setEditing(true)}
        >
          {props.title}
        </strong>
      </InlineName>
      {props.onRename !== undefined && !editing && (
        <button
          type="button"
          className="quiet-control cap-mini cap-hov"
          title={t.chat.renameTask}
          aria-label={t.chat.renameTask}
          onClick={() => setEditing(true)}
        >
          <Icon name="pencil-line" size={14} strokeWidth={1.8} />
        </button>
      )}
    </>
  );
}

/**
 * 短 id（等宽 · xs · 三级墨）+ 悬停显形的复制键；复制后按钮变对勾、下方浮「已复制 a3f9c1」约 1.2s。
 * shortId 为 null（会话还没落盘）什么都不摆。
 */
export function CapSessionId(props: { shortId: string | null }) {
  const t = useT();
  /** 复制成功的对勾 + 轻提示（1.2s 淡出） */
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  if (props.shortId === null) return null;
  const shortId = props.shortId;
  const copyId = (): void => {
    void navigator.clipboard.writeText(shortId);
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <>
      <span className="cap-sid">{shortId}</span>
      <button
        type="button"
        className="quiet-control cap-mini cap-hov"
        title={copied ? t.toolbar.copiedId(shortId) : t.toolbar.copyId}
        aria-label={t.toolbar.copyId}
        onClick={copyId}
      >
        <Icon name={copied ? "check" : "copy"} size={13} strokeWidth={1.9} />
      </button>
      {copied && (
        <span className="cap-toast">
          <Icon name="check" size={12} strokeWidth={2.4} />
          {t.toolbar.copiedId(shortId)}
        </span>
      )}
    </>
  );
}

/**
 * 完成键（open → 收工，非 open → Reopen），一直显示——它是会话的主要出口。
 * 降级矩阵（扫描中转圈、在跑禁用、只读在 tooltip 说明）与 ChatView 页头同口径。
 */
export function CapCompletion(props: { completion: CapCompletionState }) {
  const t = useT();
  const completion = props.completion;
  const blocked = completion.state === "open" && (completion.closing || completion.busy);
  return (
    <button
      type="button"
      className="quiet-control cap-seg solo"
      title={completionTitle(completion, t)}
      aria-label={completion.state === "open" ? t.chat.markTaskDone : t.chat.reopenTask}
      disabled={blocked}
      aria-disabled={blocked}
      onClick={() => (completion.state === "open" ? completion.onMark() : completion.onSet("open"))}
    >
      <Icon
        name={completion.state === "open" ? (completion.closing ? "loader-circle" : "check") : "rotate-ccw"}
        size={16}
        strokeWidth={2}
        spin={completion.closing}
      />
    </button>
  );
}

/** 收工键的悬停说明（同 ChatView 页头那套降级矩阵的文案口径） */
function completionTitle(
  completion: { state: SessionCompletion; closing: boolean; busy: boolean; scanless: boolean },
  t: Messages,
): string {
  if (completion.state !== "open") return t.chat.reopenTip;
  if (completion.closing) return t.chat.scanningTip;
  if (completion.busy) return t.chat.waitBeforeDone;
  if (completion.scanless) return t.chat.doneScanlessTip;
  return t.chat.doneTip;
}
