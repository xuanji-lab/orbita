import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { FileTurnView, RevertRecord } from "@shared/revert";
import { splitPathTail } from "./tool-results";

/**
 * 轮尾卡片家族 —— 每轮 assistant 结束后插在对话流的文件账（FileTurnRecord）与
 * 回退界碑的「还原卡」（RevertRecord）。同一个卡片配方（zcode 的改动卡参考）：
 * 头部一行（chevron + 「N 个文件已更改」 + +x −y + 撤销），展开是文件行。
 *
 * 卡片是**落盘事实的投影**（冷启动从 JSONL 重建，不依赖内存）——实时事件与盘上
 * 种子喂的是同一种记录。
 */

/** 路径的显示形：cwd 之内显示相对，之外显示绝对；再拆成 文件名（粗）+ 目录（淡）。 */
function pathParts(path: string, cwd: string | null): { name: string; dir: string } {
  const display =
    cwd !== null && cwd !== "" && (path === cwd || path.startsWith(`${cwd}/`) || path.startsWith(`${cwd}\\`))
      ? path.slice(cwd.length + 1)
      : path;
  const tail = splitPathTail(display.replaceAll("\\", "/"));
  return tail;
}

/** 一行增删统计（git stat 读法：+ 绿 − 红）。 */
function Stats(props: { added: number; removed: number }) {
  if (props.added === 0 && props.removed === 0) return null;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
      <span style={{ color: "var(--color-success)" }}>+{props.added}</span>{" "}
      <span style={{ color: "var(--color-danger)" }}>−{props.removed}</span>
    </span>
  );
}

const SLOT_DIR: React.CSSProperties = {
  fontSize: "var(--font-size-caption)",
  color: "var(--color-text-tertiary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  direction: "rtl",
  textAlign: "left",
};

/**
 * 轮尾文件账卡。头：chevron｜「N 个文件已更改」｜+x −y｜撤销；展开：每文件一行
 * （文件名粗 + 目录淡 + +N −M）。已撤销的轮：数字列表保留、加「已撤销」徽标、
 * 撤销按钮禁用（不做重新应用——重新应用等于重跑那轮，交给回退后重发）。
 */
export function FileTurnCard(props: {
  record: FileTurnView;
  cwd: string | null;
  undone: boolean;
  busy: boolean;
  onUndo: (turnId: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const added = props.record.changes.reduce((sum, change) => sum + change.added, 0);
  const removed = props.record.changes.reduce((sum, change) => sum + change.removed, 0);
  return (
    <div
      className="file-turn-card"
      style={{
        display: "grid",
        gap: open ? "var(--space-1)" : 0,
        padding: "var(--space-2) var(--space-3)",
        background: "var(--color-chat-card-bg)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        fontSize: "var(--font-size-caption)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        <button
          type="button"
          title={open ? t.chat.fileCardCollapse : t.chat.fileCardExpand}
          aria-label={open ? t.chat.fileCardCollapse : t.chat.fileCardExpand}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: 0,
            border: "none",
            background: "none",
            color: "var(--color-text-tertiary)",
            cursor: "pointer",
            transition: "transform var(--duration-fast) var(--ease-out-quint)",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          <Icon name="chevron-right" size={13} strokeWidth={1.8} />
        </button>
        <span style={{ color: "var(--color-text-secondary)", fontWeight: 600 }}>
          {t.chat.fileCardChanged(props.record.changes.length)}
        </span>
        <Stats added={added} removed={removed} />
        <span style={{ flex: 1 }} />
        {props.undone ? (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <Icon name="undo-2" size={11} strokeWidth={1.8} />
            {t.chat.fileCardUndone}
          </span>
        ) : (
          <button
            type="button"
            title={t.chat.fileCardUndo}
            aria-label={t.chat.fileCardUndo}
            disabled={props.busy}
            onClick={() => props.onUndo(props.record.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px var(--space-2)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-sm)",
              background: "transparent",
              color: props.busy ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
              font: "inherit",
              fontSize: "var(--font-size-caption)",
              cursor: props.busy ? "default" : "pointer",
            }}
          >
            <Icon name="undo-2" size={11} strokeWidth={1.8} />
            {t.chat.fileCardUndo}
          </button>
        )}
      </div>
      {open && (
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          {props.record.changes.map((change) => {
            const parts = pathParts(change.path, props.cwd);
            return (
              <div
                key={change.path}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}
              >
                <span style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}>
                  <Icon name="file-text" size={12} strokeWidth={1.8} />
                </span>
                <span style={{ minWidth: 0, display: "flex", gap: "var(--space-1)", flex: "1 1 auto" }}>
                  <span style={{ fontWeight: 600, color: "var(--color-text-primary)", whiteSpace: "nowrap" }}>
                    {parts.name}
                  </span>
                  {parts.dir !== "" && <span style={SLOT_DIR}>{parts.dir}</span>}
                </span>
                <Stats added={change.added} removed={change.removed} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 回退界碑：「已回退」一行 + 同款卡片的还原摘要（还原了 N 个文件 / 删除了 M 个）。
 * 卡与被撤轮次的卡一起消失的是对话；这里留的是回退发生过、以及盘被动过什么的凭据。
 */
export function RevertMarkView(props: { record: RevertRecord }) {
  const t = useT();
  const restored = props.record.restored.filter((entry) => entry.outcome === "restored").length;
  const deleted = props.record.restored.filter((entry) => entry.outcome === "deleted").length;
  const skipped = props.record.restored.filter((entry) => entry.outcome === "skipped").length;
  const parts = [
    restored > 0 ? t.chat.revertRestored(restored) : null,
    deleted > 0 ? t.chat.revertDeleted(deleted) : null,
    skipped > 0 ? t.chat.revertSkipped(skipped) : null,
  ].filter((part): part is string => part !== null);
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          fontSize: "var(--font-size-caption)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <span
          style={{
            width: 18,
            height: 1,
            background: "var(--color-border-subtle)",
            flex: "0 0 auto",
          }}
        />
        <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
        {t.chat.revertedHere}
      </div>
      {parts.length > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--color-chat-card-bg)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
            fontSize: "var(--font-size-caption)",
            color: "var(--color-text-secondary)",
          }}
        >
          <span style={{ color: "var(--color-text-tertiary)" }}>
            <Icon name="rotate-ccw" size={13} strokeWidth={1.8} />
          </span>
          {parts.join(" · ")}
        </div>
      )}
    </div>
  );
}
