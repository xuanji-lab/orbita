import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { FEATURE_ICON } from "./feature-icons.ts";
import { waitingSummary } from "../features/chat/sub-sessions-rows.ts";
import { InlineName } from "./InlineName";
import { useT } from "../locale.ts";

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
  /** 标题后面的一个灰字身份（主智能体）；undefined = 不摆 */
  tag?: string | undefined;
  /** 身份做成可点的（主智能体：点开定型号与思考档）时，整个换成调用方给的件；给了它 tag 只用来定标题居中 */
  tagSlot?: React.ReactNode;
  /** 短 id（前 6 位）；null = 会话还没落盘（首条消息未发），右端次要件不摆 */
  shortId: string | null;
  onRename?: (title: string) => void;
  /** 左端子会话芯片；null = 留空（用户默认：不放「0」占位，可推翻） */
  /** interrupted：等你的子会话里被崩溃打断、等你点「继续」的个数（芯片与右栏列表标题同一套说法，见 waitingSummary） */
  subChip: { count: number; waiting: number; interrupted: number } | null;
  onOpenSubSessions?: () => void;
  /** 左端面包屑「↑ 父标题」（子会话被 Open as main 时才有）；与子会话芯片同一槽位 */
  crumb: { title: string; onClick: () => void } | null;
}) {
  const t = useT();

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
              [
                t.chat.subSessionCount(props.subChip.count),
                waitingSummary(props.subChip.waiting, props.subChip.interrupted, { interrupted: t.chat.subSessionInterrupted, waiting: t.chat.subSessionWaiting }),
              ]
                .filter((part) => part !== "")
                .join(" · ")
            }
          >
            <Icon name={FEATURE_ICON.subsessions} size={12} strokeWidth={1.8} />
            <b>{props.subChip.count}</b>
            {props.subChip.waiting > 0 && (
              <span>
                ·{" "}
                {waitingSummary(props.subChip.waiting, props.subChip.interrupted, { interrupted: t.chat.subSessionInterruptedShort, waiting: t.chat.subSessionWaiting })}
              </span>
            )}
          </button>
        ) : null}
      </div>

      {/* 正中：标题（重命名就地变输入框，外框不动）。左右各留一个铅笔位，悬停显形 */}
      <div className="cap-sc">
        <CapTitle title={props.title} onRename={props.onRename} balance={props.tag === undefined} />
        {props.tag !== undefined && props.tagSlot !== undefined && props.tagSlot}
        {props.tag !== undefined && props.tagSlot === undefined && (
          <span style={{ flex: "none", fontSize: "var(--font-size-sm)", color: "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
            {props.tag}
          </span>
        )}
      </div>

      {/* 右端：短 id · 复制（悬停）。原来的「收工」键 2026-11-17 去掉（手动标完成是伪需求，用户裁决） */}
      <div className="cap-sr">
        <CapSessionId shortId={props.shortId} />
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
