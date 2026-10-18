import { useRef, useState } from "react";
import { Icon, type IconName } from "../shell/Icon";
import { IconButton } from "./IconButton";
import { clampRightPanelWidth, RIGHT_PANEL_WIDTH_DEFAULT } from "@shared/settings";
import { usePaneTotalWidth } from "./side-width.ts";
import { useT } from "../locale.ts";

/**
 * 右侧面板壳（2026-09-13 裁决）：Skills / MCP / 辅助对话三个菜单共用这**一个**
 * 常驻挂载的分栏——宽度以 class 切换驱动过渡（与抽屉同一套机制），展开、收起
 * 只有一条动画路径；面板间切换是同一个壳换内容，不存在「折叠再展开」。
 *
 * 宽度变量 `--right-panel-w` 由调用方注入（面板位唯一的宽度记忆，Q3：共用）。
 * 拖宽热区骑在左缘竖线上，拖动中禁过渡（同 .drawer.dragging 的纪律）实时跟手；
 * 双击热区回 320。窄窗（<960px）转右侧锚定覆盖层，进入滑入 + 淡入（right-panel-in）。
 */
export function RightPanelSlot(props: {
  open: boolean;
  width: number;
  narrow: boolean;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  children: React.ReactNode;
}) {
  const t = useT();
  const { narrow, open } = props;
  const asideRef = useRef<HTMLElement | null>(null);
  /** 拖宽中禁掉 width 过渡——实时跟手（同 .drawer.dragging 的纪律） */
  const [resizing, setResizing] = useState(false);
  /**
   * 区间是 pane（chat 主区 + 右栏）的 1/3–2/3，所以**渲染时也要夹一次**，不只拖动时：
   * 盘上那个宽度可能是在更宽的窗口（或另一台显示器）上存的。只夹渲染值、
   * 不回写 settings；窄窗转覆盖层时宽度写死 320，那时不量也不夹。
   */
  const paneTotal = usePaneTotalWidth(asideRef, !narrow);
  const width = paneTotal > 0 ? clampRightPanelWidth(props.width, paneTotal) : props.width;

  /**
   * 拖宽（4-0）：左移变宽。区间**按 pane 算**——右栏 ∈ [P/3, 2P/3]，
   * P = chat 主区 + 右栏（2026-09-22 wafo 裁决：这一对只管 chat 与右栏，与左侧栏无关），
   * 地板见 clampRightPanelWidth。
   * P 在拖动中恒定：pane 让出多少面板就长多少，所以不必每帧重测。
   * 拖动中不做动画；松手不 snap；双击热区回 320（同样夹一次）。
   */
  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const panel = asideRef.current;
    if (panel === null) return;
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const clamp = (value: number): number => clampRightPanelWidth(value, paneTotal);
    // 拖动期间全文选择与光标都固定成拖拽语义，松手还原
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      props.onWidthChange(clamp(startWidth - (ev.clientX - startX)));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
      setResizing(false);
      props.onWidthCommit(clamp(startWidth - (ev.clientX - startX)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <aside
      ref={asideRef}
      className={`right-panel-slot${open ? " open" : ""}${resizing ? " dragging" : ""}`}
      style={
        {
          "--right-panel-w": `${narrow ? RIGHT_PANEL_WIDTH_DEFAULT : width}px`,
          // 窄窗覆盖层的定位基准是 .layer（pane 无 position）——右侧让过 rail 一条；
          // 那时壳需要自己的面：设计系统「Floating layers」的实色底 + 发丝边 + popover
          // 阴影。不用玻璃：没有 blur，半透明的它压在聊天正文上，底下的字会直接漏上来
          ...(narrow && open
            ? {
                position: "absolute",
                top: "var(--space-3)",
                bottom: "var(--space-3)",
                right: "calc(var(--space-3) + 32px + var(--space-3))",
                background: "var(--color-bg-panel)",
                border: "1px solid var(--glass-border)",
                borderRadius: "var(--radius-xl)",
                boxShadow: "var(--shadow-popover)",
                zIndex: 20,
                animation: "right-panel-in var(--duration-enter) var(--ease-out-quint)",
              }
            : {}),
        } as React.CSSProperties
      }
    >
      {/* 拖宽热区：左缘 6px 骑在竖线上；双击回 320 */}
      {!narrow && (
        <span
          onPointerDown={startResize}
          onDoubleClick={() =>
            props.onWidthCommit(clampRightPanelWidth(RIGHT_PANEL_WIDTH_DEFAULT, paneTotal))
          }
          title={t.common.dragResize}
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: "col-resize",
            // 要在面板内容的浮层之上（文件树 overlay 是 z-20）：浮层盖住热区就把
            // 拖宽没收了（2026-10-10 实机验收抓到）；全局浮层（contextmenu 70）仍更高
            zIndex: 30,
          }}
        />
      )}
      <div className="right-panel-slot-inner">{props.children}</div>
    </aside>
  );
}

/**
 * 面板内容的版式骨架：页头（标题行）、内容区（120ms 淡入，contentKey 换帧）、
 * footer 动作区（发丝顶线分隔，只有表单页用）。右栏全部面板共用这一副骨架。
 * 宽度、竖线与开合动画都在 RightPanelSlot（壳）上，这里只管内容怎么排。
 *
 * **标题行就是工具行**（2026-10-11 右栏统一，用户选定方案 B「一体标题栏」）：
 * 图标 + 标题（PanelTitle）→ 中段（过滤框 PanelFilter / 终端标签 / 审查范围，
 * 带 `.panel-head-grow` 的占满剩余宽度）→ 说明「?」（PanelHelp）→ 面板动作。
 * 没有第二条工具行，也**没有 ×**——右图标条本身就是开关（同次裁决：全部去掉）。
 */
export function RightPanelFrame(props: {
  /** 页头左段：PanelTitle + 可选的中段控件 */
  header: React.ReactNode;
  /** 内容切换的 key（换帧触发 120ms fade） */
  contentKey: string;
  /** 页头最右的动作槽（说明 ?、添加、刷新等） */
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr) auto",
      }}
    >
      <header className="titlebar panel-head">
        {props.header}
        <span className="panel-head-spacer" aria-hidden="true" />
        {props.headerExtra}
      </header>

      <div
        key={props.contentKey}
        className="scroll"
        style={{ minHeight: 0, animation: "right-panel-fade 120ms var(--ease-out-quint)" }}
      >
        {props.children}
      </div>

      {props.footer !== undefined && (
        <footer
          style={{
            borderTop: "1px solid var(--color-border-subtle)",
            padding: "var(--space-3) var(--space-4)",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          {props.footer}
        </footer>
      )}
    </div>
  );
}

/**
 * 面板内的 24px 图标方块：就是 IconButton（安静控件配方 + 自绘 tooltip）。
 * 原先这里自己画 hover（onMouseEnter 写 style）、用原生 title——违反「状态样式归 CSS」
 * 与「tooltip 自绘」两条规矩，右栏统一时收口到 IconButton。26→24（2026-10-18）：
 * 页头收窄到 --titlebar-row（26px）后上下各留 1px，不贴卡顶与底线。
 */
export function PanelIconButton(props: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <IconButton label={props.title} size={24} disabled={props.disabled} onClick={props.onClick} className="no-drag">
      {props.children}
    </IconButton>
  );
}

/** 标题行左段：图标 + 标题。六个面板同一种写法（字号 / 字重 / 图标色由 CSS 管） */
export function PanelTitle(props: { icon: IconName; title: string; tip?: string }) {
  return (
    <span className="panel-title" title={props.tip}>
      <Icon name={props.icon} size={14} />
      <strong>{props.title}</strong>
    </span>
  );
}

/**
 * 标题行里的过滤框（方案 B）：浅底胶囊、放大镜 + 输入 + 计数，占满标题与动作之间的空位。
 * Esc 先清词、词空了才冒泡（照旧去关面板）——与各面板原过滤行同一手感。
 */
export function PanelFilter(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel?: string;
  /** 右侧计数（可省） */
  count?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  /** 选取模式等需要自己接管键盘时传；不传走默认的 Esc 清词 */
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <label className="panel-filter panel-head-grow no-drag">
      <Icon name="search" size={13} />
      <input
        ref={props.inputRef}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (props.onKeyDown !== undefined) {
            props.onKeyDown(event);
            return;
          }
          if (event.key === "Escape" && props.value !== "") {
            event.stopPropagation();
            props.onChange("");
          }
        }}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel ?? props.placeholder}
      />
      {props.count !== undefined && <span className="panel-filter-count">{props.count}</span>}
    </label>
  );
}

/**
 * 说明「?」：面板里原先成段铺开的解释（MCP 的重载与工作区说明、辅助对话是什么）
 * 收进这里，悬停 / 聚焦读（IconButton 的自绘 tooltip，宽 240 会换行）。
 */
export function PanelHelp(props: { text: string; label: string }) {
  return (
    <IconButton label={props.label} title={props.text} size={24} className="no-drag">
      <Icon name="circle-help" size={14} />
    </IconButton>
  );
}

/**
 * 分组标题（文件的会话 / 工作区 / 附加目录、技能的全局 / 各工作区……）：
 * 小号半粗无衬线 + 浅灰补充（路径或计数），整行可点折叠；组与组之间只靠留白，
 * 不画分隔线、不铺底色（2026-10-11 用户：不要白色底带、不要横线、等宽大写可读性差）。
 * `trailing` 是行尾悬停动作（排序 / 在访达显示…），平时不占位。
 */
export function PanelGroupHead(props: {
  label: string;
  /** 标题后的浅灰补充：路径（长了从左省略）或计数 */
  detail?: string;
  detailTitle?: string;
  detailWarn?: boolean;
  collapsed?: boolean;
  /** 不传 = 不可折叠（组头只是标签） */
  onToggle?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  trailing?: React.ReactNode;
}) {
  const collapsible = props.onToggle !== undefined;
  const inner = (
    <>
      {collapsible && <Icon name="chevron-right" size={12} strokeWidth={2} className="panel-group-chev" />}
      <span className="panel-group-label">{props.label}</span>
      {props.detail !== undefined && props.detail !== "" && (
        <span
          className="panel-group-detail"
          title={props.detailTitle ?? props.detail}
          data-warn={props.detailWarn === true ? "true" : undefined}
        >
          {props.detail}
        </span>
      )}
    </>
  );
  return (
    <div className="panel-group-head" onContextMenu={props.onContextMenu}>
      {collapsible ? (
        <button
          type="button"
          className="panel-group-toggle"
          aria-expanded={props.collapsed !== true}
          onClick={props.onToggle}
        >
          {inner}
        </button>
      ) : (
        <span className="panel-group-toggle">{inner}</span>
      )}
      {props.trailing !== undefined && <span className="panel-group-acts">{props.trailing}</span>}
    </div>
  );
}

/** 面板 footer 的次级按钮（sm 高度，中性面）。variant=danger 给破坏性动作。 */
export function PanelButton(props: {
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const disabled = props.disabled === true;
  const danger = props.danger === true;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={disabled}
      title={props.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "var(--control-height-sm)",
        padding: "0 var(--space-3)",
        background: danger ? "transparent" : "var(--color-bg-muted)",
        color: danger ? "var(--color-danger)" : "var(--color-text-primary)",
        border: danger ? "1px solid var(--color-danger)" : 0,
        borderRadius: "var(--radius-md)",
        font: "inherit",
        fontSize: "var(--font-size-base)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {props.children}
    </button>
  );
}

/** 面板里的一行小字（sm/tertiary），说明与空态用。 */
export function PanelLine(props: { children: React.ReactNode; danger?: boolean }) {
  return (
    <p
      role={props.danger === true ? "alert" : undefined}
      style={{
        margin: 0,
        fontSize: "var(--font-size-sm)",
        color: props.danger === true ? "var(--color-danger)" : "var(--color-text-tertiary)",
      }}
    >
      {props.children}
    </p>
  );
}
