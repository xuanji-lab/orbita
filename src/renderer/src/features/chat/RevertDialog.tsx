import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { RevertPlan, UndoPlan } from "@shared/revert";
import { pathParts } from "./FileTurnCard";

/**
 * 回退 / 撤销的确认框 —— 「直接撤回，不整七七八八的。但一定要提醒用户」
 * （2026-11 用户裁决）：不拦截执行，把后果说全。
 *
 * 提醒分三档（设计系统「每个颜色只有一个职责」：红 = 失败，不是「注意」）：
 *   信息（最弱）：tertiary 文字、无底色——shell 不回退的说明、无法回退的清单。
 *   注意（中）：triangle-alert 图标 + primary 文字 + bg-muted 分组底——「你的修改
 *     也会一并撤回」「后续轮次也改过这些文件」。不用红也不用琥珀（琥珀 = 运行中）。
 *   危险（最强）：只给执行键（危险红字、hover danger-soft）与真正的失败报错。
 * 三档的样式常量集中在 CAUTION_* 一处——若设计系统将来立 caution token，这里
 * 一处替换。
 */

/** 注意档（中）：图标 + primary 文字；分组底用 bg-muted。 */
const CAUTION = {
  icon: "var(--color-text-primary)",
  text: "var(--color-text-primary)",
  groupBg: "var(--color-bg-muted)",
  label: "var(--color-text-secondary)",
} as const;

/** 清单里的一行路径：mono、可截断（目录淡、文件名亮）。tone 决定图标与文字。 */
function PathRow(props: { path: string; cwd: string | null; tone: "normal" | "caution" | "info" }) {
  // cwd 之内显示相对路径（与轮尾卡同一个 pathParts）：绝对路径把真正的文件名挤出视野
  const { name, dir } = pathParts(props.path, props.cwd);
  const color = props.tone === "caution" ? CAUTION.text : props.tone === "info" ? "var(--color-text-tertiary)" : "var(--color-text-primary)";
  const iconColor = props.tone === "caution" ? CAUTION.icon : "var(--color-text-tertiary)";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0, color }}>
      <span style={{ flex: "0 0 auto", color: iconColor }}>
        <Icon
          name={props.tone === "caution" ? "triangle-alert" : props.tone === "info" ? "info" : "file-text"}
          size={12}
          strokeWidth={1.8}
        />
      </span>
      <span style={{ minWidth: 0, display: "flex", gap: "var(--space-1)", flex: "1 1 auto" }}>
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{name}</span>
        {dir !== "" && (
          <span
            style={{
              minWidth: 0,
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
    </div>
  );
}

/** 一组文件（组标题 + 清单；空组不渲染）。caution 组带 bg-muted 分组底。 */
function PathGroup(props: {
  title: string;
  paths: readonly string[];
  cwd: string | null;
  note?: string;
  tone: "normal" | "caution" | "info";
}) {
  if (props.paths.length === 0) return null;
  const caution = props.tone === "caution";
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-1)",
        minWidth: 0,
        ...(caution ? { background: CAUTION.groupBg, borderRadius: "var(--radius-md)", padding: "var(--space-2) var(--space-3)" } : {}),
      }}
    >
      <div
        style={{
          fontSize: "var(--font-size-caption)",
          fontWeight: 600,
          color: caution ? CAUTION.label : "var(--color-text-secondary)",
        }}
      >
        {props.title}
      </div>
      {props.paths.map((path) => (
        <PathRow key={path} path={path} cwd={props.cwd} tone={props.tone} />
      ))}
      {props.note !== undefined && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--font-size-caption)",
            color: caution ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
          }}
        >
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
  // 破坏性确认的焦点给「取消」：回车只会按到焦点上的键，误触回车不会把文件冲掉。
  // 想执行就 Tab 到执行键或直接点（系统对话框同一纪律）
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // 不画焦点环：打开即聚焦是为了键盘路径（Tab / Esc），不是在提示「按这里」——
    // 程序聚焦画出的粗黑框被读成「默认选中」（实机）。键盘 Tab 过来照常有环
    cancelRef.current?.focus({ focusVisible: false } as FocusOptions);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onCancel();
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
          <span style={{ color: "var(--color-text-secondary)" }}>
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
            ref={cancelRef}
            type="button"
            className="quiet-control"
            onClick={props.onCancel}
            disabled={props.busy}
            style={{
              height: "var(--control-height-md)",
              padding: "0 var(--space-4)",
              // 与执行键同一个轮廓（发丝描边 + md 圆角）；不写 border 会落到 UA 默认的 2px outset 黑框（实机）
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              font: "inherit",
              fontSize: "var(--font-size-control)",
            }}
          >
            {t.common.cancel}
          </button>
          {/* 危险档（最强）只落在执行键上：红字 + 发丝描边 + hover danger-soft
              （设计系统「危险红字、hover --color-danger-soft」，不是实底红） */}
          <button
            type="button"
            className="revert-confirm"
            onClick={props.onConfirm}
            disabled={props.busy}
            style={{
              height: "var(--control-height-md)",
              padding: "0 var(--space-4)",
              border: "1px solid var(--color-danger)",
              borderRadius: "var(--radius-md)",
              background: "transparent",
              color: props.busy ? "var(--color-text-tertiary)" : "var(--color-danger)",
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
  cwd: string | null;
  plan: RevertPlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  // 注意组里的文件不在普通清单里重复出现：同一个路径列两遍，读的人会以为是两件事
  const flagged = new Set(props.plan.userModified);
  const restore = props.plan.restore.filter((path) => !flagged.has(path));
  const deletes = props.plan.deletes.filter((path) => !flagged.has(path));
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
        <PathGroup title={t.chat.revertWillRestore} paths={restore} cwd={props.cwd} tone="normal" />
        <PathGroup title={t.chat.revertWillDelete} paths={deletes} cwd={props.cwd} tone="normal" />
        <PathGroup
          title={t.chat.revertUserModified}
          paths={props.plan.userModified}
          cwd={props.cwd}
          tone="caution"
          note={t.chat.revertUserModifiedNote}
        />
        <PathGroup
          title={t.chat.revertUnrecoverable}
          paths={props.plan.unrecoverable}
          cwd={props.cwd}
          tone="info"
          note={t.chat.revertUnrecoverableNote}
        />
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {t.chat.revertShellNote}
        </p>
      </div>
    </DialogShell>
  );
}

/** 撤销确认框（清单来自主进程的 UndoPlan；多一组「后续轮次也改过」）。 */
export function UndoDialog(props: {
  cwd: string | null;
  plan: UndoPlan;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const flagged = new Set([...props.plan.userModified, ...props.plan.laterTouched]);
  const restore = props.plan.restore.filter((path) => !flagged.has(path));
  const deletes = props.plan.deletes.filter((path) => !flagged.has(path));
  // 同一文件既被手改又被后续轮改过：只进「你的修改」一组
  const laterTouched = props.plan.laterTouched.filter((path) => !props.plan.userModified.includes(path));
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
        <PathGroup title={t.chat.revertWillRestore} paths={restore} cwd={props.cwd} tone="normal" />
        <PathGroup title={t.chat.revertWillDelete} paths={deletes} cwd={props.cwd} tone="normal" />
        <PathGroup
          title={t.chat.revertUserModified}
          paths={props.plan.userModified}
          cwd={props.cwd}
          tone="caution"
          note={t.chat.revertUserModifiedNote}
        />
        <PathGroup
          title={t.chat.undoLaterTouched}
          paths={laterTouched}
          cwd={props.cwd}
          tone="caution"
          note={t.chat.undoLaterTouchedNote}
        />
        <PathGroup
          title={t.chat.revertUnrecoverable}
          paths={props.plan.unrecoverable}
          cwd={props.cwd}
          tone="info"
          note={t.chat.revertUnrecoverableNote}
        />
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {t.chat.revertShellNote}
        </p>
      </div>
    </DialogShell>
  );
}
