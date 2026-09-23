import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";
import { placeMenu, type MenuBox, type MenuPlacementSide } from "./menu-position";

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  /** 右侧的说明。菜单项自己解释后果，比事后弹一个确认框好 */
  hint?: string;
  /** 最右端的徽标区（如模型项的 ctx 窗口与图片能力）。小而事实性的东西，不参与布局语义 */
  badge?: React.ReactNode;
  /** 当前项。用 check 图标标出来，不用染色——状态优先图标与文字 */
  checked?: boolean;
  disabled?: boolean;
  /**
   * **这一行是事实，不是动作**（用量分项那几行）。不可选中、不抢键盘焦点，
   * 光标也不变成禁止符——`disabled` 说的是「你现在不能做这件事」，
   * 而这些行从来不是一件事。数字用 mono 字体（设计系统：mono for machine facts）。
   */
  fact?: boolean;
  /** 分组头：菜单里一节的小标题（如模型菜单的厂商名）。不可选、不抢焦点，样式同设置面的节标题 */
  header?: boolean;
  /** 破坏性动作：danger 色。**只给真的会丢东西的那一项** */
  danger?: boolean;
  /**
   * 选中之后菜单不关。给两段式确认用——「删除…」先把菜单换成一组确认项，
   * 第二下才真删。设计系统要求「先讲后果再动作」，而本分支还没有 Modal。
   */
  keepOpen?: boolean;
  onSelect?: () => void;
}

/**
 * 搜索过滤（searchable 菜单用）：命中行保留；组头跟着走——组内有命中就带组头，
 * 组头名自己命中（按厂商搜）就整组保留。q 为空原样返回。
 */
function filterMenuItems(items: MenuItem[], q: string): MenuItem[] {
  if (q === "") return items;
  const hit = (label: string) => label.toLowerCase().includes(q);
  const out: MenuItem[] = [];
  let header: MenuItem | null = null;
  let all: MenuItem[] = [];
  let matched: MenuItem[] = [];
  const flush = () => {
    if (header !== null) {
      if (hit(header.label)) out.push(header, ...all);
      else if (matched.length > 0) out.push(header, ...matched);
    } else {
      out.push(...matched);
    }
    header = null;
    all = [];
    matched = [];
  };
  for (const item of items) {
    if (item.header === true) {
      flush();
      header = item;
    } else {
      all.push(item);
      if (hit(item.label)) matched.push(item);
    }
  }
  flush();
  return out;
}

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
  /** 顶部渲染搜索框，按键实时过滤（模型菜单这类长清单）。打开即聚焦，关闭即清空 */
  searchable?: boolean;
  /** 开合的回声。给调用方复位自己的两段式状态用（菜单关了，确认态不该留着） */
  onOpenChange?: (open: boolean) => void;
  /**
   * 面板最小宽度（px）。全局默认 180 是给带描述/徽标的菜单定的；短词菜单
   * （思考档的 Low/High/Max）被它撑出一大截空白，显得轻浮。给**窄值**时面板
   * 收窄到内容，maxWidth 320 仍兜底。
   */
  panelMinWidth?: number;
  /**
   * 面板最大宽度（px）。默认 320 是给模型名、工作区路径这类长文本留的；
   * 侧栏会话行那种**动作清单**给窄值收住——它的每一项都是两三个词，
   * 撑到 320 只是在会话列表旁边糊一大块玻璃（2026-09-22 wafo：「卡片太大」）。
   */
  panelMaxWidth?: number;
  /**
   * 菜单开在锚点的哪一边。默认下方；`right` 给侧栏会话行——
   * 开在下方会盖住紧挨着的下一条会话，想看别的会话就得先关菜单。
   */
  placement?: MenuPlacementSide;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 这次是点开的还是悬停开的——决定要不要把焦点交给菜单 */
  const byClickRef = useRef(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
    setQuery("");
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

  /**
   * 重定位：跟随锚点当前位置。**滚动不再关门**——模型回答时消息区一直在自动
   * 滚动，「滚动即关」等于「回答期间用量菜单永远开不住」（一闪一闪、点不开，
   * 2026-09-06 用户实测）。而输入卡钉在窗口底部，自动滚动根本不动锚点——
   * 位置没变就不 setState，流式期间的滚动风暴一次重渲染都不产生。
   */
  const positionMenu = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const menu = menuRef.current?.getBoundingClientRect();
    if (anchor === undefined || menu === undefined) return;
    const box: MenuBox = {
      top: anchor.top,
      bottom: anchor.bottom,
      left: anchor.left,
      right: anchor.right,
      width: anchor.width,
      height: anchor.height,
    };
    const placed = placeMenu(
      box,
      { width: menu.width, height: menu.height },
      props.align,
      { width: window.innerWidth, height: window.innerHeight },
      props.placement,
    );
    if (!placed.visible) {
      close();
      return;
    }
    setPosition((prev) =>
      prev !== null && prev.top === placed.top && prev.left === placed.left ? prev : { top: placed.top, left: placed.left },
    );
  }, [props.align, props.placement, close]);

  // 首次打开：先按旧位置渲染但不可见，量到真实高度之后再定位——菜单高度取决于
  // 内容，不先量就只能猜。这一步必须在浏览器绘制前做完，否则会看到菜单跳一下。
  // 搜索过滤改变行数时同样要重量——deps 里的 visible.length 就是为此
  const visible = filterMenuItems(props.items, query.trim().toLowerCase());
  const searching = props.searchable === true && query.trim() !== "";
  useLayoutEffect(() => {
    if (!open) return;
    positionMenu();
    // 点开的才拿焦点（键盘导航）；悬停开的把焦点留在原处。搜索框优先——
    // 打开就想打字，不该再点一下。滚动跟随不在这里走——焦点只在该拿到的那一刻
    // 给一次，跟着滚动反复 focus 会把用户的选区打飞
    if (byClickRef.current) {
      if (props.searchable === true) searchRef.current?.focus();
      else menuRef.current?.focus();
    }
  }, [open, visible.length, positionMenu, props.searchable]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) === true) return;
      if (anchorRef.current?.contains(target) === true) return;
      close();
    };
    // 滚动与改窗口大小：追着重定位而不是关门。锚点跟着界面动了，菜单跟着锚点走；
    // 锚点整个出屏（placeMenu 判 visible=false）才关门——那时跟着走是挂在天上
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, close, positionMenu]);

  // 键盘导航与渲染都走**过滤后**的清单——搜索时 cursor 与 Enter 只在可见项里打转
  const enabled = visible.filter(
    (item) => item.disabled !== true && item.fact !== true && item.header !== true,
  );
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
            className="glass-card glass-float"
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
                // 焦点在搜索框时空格是打字，不是选择
                if (event.key === " " && searchRef.current === document.activeElement) return;
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
              minWidth: props.panelMinWidth ?? 180,
              maxWidth: props.panelMaxWidth ?? 320,
              padding: "var(--space-1)",
              display: "flex",
              flexDirection: "column",
              // 行间不留缝：每行自己已有 minHeight 与 hover 底，1px 的缝只是
              // 把清单又拉高一截（8 项就是 8px），并不帮人分行
              outline: "none",
            }}
          >
            {props.searchable === true && (
              <div style={{ position: "relative", margin: "1px 1px var(--space-1)" }}>
                <span
                  style={{
                    position: "absolute",
                    left: 8,
                    top: "50%",
                    translate: "0 -50%",
                    display: "inline-flex",
                    color: "var(--color-text-tertiary)",
                    pointerEvents: "none",
                  }}
                >
                  <Icon name="search" size={13} />
                </span>
                <input
                  ref={searchRef}
                  value={query}
                  placeholder="Search models…"
                  spellCheck={false}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    height: "var(--control-height-sm)",
                    padding: "0 10px 0 27px",
                    border: "1px solid var(--color-border-default)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--color-bg-panel)",
                    color: "var(--color-text-primary)",
                    fontFamily: "var(--font-family-base)",
                    fontSize: "var(--font-size-control)",
                    outline: "none",
                  }}
                />
              </div>
            )}
            {searching && visible.length === 0 && (
              <div
                style={{
                  padding: "var(--space-2)",
                  fontFamily: "var(--font-family-base)",
                  fontSize: "var(--font-size-caption)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                No models match.
              </div>
            )}
            {visible.map((item) => (
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
  /** 键盘 / 鼠标的停留位置。与「选中」是两件事——见 styles.css 的 `.option-row` */
  cursor: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const { item } = props;
  const fact = item.fact === true;
  const header = item.header === true;
  const disabled = item.disabled === true || fact || header;
  return (
    <button
      type="button"
      role={fact || header ? "presentation" : "menuitem"}
      className="option-row"
      // 光标是键盘 / 鼠标共用的高亮位置，不是 :hover——鼠标进入只是把光标移过来
      // （onHover），键盘上下也移它，两者不能叠加成分别的高亮（否则键盘挪走后鼠标
      // 停的那行会跟着一起亮）
      data-cursor={props.cursor}
      aria-selected={item.checked === true || undefined}
      disabled={disabled}
      onMouseEnter={props.onHover}
      onClick={props.onSelect}
      style={{
        display: "grid",
        // 图标槽 14px：里面的图标就是 13px，16 的槽只是每行白多一道缝
        gridTemplateColumns: "14px minmax(0,1fr) auto auto",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        minHeight: "var(--control-height-md)",
        padding: "var(--space-1) var(--space-2)",
        border: 0,
        borderRadius: "var(--radius-sm)",
        // danger 只改文字色，不染底——底是选择态的地盘（.option-row）
        ...(item.danger === true && !disabled ? { color: "var(--color-danger)" } : null),
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        textAlign: "left",
        // 事实行不是「禁止你点」，光标不该摆出禁止符
        cursor: fact || header ? "default" : disabled ? "not-allowed" : "pointer",
        // 事实行矮一档（xs）：一眼能看出它们不是可点的那一类
        ...(fact ? { minHeight: "var(--control-height-xs)" } : null),
        // 分组头 = 设置面节标题的同款语言：mono、micro、大写加字距
        ...(header
          ? {
              minHeight: "var(--control-height-sm)",
              paddingTop: "var(--space-2)",
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-micro)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              // 加粗：模型菜单里组头与模型行同色同高、只差字号和大小写，两家 provider 靠得近时
              // 分不清哪行是头（2026-09-21 wafo）。仍用二级文字色，不抢模型行的主角位。
              fontWeight: "var(--weight-bold)",
              color: "var(--color-text-secondary)",
            }
          : null),
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
      {item.badge}
    </button>
  );
}
