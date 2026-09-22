import { useEffect, useState } from "react";

/**
 * 就地改名。**三个消费者共用**：侧栏的工作区、侧栏的会话行、聊天页头的标题。
 *
 * 三条行为写死在这里，免得三处各写一遍又各写错一处：
 *  - **Enter 提交、Esc 放弃**——放弃是必须的，不然打错字只能提交了再改一次
 *  - **失焦即提交**：点到别处通常意味着"就这样"，而不是"算了"
 *  - 进入编辑即全选：改名多半是整个换掉，而不是在原名后面补几个字
 */
export function InlineName(props: {
  editing: boolean;
  value: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
  /** 不在编辑态时显示什么。新建场景永远是编辑态，可以不传 */
  children?: React.ReactNode;
  style?: React.CSSProperties;
  /** 编辑态的占位提示（新建场景：还没有值可显示） */
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(props.value);

  useEffect(() => {
    if (props.editing) setDraft(props.value);
  }, [props.editing, props.value]);

  if (!props.editing) return <>{props.children}</>;

  const commit = () => props.onCommit(draft);

  return (
    <input
      autoFocus
      value={draft}
      placeholder={props.placeholder}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation();
        // 中文输入法组包中的 Enter / Escape 是确认候选、取消组包，不是提交/放弃——
        // 不挡的话打拼音直接就把半截拼音提交成名字了
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
      style={{
        minWidth: 0,
        width: "100%",
        padding: "0 4px",
        border: 0,
        borderRadius: "var(--radius-xs)",
        background: "var(--color-bg-panel)",
        color: "var(--color-text-primary)",
        fontFamily: "var(--font-family-base)",
        outline: "none",
        boxShadow: "var(--focus-ring)",
        ...props.style,
      }}
    />
  );
}
