import { Icon } from "./Icon";
import { PaperclipMark } from "./PaperclipMark";

/**
 * 附图序号角标：缩略图左下角的小圆片，数字就是正文里「图 N」小签的 N（shared/prompt-image-refs.ts）。
 * 输入框的缩略图与已发送气泡上方的缩略图共用——父元素要 `position: relative`。
 * 放左下角：左上是回形针、右上是移除键，三个角各管一件事。
 */
export function ImageIndexBadge(props: { n: number }) {
  return (
    <span
      aria-hidden="true"
      className="image-index-badge"
      style={{
        position: "absolute",
        left: 4,
        bottom: 4,
        minWidth: 18,
        height: 18,
        padding: "0 var(--space-1)",
        boxSizing: "border-box",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-pill)",
        background: "var(--color-bg-panel)",
        border: "1px solid var(--color-border-subtle)",
        color: "var(--color-text-primary)",
        fontSize: "var(--font-size-xs)",
        fontWeight: 600,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
        pointerEvents: "none",
      }}
    >
      {props.n}
    </span>
  );
}

/**
 * 图片缩略卡：composer 待发附图与模型输出画廊（show_image）共用同一张卡。
 * 方形裁切（object-fit: cover）只为排得齐——点开看原图。文件名单行省略：
 * 名字长短不一时换行行数不同，整排卡片就会参差。
 *
 * 缩略图与移除键是兄弟不是嵌套：button 里不能再套 button。移除键常显而不是
 * 悬停才出：键盘用户要能 Tab 到它。回形针只给用户附上的图——模型输出的图不是附件。
 * 外层不裁切：回形针要半露在缩略图外面；裁切放在里面的按钮上。
 */
export function ImageThumb(props: {
  src: string;
  name: string;
  size: number;
  openLabel: string;
  onOpen: () => void;
  paperclip?: boolean;
  /** 序号角标（附图的「图 N」）。不给 = 没有编号（模型输出的画廊） */
  index?: number;
  caption?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  const named = props.name !== "";
  return (
    <div
      title={named ? props.name : undefined}
      style={{ width: props.size, flex: "0 0 auto", display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}
    >
      <div style={{ position: "relative", width: props.size, height: props.size }}>
        {props.paperclip === true && <PaperclipMark size={Math.max(18, Math.round(props.size / 4))} />}
        <button
          type="button"
          aria-label={props.openLabel}
          onClick={props.onOpen}
          style={{
            display: "block",
            width: "100%",
            height: "100%",
            padding: 0,
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--color-border-subtle)",
            overflow: "hidden",
            background: "var(--color-bg-muted)",
            cursor: "zoom-in",
          }}
        >
          <img
            src={props.src}
            alt={props.name}
            draggable={false}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        </button>
        {props.index !== undefined && <ImageIndexBadge n={props.index} />}
        {props.onRemove !== undefined && (
          <button
            type="button"
            aria-label={props.removeLabel}
            title={props.removeLabel}
            onClick={props.onRemove}
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 20,
              height: 20,
              padding: 0,
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-pill)",
              background: "var(--color-bg-panel)",
              color: "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            <Icon name="x" size={12} strokeWidth={2} />
          </button>
        )}
      </div>
      {props.caption === true && named && (
        <span
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-family-mono)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {props.name}
        </span>
      )}
    </div>
  );
}
