import { createContext, useState } from "react";
import { Icon } from "./Icon";
import { useT } from "../locale.ts";

/**
 * 文件引用与粘贴文本的 chip——输入框附件区与聊天流回显共用这两个形态：
 * 输入框里带移除键，发送后的转录里只读。样式取自附图缩略图的语言（同边框、
 * 同圆角、同底色），只是文件认不出内容，用图标与名字说话。
 */

/** 一个文件引用：图标区分文件 / 目录，名字省略号，title 挂完整路径 */
export function FileRefChip(props: {
  name: string;
  path: string;
  kind: "file" | "dir";
  onRemove?: () => void;
}) {
  const t = useT();
  return (
    <div
      title={props.path}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        minWidth: 0,
        maxWidth: 280,
        padding: "0 6px 0 8px",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-muted)",
      }}
    >
      <Icon
        name={props.kind === "dir" ? "folder" : "file"}
        size={13}
        strokeWidth={1.8}
        style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
      />
      <span
        style={{
          flex: "0 1 auto",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: "var(--font-size-caption)",
          color: "var(--color-text-primary)",
        }}
      >
        {props.name}
      </span>
      {props.onRemove !== undefined && (
        <button
          type="button"
          aria-label={t.composer.removeFile}
          title={t.composer.removeFile}
          onClick={props.onRemove}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            flex: "0 0 auto",
            padding: 0,
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-bg-panel)",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          }}
        >
          <Icon name="x" size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/**
 * 粘贴文本是否折叠成一行（设置 › collapsePastedText，缺席 = 折叠）。
 * 消费方是输入框的粘贴拦截（Composer）：关掉后大段粘贴不成块，直接进输入框。
 * App 根部提供一次，免得逐级透传。
 */
export const PastedTextCollapseContext = createContext(true);

/**
 * 一段粘贴文本：折叠成一行（「粘贴的文本 · N 行」）。**全文永不截断**，折叠只是
 * 显示形态。展开有两个去处：
 * - 输入框里（传了 onExpandIntoInput）：展开 = 把文本**移进输入框**——chip 移除，
 *   文本回到草稿里可编辑（wafo 2026-10-09：「折叠式 chip，展开要放进输入框中」）；
 * - 转录里（只读，没传）：就地展开全文（限高滚动），再点收起——那里没有输入框可去。
 */
export function PastedTextChip(props: {
  text: string;
  lines: number;
  onRemove?: () => void;
  /** 展开 = 移进输入框（输入框附件区传）；缺席 = 就地展开（转录回显） */
  onExpandIntoInput?: () => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const intoInput = props.onExpandIntoInput !== undefined;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        maxWidth: 480,
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-muted)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 28, padding: "0 6px 0 8px" }}>
        <button
          type="button"
          aria-expanded={intoInput ? undefined : expanded}
          title={
            intoInput
              ? t.composer.pastedExpandToInput
              : expanded
                ? t.composer.pastedCollapse
                : t.composer.pastedExpand
          }
          onClick={() =>
            intoInput ? props.onExpandIntoInput?.() : setExpanded((value) => !value)
          }
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: "0 1 auto",
            minWidth: 0,
            padding: 0,
            border: 0,
            background: "transparent",
            font: "inherit",
            cursor: "pointer",
            color: "var(--color-text-primary)",
          }}
        >
          <Icon
            name={intoInput ? "arrow-down" : expanded ? "chevron-down" : "chevron-right"}
            size={12}
            style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
          />
          <Icon name="file-text" size={13} strokeWidth={1.8} style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }} />
          <span
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "var(--font-size-caption)",
            }}
          >
            {t.composer.pastedTitle(props.lines)}
          </span>
        </button>
        {props.onRemove !== undefined && (
          <button
            type="button"
            aria-label={t.composer.removePasted}
            title={t.composer.removePasted}
            onClick={props.onRemove}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              flex: "0 0 auto",
              marginInlineStart: "auto",
              padding: 0,
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-pill)",
              background: "var(--color-bg-panel)",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={11} strokeWidth={2} />
          </button>
        )}
      </div>
      {expanded && (
        <div
          style={{
            maxHeight: 180,
            overflowY: "auto",
            margin: "0 8px 8px",
            padding: "6px 8px",
            borderTop: "1px solid var(--color-border-subtle)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-caption)",
            lineHeight: "var(--line-height-bubble)",
            color: "var(--color-text-secondary)",
          }}
        >
          {props.text}
        </div>
      )}
    </div>
  );
}
