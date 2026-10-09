import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { useT } from "../locale.ts";
import { useHoverTooltip } from "./useHoverTooltip.ts";
import { fileIcon, fileIconTone, FILETYPE_TONE_COLOR } from "../features/files/tree-view.ts";
import { DirMarkName } from "./DirMarkName.tsx";

/**
 * 文件引用与粘贴文本的 chip——输入框附件区与聊天流回显共用这两个形态：
 * 输入框里带移除键，发送后的转录里只读。样式取自附图缩略图的语言（同边框、
 * 同圆角、同底色），只是文件认不出内容，用图标与名字说话。
 */

/** 路径 tooltip 的延迟，与 IconButton / 输入框胶囊同值：太慢感知等于没有 */
const PATH_TOOLTIP_DELAY_MS = 200;

/**
 * 一个文件引用：图标 + 名字（目录带尾 `/`）+（输入框里的）移除键。
 * 图标与颜色和文件面板、输入框胶囊**同一份** fileIcon / fileIconTone（2026-10
 * 验收 J：三处长同一种形状，扫读不换脑筋）；目录沿用填实 folder。完整路径走
 * useHoverTooltip 快速 tooltip（与输入框胶囊同 200ms），不再挂原生 title。
 */
export function FileRefChip(props: {
  name: string;
  path: string;
  kind: "file" | "dir";
  onRemove?: () => void;
}) {
  const t = useT();
  const isDir = props.kind === "dir";
  const tone = isDir ? null : fileIconTone(props.name, "file");
  const tooltip = useHoverTooltip<HTMLDivElement>(PATH_TOOLTIP_DELAY_MS, true);
  return (
    <>
      <div
        className="file-ref-chip"
        ref={tooltip.anchorRef}
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
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
          name={isDir ? "folder" : fileIcon(props.name, "file")}
          size={13}
          strokeWidth={1.8}
          fill={isDir}
          style={{
            color: isDir
              ? "var(--color-text-secondary)"
              : tone === null
                ? "var(--color-text-tertiary)"
                : FILETYPE_TONE_COLOR[tone],
            flex: "0 0 auto",
          }}
        />
        <DirMarkName
          name={props.name}
          dir={isDir}
          wrapStyle={{ flex: "0 1 auto" }}
          nameStyle={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-primary)" }}
        />
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
      {tooltip.open &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            role="tooltip"
            className="material-path-tip"
            data-placed={tooltip.placement !== null}
            style={{ top: tooltip.placement?.top ?? 0, left: tooltip.placement?.left ?? 0 }}
          >
            <div>{props.path}</div>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 一段粘贴文本：折叠成一行（「粘贴的文本 · N 行」），点开展开全文（限高滚动），
 * 再点收起——**全文永不截断**，折叠只是显示形态。展开态收在 chip 内部：
 * 粘贴的是要紧内容，展开时不该把它推到视线之外。
 */
export function PastedTextChip(props: { text: string; lines: number; onRemove?: () => void }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
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
          aria-expanded={expanded}
          title={expanded ? t.composer.pastedCollapse : t.composer.pastedExpand}
          onClick={() => setExpanded((value) => !value)}
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
            name={expanded ? "chevron-down" : "chevron-right"}
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
