import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { placeMenu } from "./menu-position";
import type { MenuItem } from "./Menu";

/**
 * 右键菜单——Menu（锚定触发器的下拉）的「指针坐标」孪生：受控打开，位置就是
 * 右键那一刻的视口坐标。样式、键盘导航、关闭规则与 Menu 同一套（menu-panel /
 * option-row / Esc / 点外关），只少触发器与悬停逻辑——右键本身就是触发器。
 *
 * 目前唯一的消费者是 FilesPanel 的会话根分组头（「添加文件引用」）；条目行的
 * 右键已随菜单裁撤移除（aab082b），行尾 hover 按钮接管了高频动作。
 */
export function ContextMenu(props: {
  /** 打开位置（视口坐标，pointer 事件的 clientX/clientY）。null = 关闭 */
  position: { x: number; y: number } | null;
  items: MenuItem[];
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const open = props.position !== null;

  // 每次打开光标回到第一项（右键菜单没有「当前项」的概念）
  useEffect(() => {
    if (open) setActive(0);
  }, [open, props.position?.x, props.position?.y]);

  // 先按旧位置渲染但不可见，量到真实高度之后再定位——与 Menu 同一拍，免得闪一下
  useLayoutEffect(() => {
    if (props.position === null) {
      setPosition(null);
      return;
    }
    const menu = menuRef.current?.getBoundingClientRect();
    if (menu === undefined) return;
    const placed = placeMenu(
      // 锚就是那个点：上=下=左=右=y/x，宽高 0
      { top: props.position.y, bottom: props.position.y, left: props.position.x, right: props.position.x, width: 0, height: 0 },
      { width: menu.width, height: menu.height },
      "start",
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (!placed.visible) {
      props.onClose();
      return;
    }
    setPosition({ top: placed.top, left: placed.left });
    menuRef.current?.focus();
    // 依赖 position 本身：同一处连点右键也要重量（菜单内容可能随行变化）
  }, [props.position, props.onClose]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node) === true) return;
      props.onClose();
    };
    // 右键滚轮改窗口大小：跟着重定位而不是关门（Menu 同款语义）
    const reposition = (): void => {
      if (props.position === null) return;
      const menu = menuRef.current?.getBoundingClientRect();
      if (menu === undefined) return;
      const placed = placeMenu(
        { top: props.position.y, bottom: props.position.y, left: props.position.x, right: props.position.x, width: 0, height: 0 },
        { width: menu.width, height: menu.height },
        "start",
        { width: window.innerWidth, height: window.innerHeight },
      );
      if (placed.visible) setPosition({ top: placed.top, left: placed.left });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, props.position, props.onClose]);

  if (!open) return null;
  const enabled = props.items.filter((item) => item.disabled !== true && item.fact !== true && item.header !== true);
  const choose = (item: MenuItem): void => {
    if (item.keepOpen !== true) props.onClose();
    item.onSelect?.();
  };
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      className="glass-card glass-float menu-panel"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onClose();
          return;
        }
        if (enabled.length === 0) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActive((current) => (current + 1 + enabled.length) % enabled.length);
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActive((current) => (current - 1 + enabled.length) % enabled.length);
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          const item = enabled[active];
          if (item !== undefined) choose(item);
        }
      }}
      style={{
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position === null ? "hidden" : "visible",
        zIndex: 40,
        minWidth: 140,
        maxWidth: 320,
        padding: "var(--space-1)",
        display: "flex",
        flexDirection: "column",
        outline: "none",
      }}
    >
      {props.items.map((item) => {
        const disabled = item.disabled === true || item.fact === true || item.header === true;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className="option-row"
            data-cursor={enabled[active]?.id === item.id}
            disabled={disabled}
            onMouseEnter={() => {
              const index = enabled.findIndex((candidate) => candidate.id === item.id);
              if (index >= 0) setActive(index);
            }}
            onClick={() => choose(item)}
            style={{
              display: "grid",
              gridTemplateColumns: "14px minmax(0,1fr) auto",
              alignItems: "center",
              gap: "var(--space-2)",
              width: "100%",
              minHeight: "var(--control-height-md)",
              padding: "var(--space-1) var(--space-2)",
              border: 0,
              borderRadius: "var(--radius-sm)",
              ...(item.danger === true && !disabled ? { color: "var(--color-danger)" } : null),
              fontFamily: "var(--font-family-base)",
              fontSize: "var(--font-size-control)",
              textAlign: "left",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            <span
              style={{
                display: "grid",
                placeItems: "center",
                color: "var(--color-text-secondary)",
              }}
            >
              {item.icon !== undefined ? <Icon name={item.icon} size={13} strokeWidth={1.8} /> : null}
            </span>
            <span
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--space-2)",
                minWidth: 0,
              }}
            >
              <span
                style={{
                  flex: "none",
                  minWidth: 0,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {item.label}
              </span>
              {item.hint !== undefined && (
                <span
                  style={{
                    flex: "0 1 auto",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    color: "var(--color-text-tertiary)",
                    fontSize: "var(--font-size-micro)",
                    whiteSpace: "nowrap",
                  }}
                >
                  {item.hint}
                </span>
              )}
            </span>
            {item.badge}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
