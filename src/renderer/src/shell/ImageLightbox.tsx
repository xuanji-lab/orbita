import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { originalRefOf, type PromptImage } from "@shared/prompt-images";
import { api } from "../api";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { imageSrc } from "./composer-images.ts";
import { lightboxKey } from "./lightbox-nav.ts";
import { useT } from "../locale.ts";

/**
 * 看大图：整窗遮罩，图按原比例放到窗口里放得下的最大（不放大超过原图，
 * 小图放大只会糊）。一组图时左右键 / 两侧按钮翻页，右上角「2 / 3」。
 *
 * 消费者三个：输入框里的待发缩略图、转录里用户发的图、MCP 工具产出的图——
 * 都是「内联只给得出 240px，看清要放大」的同一件事。
 *
 * **显示原图**：转录里的图块是缩到 2000px 的那份（模型看到的），带着 `original` 引用的就按引用
 * 读回原图展示——否则一张 5K 截图放大出来是糊的。原图到之前先显示缩放图，读不到（源会话
 * 已删、引用之前发的图）就一直是缩放图。输入框里的待发图本来就是原图，没有引用。
 *
 * 退出：Esc、点遮罩、右上角 ×。**Esc 在捕获阶段接住并截停**——App 在 window 上
 * 监听 Esc 关右栏，冒泡到那里就会连带把面板也关掉，一下 Esc 退两层。
 * 打开时焦点落到关闭键，关掉后还给打开前的元素（键盘用户回到原处）。
 */
export function ImageLightbox(props: {
  images: readonly PromptImage[];
  startIndex: number;
  onClose: () => void;
}) {
  const t = useT();
  const [index, setIndex] = useState(props.startIndex);
  const closeRef = useRef<HTMLButtonElement>(null);
  const count = props.images.length;
  const shown = props.images[Math.min(index, count - 1)];
  const { onClose } = props;
  // 引用 → 原图（null = 读不到，别再试）。随看随读：原图动辄几 MB，不在打开时把一组全拉过来
  const [originals, setOriginals] = useState<ReadonlyMap<string, PromptImage | null>>(new Map());
  const ref = shown === undefined ? null : originalRefOf(shown);
  useEffect(() => {
    if (ref === null || originals.has(ref)) return;
    let live = true;
    const settle = (value: PromptImage | null): void => {
      if (live) setOriginals((prev) => new Map(prev).set(ref, value));
    };
    void api.session.attachment(ref).then(settle, () => settle(null));
    return () => {
      live = false;
    };
  }, [ref, originals]);
  const image = (ref === null ? undefined : originals.get(ref)) ?? shown;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const action = lightboxKey(event.key, index, count);
      if (action === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === "close") onClose();
      else setIndex(action.index);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [index, count, onClose]);

  if (image === undefined) return null;
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t.lightbox.aria}
      // 只认点在遮罩本身：点图不关（用户可能只是想把视线落在某处）
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        // 与 IconButton 的 tooltip 同档：遮罩要盖住菜单（40）与面板
        zIndex: 70,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "var(--space-8)",
        background: "var(--overlay-backdrop)",
      }}
    >
      <img
        src={imageSrc(image)}
        alt=""
        draggable={false}
        style={{
          display: "block",
          maxWidth: "100%",
          maxHeight: "100%",
          objectFit: "contain",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-popover)",
          background: "var(--color-bg-muted)",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "var(--space-3)",
          right: "var(--space-3)",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
        }}
      >
        {count > 1 && (
          <span
            style={{
              padding: "2px var(--space-2)",
              borderRadius: "var(--radius-pill)",
              background: "var(--color-bg-panel)",
              color: "var(--color-text-secondary)",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-caption)",
            }}
          >
            {index + 1} / {count}
          </span>
        )}
        <button
          ref={closeRef}
          type="button"
          aria-label={t.common.close}
          title={t.common.close}
          onClick={onClose}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 32,
            height: 32,
            padding: 0,
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-pill)",
            background: "var(--color-bg-panel)",
            color: "var(--color-text-primary)",
            cursor: "pointer",
          }}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      {count > 1 && (
        <>
          <NavButton side="left" label={t.lightbox.prev} disabled={index === 0} onClick={() => setIndex(index - 1)} />
          <NavButton
            side="right"
            label={t.lightbox.next}
            disabled={index === count - 1}
            onClick={() => setIndex(index + 1)}
          />
        </>
      )}
    </div>,
    document.body,
  );
}

function NavButton(props: { side: "left" | "right"; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <IconButton
      label={props.label}
      variant="soft"
      size={36}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        position: "absolute",
        top: "50%",
        [props.side]: "var(--space-3)",
        transform: "translateY(-50%)",
        background: "var(--color-bg-panel)",
        borderRadius: "var(--radius-pill)",
      }}
    >
      <Icon name={props.side === "left" ? "chevron-left" : "chevron-right"} size={18} />
    </IconButton>
  );
}
