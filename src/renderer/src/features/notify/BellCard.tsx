import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../locale.ts";
import { runStateLabel } from "./completion-notice.ts";

/** 卡片右缘与锚点（铃铛图标）左缘之间的空隙 */
const GAP = 8;
/** 卡片离窗口边的最小留白 */
const EDGE = 8;

/** 清单里的一行：竖条状态 + 会话名 + 工作区名（数据由 App 按 sessionRunState 算好） */
export interface NoticeRow {
  id: string;
  /** 会话标题；空串按「新任务」占位显示 */
  title: string;
  /** 所属工作区名；null = 不属于任何工作区（不显示副行） */
  workspace: string | null;
  /** 竖条状态（与侧栏行同一份推导） */
  state: "running" | "waiting" | "done" | "failed";
}

/**
 * 右下角铃铛弹出的清单（用户 2026-10-10）：所有竖条亮着的根会话——在等你、
 * 未读（跑完 / 跑挂没看）、在跑——每行最左边是同款三节竖条，点行在主槽打开
 * 那条会话（打开即已读）。
 *
 * **与侧栏竖条同一份状态**（sessionRunState 推导，App 组装好传进来），这里只是
 * 另一个入口：人在看别的会话时不用去左栏翻——整个 landscape 一眼扫完。这份
 * 清单以后也是家务活模型扫描「哪些会话有结果没看」的入口，所以未读落盘、
 * 重启后还在。
 *
 * 浮层配方同 CompletionCard（实色 `--color-bg-panel` + 发丝边 + popover 阴影）。
 * 铃铛在窗口最底部，卡片从锚点向左展开、底边对齐锚点，向上长。
 */
export function BellCard(props: {
  /** 定位锚点：铃铛图标。null = 还没挂载，先不画 */
  anchor: HTMLElement | null;
  /** 卡片根元素的 ref（外部关闭判定要用：卡片在 portal 里，父级查不到它） */
  cardRef: { current: HTMLDivElement | null };
  entries: readonly NoticeRow[];
  onOpen: (id: string) => void;
  /** 全部标为已读。null = 没有未读（角标为 0），按钮不出现 */
  onMarkAllRead: (() => void) | null;
}) {
  const t = useT();
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);
  const anchor = props.anchor;

  useLayoutEffect(() => {
    if (anchor === null) return;
    const place = (): void => {
      const rect = anchor.getBoundingClientRect();
      setPos({ bottom: window.innerHeight - rect.bottom, right: window.innerWidth - rect.left + GAP });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  if (anchor === null || pos === null) return null;
  return createPortal(
    <div
      ref={props.cardRef}
      className="bell-card"
      role="dialog"
      aria-label={t.bell.title}
      style={{ bottom: pos.bottom, right: pos.right, maxHeight: `calc(100vh - ${EDGE * 2}px)` }}
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
            <button
              key={row.id}
              type="button"
              className="bell-card-row"
              onClick={() => props.onOpen(row.id)}
              title={runStateLabel(row.state, t)}
            >
              {/* 同款三节竖条（styles.css 的 .status-bar，清单里是行内档不贴左缘） */}
              <span className="status-bar" data-fill={row.state} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="bell-card-names">
                <span className="bell-card-name">
                  {row.title === "" ? t.common.newTask : row.title}
                </span>
                {row.workspace !== null && <span className="bell-card-ws">{row.workspace}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * 铃铛弹层的外部关闭（Esc + 点卡片 / 铃铛之外）：卡片 portal 到 body，判定
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
