import { createContext, useEffect, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../shell/Icon";
import { IconButton } from "./IconButton";
import { clampRightPanelWidth, RIGHT_PANEL_WIDTH_DEFAULT } from "@shared/settings";
import { usePaneTotalWidth } from "./side-width.ts";
import { useT } from "../locale.ts";
import { ToolbarPanelSlotContext } from "./Toolbar";

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
  /**
   * 把**实际渲染**的宽度（夹过 1/3–2/3 之后）报给调用方——工具栏的右栏胶囊要跟它
   * 对齐。工具栏原先拿盘上的原始宽度自己算：窗口缩小后右栏被夹窄、胶囊还是旧宽，
   * 压到会话胶囊与左上角（2026-10-19 用户验收）。宽度只在这里夹一次，别处只读。
   */
  onRenderedWidth?: (width: number) => void;
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
  const renderedWidth = narrow ? RIGHT_PANEL_WIDTH_DEFAULT : width;
  const onRenderedWidth = props.onRenderedWidth;
  useEffect(() => {
    onRenderedWidth?.(renderedWidth);
  }, [renderedWidth, onRenderedWidth]);

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
 * 面板内容的版式骨架：内容区（120ms 淡入，contentKey 换帧）+ footer 动作区（发丝
 * 顶线分隔，只有表单页用）。右栏全部面板共用这一副骨架；宽度、竖线与开合动画都在
 * RightPanelSlot（壳）上，这里只管内容怎么排。
 *
 * **页头不住卡里，住工具栏的右栏胶囊**（2026-10-19 方案 B v2）：调用方传给 header /
 * headerExtra 的内容原样 portal 到工具栏胶囊的宿主（ToolbarPanelSlotContext），
 * 面板组件不用改写自己的逻辑。配方固定：标题键（PanelTitle）→ 中段（PanelFilter /
 * 页签 / 选择，吃剩余宽）→ 说明「?」（PanelHelp）→ 动作（PanelIconButton）；
 * 切面板时胶囊外框不动，只有内容随 contentKey 换帧淡入。
 */
export function RightPanelFrame(props: {
  /** 页头左段：PanelTitle + 可选的中段控件 */
  header: React.ReactNode;
  /** 内容切换的 key（换帧触发 120ms fade；页头淡入同一 key） */
  contentKey: string;
  /** 页头最右的动作槽（说明 ?、添加、刷新等） */
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const slot = useContext(ToolbarPanelSlotContext);
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "minmax(0,1fr) auto",
      }}
    >
      {slot !== null &&
        createPortal(
          <div className="cap-panel-content" key={props.contentKey}>
            {props.header}
            <span className="cap-grow" aria-hidden="true" />
            {props.headerExtra}
          </div>,
          slot,
        )}

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
 * 胶囊里的动作格（右栏胶囊最右那几颗）：28 圆格、安静控件配方 + 自绘 tooltip，
 * 尺寸走 --titlebar-control（2026-10-19 顶部工具栏规定）。
 */
export function PanelIconButton(props: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <IconButton
      label={props.title}
      size="var(--titlebar-control)"
      disabled={props.disabled}
      onClick={props.onClick}
      className="no-drag"
      style={{ borderRadius: "var(--radius-pill)" }}
    >
      {props.children}
    </IconButton>
  );
}

/**
 * 胶囊标题键：面板图标 + 名称（.cap-pt，胶囊内尺寸）。传 onClick 就是开关形态
 * （button 同配方，aria-expanded 点亮态走 mode 色），文件面板的「文件」标题
 * （树开关）是第一个消费者。
 */
export function PanelTitle(props: {
  icon: IconName;
  title: string;
  tip?: string;
  /** 给了就是可点开关：渲染 button 而不是 span */
  onClick?: () => void;
  /** 开关形态：展开着（点亮态）置 true */
  ariaExpanded?: boolean;
  /** 开关形态：禁用（如文件面板没有打开文件时树开关不可点） */
  disabled?: boolean;
  /** 开关形态的行尾（如折叠 chevron） */
  trailing?: React.ReactNode;
  /** 调用方追加的 class */
  className?: string;
}) {
  const inner = (
    <>
      <Icon name={props.icon} size={16} strokeWidth={1.8} />
      <strong>{props.title}</strong>
      {props.trailing}
    </>
  );
  const className = `cap-pt${props.className === undefined ? "" : ` ${props.className}`}`;
  if (props.onClick === undefined) {
    return (
      <span className={className} title={props.tip}>
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`quiet-control ${className}`}
      title={props.tip}
      onClick={props.onClick}
      aria-expanded={props.ariaExpanded === true}
      disabled={props.disabled}
    >
      {inner}
    </button>
  );
}

/**
 * 胶囊中段的筛选框（.cap-pf，24 高小药丸）：放大镜 + 输入 + 计数，吃剩余宽。
 * **窄于 300（容器断点，window-tools.ts 对账）收成一个搜索格**；点开筛选框
 * 占满整颗胶囊（.open 绝对定位铺开，标题键 / 动作格还在下面被盖住），
 * Esc / 失焦 / ✕ 收回。Esc 先清词、词空了才冒泡（照旧去关面板）。
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
  const t = useT();
  /** 窄态点开：筛选框占满胶囊 */
  const [fill, setFill] = useState(false);
  const fillInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (fill) fillInputRef.current?.focus();
  }, [fill]);
  const esc = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (props.onKeyDown !== undefined) {
      props.onKeyDown(event);
      return;
    }
    if (event.key === "Escape" && props.value !== "") {
      event.stopPropagation();
      props.onChange("");
    }
  };
  return (
    <>
      <label className={`cap-pf cap-grow cap-pf-full no-drag${fill ? " open" : ""}`}>
        <Icon name="search" size={14} strokeWidth={1.8} />
        <input
          ref={props.inputRef ?? fillInputRef}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            esc(event);
            if (event.key === "Escape" && props.value === "") setFill(false);
          }}
          onBlur={() => setFill(false)}
          placeholder={props.placeholder}
          aria-label={props.ariaLabel ?? props.placeholder}
        />
        {props.count !== undefined && <span className="cap-count">{props.count}</span>}
        {fill && (
          <button
            type="button"
            className="quiet-control cap-mini"
            title={t.common.close}
            aria-label={t.common.close}
            onClick={() => setFill(false)}
          >
            <Icon name="x" size={14} strokeWidth={2.2} />
          </button>
        )}
      </label>
      {/* 窄态的搜索格：container query 里换它出场 */}
      {!fill && (
        <button
          type="button"
          className="quiet-control cap-seg solo cap-pf-collapsed no-drag"
          title={props.placeholder}
          aria-label={props.ariaLabel ?? props.placeholder}
          onClick={() => setFill(true)}
        >
          <Icon name="search" size={16} strokeWidth={1.8} />
        </button>
      )}
    </>
  );
}

/**
 * 说明「?」：面板里原先成段铺开的解释（MCP 的重载与工作区说明、辅助对话是什么）
 * 收进这里，悬停 / 聚焦读（IconButton 的自绘 tooltip，宽 240 会换行）。
 */
export function PanelHelp(props: { text: string; label: string }) {
  return (
    <IconButton
      label={props.label}
      title={props.text}
      size="var(--titlebar-control)"
      className="no-drag"
      style={{ borderRadius: "var(--radius-pill)" }}
    >
      <Icon name="circle-help" size={15} />
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
