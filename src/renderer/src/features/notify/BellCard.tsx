import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../locale.ts";
import { runStateLabel } from "./completion-notice.ts";
import { StatusPie } from "../../shell/StatusPie";

/** 清单里的一行：状态饼状态 + 会话名 + 工作区名（数据由 App 按 sessionRunState 算好） */
export interface NoticeRow {
  id: string;
  /** 会话标题；空串按「新任务」占位显示 */
  title: string;
  /** 所属工作区名；null = 不属于任何工作区（不显示副行） */
  workspace: string | null;
  /** 状态饼状态（与侧栏行同一份推导） */
  state: "running" | "waiting" | "done" | "failed";
}

/**
 * 右下角铃铛弹出的清单（用户 2026-10-10）：所有状态饼亮着的根会话——在等你、
 * 未读（跑完 / 跑挂没看）、在跑——每行最左边是同款状态饼，点行在主槽打开
 * 那条会话（打开即已读）。
 *
 * **与侧栏状态饼同一份状态**（sessionRunState 推导，App 组装好传进来），这里只是
 * 另一个入口：人在看别的会话时不用去左栏翻——整个 landscape 一眼扫完。这份
 * 清单以后也是家务活模型扫描「哪些会话有结果没看」的入口，所以未读落盘、
 * 重启后还在。
 *
 * 层级与血线同 CompletionCard：弹在主槽的右下角（铃铛在右栏底部，卡片就在它
 * 最近的那个角），守 ChatView 的血线（styles.css 的 `.pane-pop`），向上长。
 */
export function BellCard(props: {
  /** 弹出宿主（主槽里的 `.pane-pop-host`）。null = 还没挂载，先不画 */
  host: HTMLElement | null;
  /** 卡片根元素的 ref（外部关闭判定要用：卡片在 portal 里，父级查不到它） */
  cardRef: { current: HTMLDivElement | null };
  entries: readonly NoticeRow[];
  onOpen: (id: string) => void;
  /** 在辅助对话里打开（主槽不动） */
  onSideChat: (id: string) => void;
  /** 全部标为已读。null = 没有未读（角标为 0），按钮不出现 */
  onMarkAllRead: (() => void) | null;
}) {
  const t = useT();
  if (props.host === null) return null;
  return createPortal(
    <div
      ref={props.cardRef}
      className="pane-pop bell-card"
      role="dialog"
      aria-label={t.bell.title}
    >
      <div className="bell-card-head">
        <span className="bell-card-title">{t.bell.title}</span>
        {props.onMarkAllRead !== null && (
          <button type="button" className="quiet-control bell-card-mark" onClick={props.onMarkAllRead}>
            {t.bell.markAllRead}
          </button>
        )}
      </div>
      {props.entries.length === 0 ? (
        <div className="bell-card-empty">{t.bell.empty}</div>
      ) : (
        <div className="bell-card-list">
          {props.entries.map((row) => (
            // 一行两种看法（用户 2026-10-12）：「打开」= 主槽换成它；「辅助对话」= 右侧停靠里开，
            // 当前对话不动。动作悬停 / 聚焦时浮出、盖住工作区名，不占位（行尾血线规矩）。
            // 再点一次铃铛关清单，所以没有 ×
            <div key={row.id} className="bell-card-row" title={runStateLabel(row.state, t)}>
              <StatusPie state={row.state} />
              <span className="bell-card-name">{row.title === "" ? t.common.newTask : row.title}</span>
              {row.workspace !== null && <span className="bell-card-ws row-trailing">{row.workspace}</span>}
              <span className="bell-card-actions">
                <button type="button" className="completion-card-link" data-primary title={t.notice.openNowTip} onClick={() => props.onOpen(row.id)}>
                  {t.notice.openNow}
                </button>
                <span className="completion-card-dot" aria-hidden="true">·</span>
                <button type="button" className="completion-card-link" title={t.notice.sideChatTip} onClick={() => props.onSideChat(row.id)}>
                  {t.notice.sideChat}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>,
    props.host,
  );
}

/**
 * 铃铛弹层的外部关闭（Esc + 点卡片 / 铃铛之外）：卡片 portal 在主槽里、铃铛在右栏，判定
 * 「点的是不是自己」只能靠传入的卡片 ref 与锚点 ref。
 */
export function useBellDismiss(
  open: boolean,
  onClose: () => void,
  anchor: HTMLElement | null,
  cardRef: { current: HTMLDivElement | null },
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cardRef.current?.contains(target) === true) return;
      if (anchor !== null && anchor.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose, anchor, cardRef]);
}
