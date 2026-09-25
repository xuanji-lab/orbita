import { Icon } from "./Icon";

/**
 * 附图的回形针标：斜别在图片左上角、半露在图外，像回形针夹着一张照片。
 * 纯装饰（aria-hidden）——「这是用户附上的图」读屏从上下文就知道，不再念一遍。
 *
 * 只用 lucide 的 paperclip + token 颜色，**不画主题专属的印章**：同一个标在浅 / 暗 /
 * 纸面主题下都成立。底是 --color-bg-panel 的小圆片，压在任何图上都看得清。
 *
 * 父元素要 `position: relative` 且不裁切（overflow 不能是 hidden），否则半露的那一截会被切掉。
 */
export function PaperclipMark(props: { size: number }) {
  const box = props.size;
  return (
    <span
      aria-hidden="true"
      style={{
        position: "absolute",
        top: -Math.round(box * 0.35),
        left: -Math.round(box * 0.35),
        width: box,
        height: box,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-pill)",
        background: "var(--color-bg-panel)",
        border: "1px solid var(--color-border-subtle)",
        color: "var(--color-text-secondary)",
        // 斜一点才像别上去的；角度固定，不随机——同一张图每次渲染不该抖
        transform: "rotate(-35deg)",
        pointerEvents: "none",
        zIndex: 1,
      }}
    >
      <Icon name="paperclip" size={Math.round(box * 0.62)} strokeWidth={2} />
    </span>
  );
}
