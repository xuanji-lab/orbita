/**
 * 批量迁移任务的弹窗：列出一个工作区里的任务（可勾选），选目标工作区，一次迁过去。
 * 入口是工作区组头的悬停动作；侧栏 Shift / ⌘ 多选是另一条更快的路，两条最终都走
 * session:move（归属与 cwd 一起换、子会话随行、在跑的跳过）。
 *
 * 弹窗走 portal 挂到 body：侧栏 aside 是 overflow:hidden，挂在里面 fixed 遮罩会被裁。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionMeta, SessionMoveResult } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { Menu, type MenuItem } from "./Menu";
import { useT } from "../locale.ts";

/** 目标是「无工作区」（回到 TASKS）时 Menu 项的 id——工作区 id 是 uuid，撞不上 */
const NO_WORKSPACE = "__tasks__";

export function MoveSessionsDialog(props: {
  source: Workspace;
  /** 这个工作区里列在侧栏上的任务（根会话、未归档） */
  sessions: readonly SessionMeta[];
  workspaces: readonly Workspace[];
  isRunning: (id: string) => boolean;
  onMove: (ids: readonly string[], workspaceId: string | null) => Promise<SessionMoveResult>;
  onClose: () => void;
}) {
  const t = useT();
  const targets = props.workspaces.filter((w) => w.id !== props.source.id);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [target, setTarget] = useState<string>(targets[0]?.id ?? NO_WORKSPACE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // 迁走的那些从列表里消失（父组件拿到新列表重渲染）：勾选集合只留还在的
  const present = props.sessions.filter((m) => checked.has(m.id)).map((m) => m.id);
  const selectable = props.sessions.filter((m) => !props.isRunning(m.id));
  const allChecked = selectable.length > 0 && selectable.every((m) => checked.has(m.id));

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, props]);

  const toggle = (id: string): void => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const targetName =
    target === NO_WORKSPACE
      ? t.sidebar.noWorkspaceTarget
      : (targets.find((w) => w.id === target)?.name ?? t.sidebar.noWorkspaceTarget);
  const targetItems: MenuItem[] = [
    ...targets.map((w): MenuItem => ({
      id: w.id,
      label: w.name,
      subLabel: w.path,
      subLabelEllipsis: "head",
      icon: "folder",
      checked: target === w.id,
      onSelect: () => setTarget(w.id),
    })),
    {
      id: NO_WORKSPACE,
      label: t.sidebar.noWorkspaceTarget,
      icon: "folder",
      checked: target === NO_WORKSPACE,
      onSelect: () => setTarget(NO_WORKSPACE),
    },
  ];

  const submit = async (): Promise<void> => {
    if (present.length === 0 || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await props.onMove(present, target === NO_WORKSPACE ? null : target);
      if (result.skipped.length === 0) {
        props.onClose();
        return;
      }
      // 没迁动的留着勾、把原因说出来；迁走的已从列表消失
      const running = result.skipped.filter((s) => s.reason === "running").length;
      setChecked(new Set(result.skipped.map((s) => s.id)));
      setMessage(t.sidebar.moveSkipped(running, result.skipped.length - running));
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="move-dialog-root">
      <div
        className="move-dialog-backdrop"
        onClick={(event) => {
          if (event.target === event.currentTarget && !busy) props.onClose();
        }}
      >
        <div className="move-dialog" role="dialog" aria-modal="true" aria-label={t.sidebar.moveDialogTitle(props.source.name)}>
          <div className="move-dialog-head">
            <strong>{t.sidebar.moveDialogTitle(props.source.name)}</strong>
            <IconButton label={t.common.close} size={24} onClick={props.onClose} style={{ marginInlineStart: "auto" }}>
              <Icon name="x" size={14} strokeWidth={2.2} />
            </IconButton>
          </div>

          <div className="move-dialog-body">
            {props.sessions.length === 0 ? (
              <span className="move-dialog-empty">{t.sidebar.moveNoTasks}</span>
            ) : (
              <>
                <label className="move-dialog-row move-dialog-all">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={selectable.length === 0}
                    onChange={() =>
                      setChecked(allChecked ? new Set() : new Set(selectable.map((m) => m.id)))
                    }
                  />
                  <span>{t.sidebar.moveSelectAll}</span>
                </label>
                <div className="move-dialog-list">
                  {props.sessions.map((meta) => {
                    const running = props.isRunning(meta.id);
                    return (
                      <label key={meta.id} className="move-dialog-row" data-disabled={running || undefined}>
                        <input
                          type="checkbox"
                          checked={checked.has(meta.id)}
                          disabled={running}
                          onChange={() => toggle(meta.id)}
                        />
                        <span className="move-dialog-title">{meta.title === "" ? t.common.newTask : meta.title}</span>
                        {running && (
                          <span className="row-trailing move-dialog-tag">
                            <Icon name="loader-circle" size={12} strokeWidth={1.8} />
                            {t.common.running}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="move-dialog-foot">
            <div className="move-dialog-target">
              <span>{t.sidebar.moveTarget}</span>
              <Menu
                items={targetItems}
                panelMinWidth={200}
                trigger={({ open, toggle: toggleMenu }) => (
                  <button type="button" className="move-dialog-picker" aria-expanded={open} onClick={toggleMenu}>
                    <Icon name="folder" size={13} strokeWidth={1.8} />
                    <span className="move-dialog-title">{targetName}</span>
                    <Icon name="chevron-down" size={13} strokeWidth={1.8} />
                  </button>
                )}
              />
            </div>
            <p className="move-dialog-note">{t.sidebar.moveNote}</p>
            {message !== null && (
              <p className="move-dialog-message" role="status">
                <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
                {message}
              </p>
            )}
            <div className="move-dialog-actions">
              <button type="button" className="move-dialog-cancel" onClick={props.onClose} disabled={busy}>
                {t.common.cancel}
              </button>
              <button
                type="button"
                className="btn-accent move-dialog-confirm"
                disabled={present.length === 0 || busy}
                onClick={() => void submit()}
              >
                {t.sidebar.moveConfirm(present.length)}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
