import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { selectionStyle } from "./selection";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** 右侧的说明。菜单项自己解释后果，比事后弹一个确认框好 */
  hint?: string;
  /** 当前项。用 check 图标标出来，不用染色——状态优先图标与文字 */
  checked?: boolean;
  disabled?: boolean;
  /**
   * **这一行是事实，不是动作**（用量分项那几行）。不可选中、不抢键盘焦点，
   * 光标也不变成禁止符——`disabled` 说的是「你现在不能做这件事」，
   * 而这些行从来不是一件事。数字用 mono 字体（设计系统：mono for machine facts）。
   */
  fact?: boolean;
  /** 破坏性动作：danger 色。**只给真的会丢东西的那一项** */
  danger?: boolean;
  /**
   * 选中之后菜单不关。给两段式确认用——「删除…」先把菜单换成一组确认项，
   * 第二下才真删。设计系统要求「先讲后果再动作」，而本分支还没有 Modal。
   */
  keepOpen?: boolean;
  onSelect?: () => void;
}

/** 菜单离触发点、离窗口边的余量 */
const GAP = 6;
const EDGE = 8;
/** 悬停打开的菜单：光标离开后多久关。够穿过那道缝，又不至于像粘住了 */
const HOVER_GRACE_MS = 160;

/**
 * 下拉（必要时上拉）菜单。**本分支唯一的弹层原语**。
 *
 * 三个决定：
 *
 * 1. **默认向下，下方装不下才翻上去。** 先按向下渲染但不可见，量到真实高度之后再定位——
 *    菜单高度取决于内容，不先量就只能猜。
 * 2. **portal 到 body + `position: fixed`。** 边界卡、内容面、侧栏都是 `overflow: hidden`，
 *    在原地渲染的菜单会被裁掉；fixed 定位还能免掉逐层累加滚动偏移。
 * 3. **layer 3 玻璃**：与输入卡同一层——它浮在内容之上，理应比内容更实。
 *    阴影用 `--shadow-popover`（设计系统 *Shadows*：menus, card hover）。
 */
export function Menu(props: {
  items: MenuItem[];
  /** 触发器自己画。拿到 open 是为了画出「正被打开」的状态 */
  trigger: (state: { open: boolean; toggle: () => void }) => React.ReactNode;
  /** 菜单与触发器哪一边对齐。默认左对齐；靠右的触发器（如三个点）用 end */
  align?: "start" | "end";
  /**
   * 悬停即开、移开即关——给「看一眼事实」的菜单用（底栏的用量环）。
   * 点击仍然能开：键盘与触屏没有悬停。**悬停打开的菜单不抢焦点**——
   * 光标只是路过输入框上方，正在打的字不该因此断掉；点开的才把焦点交给菜单。
   */
  hoverOpen?: boolean;
  /** 开合的回声。给调用方复位自己的两段式状态用（菜单关了，确认态不该留着） */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** 这次是点开的还是悬停开的——决定要不要把焦点交给菜单 */
  const byClickRef = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  const cancelLeave = () => {
    if (leaveTimer.current !== null) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  };
  /** 从触发器挪到菜单要穿过那 6px 的缝，留一拍再关，免得半路就没了 */
  const scheduleLeave = () => {
    cancelLeave();
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      if (!byClickRef.current) close();
    }, HOVER_GRACE_MS);
  };
  useEffect(() => cancelLeave, []);
  const { onOpenChange } = props;
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);

  // 量到真实高度之后再定位。这一步必须在浏览器绘制前做完，否则会看到菜单跳一下
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (anchor === undefined || menu === undefined) return;

    // 默认向下；下面装不下、而上面装得下时才翻上去
    const below = anchor.bottom + GAP;
    const fitsBelow = below + menu.height + EDGE <= window.innerHeight;
    const fitsAbove = anchor.top - GAP - menu.height - EDGE >= 0;
    const top = fitsBelow || !fitsAbove ? below : anchor.top - GAP - menu.height;

    const wanted = props.align === "end" ? anchor.right - menu.width : anchor.left;
    // 横向夹回窗口内：宁可不对齐，也不要有一半在屏幕外
    const left = Math.min(Math.max(EDGE, wanted), window.innerWidth - menu.width - EDGE);
    setPosition({ top, left });
    // 点开的才拿焦点（键盘导航）；悬停开的把焦点留在原处
    if (byClickRef.current) menuRef.current?.focus();
  }, [open, props.align, props.items.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      close();
    };
    // 滚动或改窗口大小之后位置就不对了，直接关掉比追着重算诚实
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, close]);

  const enabled = props.items.filter((item) => item.disabled !== true && item.fact !== true);
  /** 打开时光标落在**当前项**上。落在第一项会让人以为选中的是第一项。 */
  const cursorAtChecked = () => Math.max(0, enabled.findIndex((item) => item.checked === true));

  const move = (delta: number) => {
    if (enabled.length === 0) return;
    setActive((current) => (current + delta + enabled.length) % enabled.length);
  };

  const choose = (item: MenuItem) => {
    if (item.keepOpen !== true) close();
    else setActive(0);
    item.onSelect?.();
  };

  return (
    <>
      <span
        ref={anchorRef}
        style={{ display: "inline-flex", minWidth: 0 }}
        onPointerEnter={
          props.hoverOpen === true
            ? () => {
                cancelLeave();
                if (open) return;
                byClickRef.current = false;
                setActive(cursorAtChecked());
                setOpen(true);
              }
            : undefined
        }
        onPointerLeave={props.hoverOpen === true ? scheduleLeave : undefined}
      >
        {props.trigger({
          open,
          toggle: () => {
            cancelLeave();
            // 悬停开着的菜单被点了一下：不是要关，是要接管——拿焦点、移开光标也不关
            if (open && !byClickRef.current) {
              byClickRef.current = true;
              menuRef.current?.focus();
              return;
            }
            byClickRef.current = true;
            setActive(cursorAtChecked());
            setOpen((value) => !value);
          },
        })}
      </span>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            onPointerEnter={props.hoverOpen === true ? cancelLeave : undefined}
            onPointerLeave={props.hoverOpen === true ? scheduleLeave : undefined}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
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
              // 量高度那一帧不可见，避免在错位置闪一下
              visibility: position === null ? "hidden" : "visible",
              zIndex: 40,
              minWidth: 180,
              maxWidth: 320,
              padding: "var(--space-1)",
              display: "flex",
              flexDirection: "column",
              gap: 1,
              background: "var(--glass-bg)",
              border: "1px solid var(--glass-border)",
              borderRadius: "var(--radius-xl)",
              boxShadow: "var(--shadow-popover)",
              WebkitBackdropFilter: "blur(var(--glass-blur))",
              backdropFilter: "blur(var(--glass-blur))",
              outline: "none",
            }}
          >
            {props.items.map((item) => (
              <MenuRow
                key={item.id}
                item={item}
                cursor={enabled[active]?.id === item.id}
                onHover={() => {
                  const index = enabled.findIndex((candidate) => candidate.id === item.id);
                  if (index >= 0) setActive(index);
                }}
                onSelect={() => choose(item)}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function MenuRow(props: {
  item: MenuItem;
  /** 键盘 / 鼠标的停留位置。与「选中」是两件事——见 selection.ts */
  cursor: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { item } = props;
  const fact = item.fact === true;
  const disabled = item.disabled === true || fact;
  return (
    <button
      type="button"
      role={fact ? "presentation" : "menuitem"}
      disabled={disabled}
      onMouseEnter={props.onHover}
      onClick={props.onSelect}
      style={{
        display: "grid",
        gridTemplateColumns: "16px minmax(0,1fr) auto",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        minHeight: "var(--control-height-md)",
        padding: "var(--space-1) var(--space-2)",
        border: 0,
        borderRadius: "var(--radius-sm)",
        ...selectionStyle({ selected: item.checked, hover: props.cursor, disabled }),
        // danger 只改文字色，不染底——底是选择态的地盘（selection.ts）
        ...(item.danger === true && !disabled ? { color: "var(--color-danger)" } : null),
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        textAlign: "left",
        // 事实行不是「禁止你点」，光标不该摆出禁止符
        cursor: fact ? "default" : disabled ? "not-allowed" : "pointer",
        // 事实行矮一档（xs）：一眼能看出它们不是可点的那一类
        ...(fact ? { minHeight: "var(--control-height-xs)" } : null),
      }}
    >
      <span
        style={{
          display: "grid",
          placeItems: "center",
          color: item.danger === true ? "var(--color-danger)" : "var(--color-text-secondary)",
        }}
      >
        {item.checked === true ? (
          <Icon name="check" size={13} strokeWidth={2} />
        ) : item.icon !== undefined ? (
          <Icon name={item.icon} size={13} strokeWidth={1.8} />
        ) : null}
      </span>
      <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {item.label}
      </span>
      {item.hint !== undefined && (
        <span
          style={{
            color: "var(--color-text-tertiary)",
            fontSize: "var(--font-size-micro)",
            whiteSpace: "nowrap",
            ...(fact
              ? {
                  fontFamily: "var(--font-family-business)",
                  fontVariantNumeric: "tabular-nums",
                  color: "var(--color-text-secondary)",
                }
              : null),
          }}
        >
          {item.hint}
        </span>
      )}
    </button>
  );
}
