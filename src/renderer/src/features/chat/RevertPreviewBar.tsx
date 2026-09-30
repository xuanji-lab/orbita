import { useEffect, useRef } from "react";
import { Icon, type IconName } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { RevertPlan, UndoPlan } from "@shared/revert";
import { chipsOf, type ChipItem } from "./revert-preview.ts";
import { pathParts } from "./FileTurnCard";

/**
 * 回退 / 撤销的预览模式（用户 2026-10-01 在四种形态里选了 D）。
 *
 * 不再弹遮罩弹窗——orbita 的确认一直是就地的（MCP 移除、技能清理、压缩确认），
 * 遮罩弹窗是唯一的例外，用户读着累也不习惯。改成「先预演」：
 *   - 回退：对话流里要撤掉的部分变淡加删除线、切线标出位置（TranscriptColumn 做）；
 *   - 撤销：那一轮的轮尾卡描边高亮（FileTurnCard 读 RevertPreviewContext）；
 *   - 底部一条确认栏（本组件，与审批条 / 收尾清单同位同配方）：一句结论 +
 *     每个文件一枚胶囊（名字 + 一个词的后果）+ 取消 / 执行。
 *
 * 「直接撤回，但一定要提醒用户」：你改过的文件照样还原，但结论句先说「其中 M 个你改过」，
 * 胶囊带警示三角。提醒三档：信息 = tertiary 文字；注意 = triangle-alert + primary 文字
 * （不用红也不用琥珀，琥珀 = 运行中）；危险 = 只给执行键（红字 + 红描边）。
 * 解释性长句进胶囊的 tooltip，栏上不放段落。
 */

function Chip(props: { item: ChipItem; cwd: string | null; onOpen?: (path: string) => void }) {
  const t = useT();
  const { name } = pathParts(props.item.path, props.cwd);
  const caution = props.item.effect === "yours" || props.item.effect === "later";
  const icon: IconName | null = caution ? "triangle-alert" : props.item.effect === "stuck" ? "info" : null;
  const clickable = props.onOpen !== undefined && props.item.effect !== "stuck";
  return (
    <button
      type="button"
      title={`${props.item.path}\n${t.chat.previewEffectHint(props.item.effect)}`}
      disabled={!clickable}
      onClick={() => props.onOpen?.(props.item.path)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: "100%",
        padding: "1px var(--space-2)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-pill)",
        background: caution ? "var(--color-bg-muted)" : "transparent",
        font: "inherit",
        fontSize: "var(--font-size-caption)",
        color: "var(--color-text-primary)",
        cursor: clickable ? "pointer" : "default",
      }}
    >
      {icon !== null && (
        <span style={{ display: "inline-flex", color: caution ? "var(--color-text-primary)" : "var(--color-text-tertiary)" }}>
          <Icon name={icon} size={11} strokeWidth={1.9} />
        </span>
      )}
      <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
        {name}
      </span>
      <span style={{ color: caution ? "var(--color-text-secondary)" : "var(--color-text-tertiary)", whiteSpace: "nowrap" }}>
        {t.chat.previewEffect(props.item.effect)}
      </span>
    </button>
  );
}

/** 底部确认栏。Esc 取消；焦点给「取消」（回车不会按到破坏性执行键）。 */
export function RevertPreviewBar(props: {
  mode: "revert" | "undo";
  plan: RevertPlan | UndoPlan;
  cwd: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** 点胶囊 → 审查面板定位该文件 */
  onOpenFile?: (path: string) => void;
}) {
  const t = useT();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // 不画程序焦点环：聚焦是为键盘路径，不是在提示「按这里」
    cancelRef.current?.focus({ focusVisible: false } as FocusOptions);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chips = chipsOf(props.plan);
  const moving = chips.filter((chip) => chip.effect !== "stuck").length;
  const yours = chips.filter((chip) => chip.effect === "yours" || chip.effect === "later").length;
  return (
    <section
      role="region"
      aria-label={props.mode === "revert" ? t.chat.revertTitle : t.chat.undoTitle}
      className="glass-card glass-float"
      style={{ display: "grid", gap: "var(--space-2)", padding: "var(--space-3) var(--space-4)", color: "var(--color-text-primary)" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ display: "inline-flex", color: "var(--color-text-secondary)" }}>
          <Icon name={props.mode === "revert" ? "rotate-ccw" : "undo-2"} size={15} strokeWidth={1.9} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>
          {props.mode === "revert" ? t.chat.previewRevertLead(moving, yours) : t.chat.previewUndoLead(moving, yours)}
        </span>
      </div>
      {chips.length > 0 && (
        <div className="scroll" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)", maxHeight: 96, overflow: "auto" }}>
          {chips.map((chip) => (
            <Chip key={chip.path} item={chip} cwd={props.cwd} onOpen={props.onOpenFile} />
          ))}
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <span style={{ flex: 1, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {t.chat.revertShellNote}
        </span>
        <button
          ref={cancelRef}
          type="button"
          className="quiet-control"
          onClick={props.onCancel}
          disabled={props.busy}
          style={{
            height: "var(--control-height-md)",
            padding: "0 var(--space-3)",
            border: 0,
            borderRadius: "var(--radius-md)",
            cursor: "pointer",
            font: "inherit",
            fontSize: "var(--font-size-control)",
          }}
        >
          {t.common.cancel}
        </button>
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
          {props.busy ? t.common.loading : props.mode === "revert" ? t.chat.revertConfirm : t.chat.undoConfirm}
        </button>
      </div>
    </section>
  );
}
