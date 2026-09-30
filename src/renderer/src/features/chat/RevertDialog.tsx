import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { RevertPlan, UndoPlan } from "@shared/revert";

/**
 * 回退 / 撤销的确认框 —— 「直接撤回，不整七七八八的。但一定要提醒用户」
 * （2026-11 用户裁决）：不拦截执行，把后果说全——
 *
 *   1. 将恢复 / 将删除（回退前不存在）的文件清单
 *   2. **警示组**（danger 色、单独一组）：你的修改也会一并撤回——磁盘当前内容 ≠
 *      快照记录的 agent 改完内容的文件；撤销第 N 轮时后续轮次也改过的同一文件
 *   3. 一句「shell 命令改过的文件不会回退」——bash 的改动不在快照账里，如实说明
 *
 * 落盘文件多时清单可滚（maxHeight + scroll），焦点进框即盯确认键——回退是
 * 破坏性动作，主按钮走 danger。
 */

/** 清单里的一行路径：mono、可截断（目录淡、文件名亮）。 */
function PathRow(props: { path: string; note?: string; danger?: boolean }) {
  const normalized = props.path.replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const dir = normalized.slice(0, normalized.length - name.length);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        minWidth: 0,
        color: props.danger === true ? "var(--color-danger)" : "var(--color-text-primary)",
      }}
    >
      <span style={{ flex: "0 0 auto" }}>
        <Icon name={props.danger === true ? "triangle-alert" : "file-text"} size={12} strokeWidth={1.8} />
      </span>
      <span style={{ minWidth: 0, display: "flex", gap: "var(--space-1)", flex: "1 1 auto" }}>
        <span style={{ fontFamily: "var(--font-family-mono)", whiteSpace: "nowrap" }}>{name}</span>
        {dir !== "" && (
          <span
            style={{
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "rtl",
              textAlign: "left",
            }}
          >
            {dir}
          </span>
        )}
      </span>
      {props.note !== undefined && (
        <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {props.note}
        </span>
      )}
    </div>
  );
}

/** 一组文件（组标题 + 清单；空组不渲染）。 */
function PathGroup(props: {
  title: string;
  paths: readonly string[];
  note?: string;
  danger?: boolean;
  noteOf?: (path: string) => string | undefined;
}) {
  if (props.paths.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <div
        style={{
          fontSize: "var(--font-size-micro)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontFamily: "var(--font-family-mono)",
          color: props.danger === true ? "var(--color-danger)" : "var(--color-text-tertiary)",
        }}
      >
        {props.title}
      </div>
      {props.paths.map((path) => (
        <PathRow key={path} path={path} danger={props.danger} note={props.noteOf?.(path)} />
      ))}
      {props.note !== undefined && (
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {props.note}
        </p>
      )}
    </div>
  );
}

/** 模态壳：实色面板（设计系统 Solid panels）+ 遮罩，Esc 关闭、Enter 确认。 */
function DialogShell(props: {
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onCancel();
      if (event.key === "Enter") {
        event.preventDefault();
        props.onConfirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={props.title}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-5)",
        background: "var(--overlay-backdrop)",
      }}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onCancel();
      }}
    >
      <div
        style={{
          width: "min(560px, 100%)",
          maxHeight: "min(72vh, 640px)",
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr) auto",
          background: "var(--color-bg-panel)",
          border: "1px solid var(--glass-border)",
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--shadow-modal)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-4) var(--space-5)",
            borderBottom: "1px solid var(--color-border-subtle)",
          }}
        >
          <span style={{ color: "var(--color-danger)" }}>
            <Icon name="rotate-ccw" size={16} strokeWidth={2} />
          </span>
          <span style={{ fontWeight: 650, fontSize: "var(--font-size-title)" }}>{props.title}</span>
        </header>
        <div
          className="scroll"
          style={{ minHeight: 0, overflow: "auto", padding: "var(--space-4) var(--space-5)" }}
        >
          {props.children}
        </div>
        <footer
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--space-2)",
            padding: "var(--space-3) var(--space-5)",
            borderTop: "1px solid var(--color-border-subtle)",
          }}
        >
          <button
            type="button"
            className="quiet-control"
            onClick={props.onCancel}
            disabled={props.busy}
            style={{ height: "var(--control-height-md)", padding: "0 var(--space-4)", cursor: "pointer", font: "inherit", fontSize: "var(--font-size-control)" }}
          >
            {t.common.cancel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={props.onConfirm}
            disabled={props.busy}
            style={{
              height: "var(--control-height-md)",
              padding: "0 var(--space-4)",
              border: 0,
              borderRadius: "var(--radius-md)",
              background: props.busy ? "var(--color-bg-hover)" : "var(--color-danger-solid)",
              color: props.busy ? "var(--color-text-tertiary)" : "var(--color-danger-fg)",
              font: "inherit",
              fontSize: "var(--font-size-control)",
              fontWeight: 500,
              cursor: props.busy ? "default" : "pointer",
            }}
          >
            {props.busy ? t.common.loading : props.confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** 回退确认框（清单来自主进程的 RevertPlan）。 */
export function RevertDialog(props: {
  plan: RevertPlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <DialogShell
      title={t.chat.revertTitle}
      confirmLabel={t.chat.revertConfirm}
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <div style={{ display: "grid", gap: "var(--space-4)" }}>
        <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>{t.chat.revertLead}</p>
        <PathGroup title={t.chat.revertWillRestore} paths={props.plan.restore} />
        <PathGroup title={t.chat.revertWillDelete} paths={props.plan.deletes} />
        <PathGroup title={t.chat.revertUserModified} paths={props.plan.userModified} danger note={t.chat.revertUserModifiedNote} />
        <PathGroup title={t.chat.revertUnrecoverable} paths={props.plan.unrecoverable} note={t.chat.revertUnrecoverableNote} />
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {t.chat.revertShellNote}
        </p>
      </div>
    </DialogShell>
  );
}

/** 撤销确认框（清单来自主进程的 UndoPlan；多一组「后续轮次也改过」）。 */
export function UndoDialog(props: {
  plan: UndoPlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <DialogShell
      title={t.chat.undoTitle}
      confirmLabel={t.chat.undoConfirm}
      busy={props.busy}
      onConfirm={props.onConfirm}
      onCancel={props.onCancel}
    >
      <div style={{ display: "grid", gap: "var(--space-4)" }}>
        <p style={{ margin: 0, color: "var(--color-text-secondary)" }}>{t.chat.undoLead}</p>
        <PathGroup title={t.chat.revertWillRestore} paths={props.plan.restore} />
        <PathGroup title={t.chat.revertWillDelete} paths={props.plan.deletes} />
        <PathGroup title={t.chat.revertUserModified} paths={props.plan.userModified} danger note={t.chat.revertUserModifiedNote} />
        <PathGroup title={t.chat.undoLaterTouched} paths={props.plan.laterTouched} danger note={t.chat.undoLaterTouchedNote} />
        <PathGroup title={t.chat.revertUnrecoverable} paths={props.plan.unrecoverable} note={t.chat.revertUnrecoverableNote} />
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {t.chat.revertShellNote}
        </p>
      </div>
    </DialogShell>
  );
}
