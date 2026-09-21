import { useEffect, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import type { CarryoverDraft } from "./carryover-parse.ts";

/**
 * 收尾仪式的勾选清单弹层 —— 扫描成功后的确认面。
 *
 * 默认全选（模型扫出来的都值得带走，噪音由用户取消），title 可行内编辑
 * （模型的一句话事项偶尔啰嗦，编辑是最便宜的修剪），detail 是摘录，常显小字。
 * 确认（有勾选项）→ done_with_todos；全不勾 → done；取消是**两段式**——收尾的
 * 意愿已经表达了（点了 Mark done），一键退回让误触代价太高，但保留「Keep open」
 * 的出路。Esc 走与取消同一条两段式。
 */
export function CarryoverChecklist(props: {
  drafts: readonly CarryoverDraft[];
  onConfirm: (picked: readonly CarryoverDraft[]) => void;
  onCancel: () => void;
}) {
  /** 勾选态与 title 编辑都按草稿下标记——草稿没有 id，下标就是这份本地清单的身份 */
  const [checked, setChecked] = useState<readonly boolean[]>(() => props.drafts.map(() => true));
  /** 行内编辑中的下标；-1 = 都不在编辑 */
  const [editing, setEditing] = useState(-1);
  const [titles, setTitles] = useState<readonly string[]>(() => props.drafts.map((d) => d.title));
  /** 取消的两段式：第一下换文案，第二下才真的走 */
  const [cancelArmed, setCancelArmed] = useState(false);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // 打开即聚焦确认键：键盘用户 Enter 直接确认；Esc 两段式取消（见 onKeyDown）
  useEffect(() => {
    confirmRef.current?.focus();
    return () => undefined;
  }, []);

  const pickedCount = checked.filter(Boolean).length;

  const confirm = () => {
    props.onConfirm(
      props.drafts.filter((_, index) => checked[index] === true && (titles[index] ?? "").trim() !== ""),
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Wrap up this task"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || editing !== -1) return; // 编辑中的 Esc 先归编辑框
        if (cancelArmed) props.onCancel();
        else setCancelArmed(true);
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        display: "grid",
        placeItems: "center",
        padding: "var(--space-5)",
        background: "var(--overlay-backdrop)",
      }}
    >
      <div
        style={{
          width: "min(440px, 100%)",
          maxHeight: "min(480px, 100%)",
          display: "flex",
          flexDirection: "column",
          padding: "var(--space-5)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--color-border-subtle)",
          background: "var(--color-bg-panel)",
          boxShadow: "var(--shadow-modal)",
          color: "var(--color-text-primary)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Icon name="list-todo" size={16} style={{ color: "var(--color-text-secondary)" }} />
          <strong style={{ fontSize: "var(--font-size-body)", fontWeight: "var(--weight-bold)" }}>
            Wrap up this task
          </strong>
          <IconButton
            label="Close"
            size={24}
            onClick={() => (cancelArmed ? props.onCancel() : setCancelArmed(true))}
            style={{ marginInlineStart: "auto", color: "var(--color-text-tertiary)" }}
          >
            <Icon name="x" size={13} />
          </IconButton>
        </div>
        <p
          style={{
            margin: "var(--space-2) 0 var(--space-3)",
            fontSize: "var(--font-size-caption)",
            lineHeight: "var(--line-height-caption)",
            color: "var(--color-text-secondary)",
          }}
        >
          The agent scanned this task for loose ends. Uncheck what you don't want to carry over;
          titles can be edited in place.
        </p>

        <div
          className="scroll"
          style={{ minHeight: 0, display: "grid", gap: "var(--space-1)", margin: "0 calc(-1 * var(--space-2))" }}
        >
          {props.drafts.map((draft, index) => {
            const on = checked[index] === true;
            return (
              <div
                key={index}
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto minmax(0,1fr)",
                  gap: "var(--space-2)",
                  alignItems: "start",
                  padding: "var(--space-2)",
                  borderRadius: "var(--radius-sm)",
                  opacity: on ? 1 : 0.55,
                  transition: "opacity var(--duration-fast) var(--ease-standard)",
                }}
              >
                <input
                  type="checkbox"
                  checked={on}
                  aria-label={titles[index] ?? ""}
                  onChange={(event) =>
                    setChecked((prev) => prev.map((value, i) => (i === index ? event.target.checked : value)))
                  }
                  style={{ marginTop: 3, accentColor: "var(--color-accent)" }}
                />
                <div style={{ minWidth: 0 }}>
                  {editing === index ? (
                    <input
                      autoFocus
                      value={titles[index] ?? ""}
                      onChange={(event) =>
                        setTitles((prev) => prev.map((value, i) => (i === index ? event.target.value : value)))
                      }
                      onBlur={() => setEditing(-1)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") setEditing(-1);
                        if (event.key === "Escape") {
                          setTitles((prev) => prev.map((value, i) => (i === index ? props.drafts[index]?.title ?? value : value)));
                          setEditing(-1);
                        }
                      }}
                      style={{
                        width: "100%",
                        height: 22,
                        padding: "0 4px",
                        border: 0,
                        borderRadius: "var(--radius-xs)",
                        background: "var(--color-bg-muted)",
                        color: "var(--color-text-primary)",
                        fontFamily: "var(--font-family-base)",
                        fontSize: "var(--font-size-control)",
                        outline: "none",
                        boxShadow: "var(--focus-ring)",
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing(index)}
                      title="Click to edit"
                      style={{
                        display: "block",
                        width: "100%",
                        padding: 0,
                        border: 0,
                        background: "transparent",
                        textAlign: "left",
                        color: "var(--color-text-primary)",
                        fontFamily: "var(--font-family-base)",
                        fontSize: "var(--font-size-control)",
                        fontWeight: "var(--weight-medium)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        cursor: "text",
                      }}
                    >
                      {titles[index] ?? ""}
                    </button>
                  )}
                  {draft.detail !== "" && (
                    <p
                      title={draft.detail}
                      style={{
                        margin: "2px 0 0",
                        fontSize: "var(--font-size-micro)",
                        lineHeight: "var(--line-height-caption)",
                        color: "var(--color-text-tertiary)",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {draft.detail}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            marginTop: "var(--space-4)",
            paddingTop: "var(--space-3)",
            borderTop: "1px solid var(--color-border-subtle)",
          }}
        >
          {cancelArmed ? (
            <>
              <button
                type="button"
                onClick={props.onCancel}
                style={{
                  ...footerButtonStyle,
                  color: "var(--color-text-primary)",
                }}
              >
                Discard &amp; mark done
              </button>
              <button
                type="button"
                onClick={() => setCancelArmed(false)}
                style={{ ...footerButtonStyle, color: "var(--color-text-secondary)" }}
              >
                Keep open
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setCancelArmed(true)}
              style={{ ...footerButtonStyle, color: "var(--color-text-secondary)" }}
            >
              Cancel
            </button>
          )}
          <span style={{ flex: 1 }} />
          <button
            ref={confirmRef}
            type="button"
            onClick={confirm}
            style={{
              ...footerButtonStyle,
              background: "var(--color-accent)",
              color: "var(--color-accent-fg)",
              fontWeight: "var(--weight-semibold)",
            }}
          >
            {pickedCount > 0 ? `Keep ${pickedCount} & mark done` : "Mark done"}
          </button>
        </div>
      </div>
    </div>
  );
}

const footerButtonStyle: React.CSSProperties = {
  height: 28,
  padding: "0 12px",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-md)",
  background: "transparent",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-control)",
  cursor: "pointer",
  transition: "var(--transition-hover)",
};
