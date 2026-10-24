import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { InlineName } from "./InlineName";
import { useT } from "../locale.ts";
import type { Messages } from "../messages-en.ts";
import type { SessionCompletion } from "@shared/session";

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
  completion: {
    state: SessionCompletion;
    closing: boolean;
    busy: boolean;
    scanless: boolean;
    onMark: () => void;
    onSet: (next: "open" | "done") => void;
  } | null;
  /** 左端子会话芯片；null = 留空（用户默认：不放「0」占位，可推翻） */
  subChip: { count: number; waiting: number } | null;
  onOpenSubSessions?: () => void;
  /** 左端面包屑「↑ 父标题」（子会话被 Open as main 时才有）；与子会话芯片同一槽位 */
  crumb: { title: string; onClick: () => void } | null;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  /** 复制成功的对勾 + 轻提示（1.2s 淡出） */
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
  }, []);
  const copyId = (): void => {
    if (props.shortId === null) return;
    void navigator.clipboard.writeText(props.shortId);
    setCopied(true);
    if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1200);
  };
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
            <Icon name="git-fork" size={12} strokeWidth={1.8} />
            <b>{props.subChip.count}</b>
            {props.subChip.waiting > 0 && <span>· {t.chat.subSessionWaiting(props.subChip.waiting)}</span>}
          </button>
        ) : null}
      </div>

      {/* 正中：标题（重命名就地变输入框，外框不动）。左右各留一个铅笔位，悬停显形 */}
      <div className="cap-sc">
        <span className="cap-mini cap-hov" aria-hidden="true" />
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
      </div>

      {/* 右端：短 id · 复制（悬停）· 竖线 · 收工（一直显示） */}
      <div className="cap-sr">
        {props.shortId !== null && (
          <>
            <span className="cap-sid">{props.shortId}</span>
            <button
              type="button"
              className="quiet-control cap-mini cap-hov"
              title={copied ? t.toolbar.copiedId(props.shortId) : t.toolbar.copyId}
              aria-label={t.toolbar.copyId}
              onClick={copyId}
            >
              <Icon name={copied ? "check" : "copy"} size={13} strokeWidth={1.9} />
            </button>
          </>
        )}
        {completion !== null && (
          <>
            {props.shortId !== null && <span className="cap-vsep" />}
            <button
              type="button"
              className="quiet-control cap-seg solo"
              title={completionTitle(completion, t)}
              aria-label={completion.state === "open" ? t.chat.markTaskDone : t.chat.reopenTask}
              disabled={completion.state === "open" && (completion.closing || completion.busy)}
              aria-disabled={completion.state === "open" && (completion.closing || completion.busy)}
              onClick={() =>
                completion.state === "open" ? completion.onMark() : completion.onSet("open")
              }
            >
              <Icon
                name={completion.state === "open" ? (completion.closing ? "loader-circle" : "check") : "rotate-ccw"}
                size={16}
                strokeWidth={2}
                spin={completion.closing}
              />
            </button>
          </>
        )}
        {copied && props.shortId !== null && (
          <span className="cap-toast">
            <Icon name="check" size={12} strokeWidth={2.4} />
            {t.toolbar.copiedId(props.shortId)}
          </span>
        )}
      </div>
    </div>
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
