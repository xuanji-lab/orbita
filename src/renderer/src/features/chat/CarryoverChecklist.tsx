import { useMemo, useState } from "react";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import type { CarryoverDraft } from "./carryover-parse.ts";
import { useT } from "../../locale.ts";

/**
 * 收尾仪式的确认卡 —— 扫描成功后的确认面，inline 浮层挂在 composer 上方。
 *
 * 2026-09-22 从 modal 改成与 ApprovalBar 同位的浮层：先试过 Proma AskUserBanner
 * 的形态（替换掉 composer），用户明确否决——确认卡不该把输入面藏起来，用户
 * 可能还想补一句话再收尾。同位同配方（玻璃 + popover 阴影）表达同一层级语义：
 * 「比聊天面高一层，要求一个回答才继续」，但不再霸屏。
 *
 * 默认全选（模型扫出来的都值得带走，噪音由用户取消），title 可行内编辑
 * （模型的一句话事项偶尔啰嗦，编辑是最便宜的修剪；hover 浮出铅笔提示可编辑），
 * detail 是摘录，常显小字。输入行可自由追加条目（与扫描项同待遇：可取消勾选、
 * 可编辑），确认时并入 picked。
 * 确认（有勾选项）→ done_with_todos；全不勾 → done；取消是**两段式**——收尾的
 * 意愿已经表达了（点了 Mark done），一键退回让误触代价太高，但保留「Keep open」
 * 的出路。Esc 走同一条两段式，且只在焦点已在卡内时触发——inline 卡不劫持键盘
 * （modal 时代「打开即聚焦确认键」随之取消，用户可能正在 composer 打字）。
 */
export function CarryoverChecklist(props: {
  drafts: readonly CarryoverDraft[];
  onConfirm: (picked: readonly CarryoverDraft[]) => void;
  onCancel: () => void;
}) {
  const t = useT();
  /** 用户新加的条目：与扫描项同待遇（可勾选、可编辑），确认时并入 picked */
  const [extraDrafts, setExtraDrafts] = useState<readonly CarryoverDraft[]>([]);
  /** 勾选态与 title 编辑都按合并列表的下标记——下标就是这份本地清单的身份 */
  const [checked, setChecked] = useState<readonly boolean[]>(() => props.drafts.map(() => true));
  /** 行内编辑中的下标；-1 = 都不在编辑 */
  const [editing, setEditing] = useState(-1);
  const [titles, setTitles] = useState<readonly string[]>(() => props.drafts.map((d) => d.title));
  /** 取消的两段式：第一下换文案，第二下才真的走 */
  const [cancelArmed, setCancelArmed] = useState(false);
  /** 自由输入行的草稿；Enter 或加号追加，空输入不加 */
  const [draft, setDraft] = useState("");

  const allDrafts = useMemo<readonly CarryoverDraft[]>(
    () => [...props.drafts, ...extraDrafts],
    [props.drafts, extraDrafts],
  );

  const pickedCount = checked.filter(Boolean).length;

  const confirm = () => {
    props.onConfirm(
      allDrafts.filter((_, index) => checked[index] === true && (titles[index] ?? "").trim() !== ""),
    );
  };

  const addItem = () => {
    const title = draft.trim();
    if (title === "") return;
    setExtraDrafts((prev) => [...prev, { title, detail: "" }]);
    setChecked((prev) => [...prev, true]);
    setTitles((prev) => [...prev, title]);
    setDraft("");
  };

  return (
    <section
      role="region"
      aria-label={t.carryover.wrapUp}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || editing !== -1) return; // 编辑中的 Esc 先归编辑框
        if (cancelArmed) props.onCancel();
        else setCancelArmed(true);
      }}
      // 与 ApprovalBar 同级：它是当前唯一挡路的东西，但不遮消息流与 composer
      className="glass-card glass-float"
      style={{
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        color: "var(--color-text-primary)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Icon name="list-todo" size={16} style={{ color: "var(--color-text-secondary)" }} />
        <strong style={{ fontSize: "var(--font-size-body)", fontWeight: "var(--weight-bold)" }}>
          {t.carryover.wrapUp}
        </strong>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: "var(--font-size-caption)",
          lineHeight: "var(--line-height-caption)",
          color: "var(--color-text-secondary)",
        }}
      >
        {t.carryover.intro}
      </p>

      <div
        className="scroll"
        style={{
          minHeight: 0,
          maxHeight: 240,
          display: "grid",
          gap: "var(--space-1)",
          alignContent: "start",
        }}
      >
        {allDrafts.map((item, index) => {
          const on = checked[index] === true;
          return (
            <div
              key={index}
              className="carryover-row"
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
                        setTitles((prev) =>
                          prev.map((value, i) => (i === index ? allDrafts[index]?.title ?? value : value)),
                        );
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
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", minWidth: 0 }}>
                    <button
                      type="button"
                      onClick={() => setEditing(index)}
                      title={t.carryover.clickToEdit}
                      style={{
                        display: "block",
                        flex: 1,
                        minWidth: 0,
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
                    {/* 可编辑的发现性提示：hover 时行尾浮出铅笔（modal 时代没有这个提示，
                        改成 inline 卡后不再有「点开看详情」的暗示，只能靠 hover 说出来）。
                        恒渲染 + CSS 控制显示——用 display 而不是 opacity/visibility，
                        免得静止态被快照工具当成占位的可见元素 */}
                    <span
                      aria-hidden
                      className="carryover-pencil"
                      style={{
                        flex: "0 0 auto",
                        color: "var(--color-text-tertiary)",
                      }}
                    >
                      <Icon name="pencil-line" size={12} />
                    </span>
                  </div>
                )}
                {item.detail !== "" && (
                  <p
                    title={item.detail}
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
                    {item.detail}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 自由输入行：扫描会漏（模型只扫得出它记得的），用户自己最清楚还欠什么 */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <input
          value={draft}
          placeholder={t.carryover.addOwnPlaceholder}
          aria-label={t.carryover.addOwn}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              addItem();
            }
          }}
          style={{
            flex: 1,
            minWidth: 0,
            height: 28,
            padding: "0 var(--space-3)",
            border: 0,
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-muted)",
            color: "var(--color-text-primary)",
            fontFamily: "var(--font-family-base)",
            fontSize: "var(--font-size-control)",
            outline: "none",
            boxShadow: "var(--focus-ring)",
          }}
        />
        <IconButton label={t.carryover.addItem} size={28} onClick={addItem}>
          <Icon name="plus" size={14} />
        </IconButton>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          paddingTop: "var(--space-1)",
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
              {t.carryover.discardAndDone}
            </button>
            <button
              type="button"
              onClick={() => setCancelArmed(false)}
              style={{ ...footerButtonStyle, color: "var(--color-text-secondary)" }}
            >
              {t.carryover.keepOpen}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setCancelArmed(true)}
            style={{ ...footerButtonStyle, color: "var(--color-text-secondary)" }}
          >
            {t.common.cancel}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={confirm}
          style={{
            ...footerButtonStyle,
            background: "var(--color-accent)",
            color: "var(--color-accent-fg)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          {t.carryover.keepAndDone(pickedCount)}
        </button>
      </div>
    </section>
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
