import { createContext, useState } from "react";
import { Icon } from "./Icon";
import { api } from "../api";
import { useT } from "../locale.ts";
import { RIGHT_PANEL_WIDTH_DEFAULT } from "@shared/settings";
import "./toolbar.css";
import {
  LEFT_CAPSULE_W,
  LAYER_PAD,
  RAIL_W,
  WIN_CTL_W,
  conversationColumn,
  leftCapsuleX,
  rightEdge,
  sessionCapsule,
  type ToolbarPlatform,
} from "./window-tools.ts";

/** 右栏胶囊的宿主（各面板的页头内容 portal 进来；面板没开时胶囊不存在 = null） */
export const ToolbarPanelSlotContext = createContext<HTMLDivElement | null>(null);

/**
 * 顶部工具栏（2026-10-19 方案 B v2）：窗口最顶一整条 52，整条拖拽区，里面只有胶囊——
 * 左胶囊（侧栏开关 · 新任务 · 专注）、会话胶囊（居中于对话列，内容由 App 注入）、
 * 右栏胶囊（左缘钉右栏分隔线、宽 = 右栏宽，各面板页头 portal 进来）、右栏开关。
 * Windows / Linux 没有红绿灯：自绘窗口键住最右，右端胶囊整体左让；左胶囊从 x=12 起。
 *
 * 胶囊位置全部由 window-tools.ts 的纯函数按布局量算（侧栏宽 / 右栏宽都是拖拽中的
 * 实时 state，胶囊与卡片同一帧走）。
 */
export function Toolbar(props: {
  platform: ToolbarPlatform;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  onToggleSidebar: () => void;
  onNewTask: () => void;
  windowWidth: number;
  panelOpen: boolean;
  panelWidth: number;
  /** 窄窗（<960）：右栏转右侧锚定覆盖层，胶囊跟着锚右、用默认宽 */
  narrow: boolean;
  /** 会话胶囊内容（SessionCapsule / 设置标题）；null = 不渲染（首页） */
  sessionSlot: React.ReactNode;
  /** 右栏胶囊宿主挂好时回填（portal 目标） */
  onPanelSlot: (el: HTMLDivElement | null) => void;
  /** 右栏开关（辅助对话）点亮态与开关 */
  drawerLit: boolean;
  onToggleDrawer: () => void;
}) {
  const t = useT();
  const darwin = props.platform === "darwin";
  const left = leftCapsuleX(props.platform);
  const col = conversationColumn({
    windowWidth: props.windowWidth,
    sidebarCollapsed: props.sidebarCollapsed,
    sidebarWidth: props.sidebarWidth,
    panelOpen: props.panelOpen && !props.narrow,
    panelWidth: props.panelWidth,
  });
  const limit = rightEdge({
    windowWidth: props.windowWidth,
    platform: props.platform,
    panelOpen: props.panelOpen && !props.narrow,
    panelWidth: props.panelWidth,
  });
  const sess = sessionCapsule({
    windowWidth: props.windowWidth,
    colLeft: col.left,
    colRight: col.right,
    leftCapRight: left + LEFT_CAPSULE_W,
    rightLimit: limit,
  });
  // 右栏开关胶囊：右缘与卡片右缘齐（Windows 让过自绘窗口键）
  const toggleRight = props.windowWidth - LAYER_PAD - (darwin ? 0 : WIN_CTL_W + 8);
  const toggleLeft = toggleRight - RAIL_W;
  // 右栏胶囊：常态左缘钉分隔线、宽 = 右栏宽；窄窗覆盖层锚右、默认宽
  const panelW = props.narrow ? RIGHT_PANEL_WIDTH_DEFAULT : props.panelWidth;
  const panelLeft = props.narrow ? toggleLeft - panelW : col.right;

  return (
    <div className="titlebar toolbar">
      {/* 左胶囊：侧栏开关 · 新任务 · 专注。开合侧栏不换容器——开关坐标天然不变 */}
      <div className="toolbar-capsule" style={{ left, width: LEFT_CAPSULE_W }}>
        <button
          type="button"
          className="quiet-control cap-seg"
          title={props.sidebarCollapsed ? t.sidebar.expand : t.sidebar.collapse}
          aria-label={props.sidebarCollapsed ? t.sidebar.expand : t.sidebar.collapse}
          onClick={props.onToggleSidebar}
        >
          <Icon name="panel-left" size={16} strokeWidth={1.9} />
        </button>
        <span className="cap-accent" title={t.common.newTask}>
          <button
            type="button"
            className="cap-dot"
            aria-label={t.common.newTask}
            onClick={props.onNewTask}
          >
            <Icon name="plus" size={16} strokeWidth={2.2} />
          </button>
        </span>
        {/* 专注模式：先留槽位（planned，显示 + 禁用 + 说明），专注模式的子会话会接上 */}
        <button
          type="button"
          className="quiet-control cap-seg"
          title={t.toolbar.focusPlanned}
          aria-label={t.toolbar.focusPlanned}
          disabled
          aria-disabled
        >
          <Icon name="zap" size={16} strokeWidth={1.9} />
        </button>
      </div>

      {/* 会话胶囊 / 设置标题：几何在这里（居中于对话列），内容 App 注入 */}
      {props.sessionSlot !== null && sess.width > 0 && (
        <div className="toolbar-capsule" style={{ left: sess.x, width: sess.width }}>
          {props.sessionSlot}
        </div>
      )}

      {/* 右栏胶囊：各面板的页头内容 portal 进这个宿主；切面板外框不动、内容淡入 */}
      {props.panelOpen && (
        <div className="toolbar-capsule cap-panel" style={{ left: panelLeft, width: panelW }}>
          <div ref={props.onPanelSlot} className="cap-panel-slot" />
        </div>
      )}

      {/* 右栏开关（辅助对话）：单格胶囊，点亮 = mode 色（右图标条选中同款） */}
      <div className="toolbar-capsule" style={{ left: toggleLeft, width: RAIL_W }}>
        <button
          type="button"
          className="quiet-control cap-seg solo"
          title={t.rail.sideChat}
          aria-label={t.rail.sideChat}
          aria-pressed={props.drawerLit || undefined}
          onClick={props.onToggleDrawer}
        >
          <Icon name="panel-right" size={16} strokeWidth={1.9} />
        </button>
      </div>

      {/* Windows / Linux：自绘窗口键住最右（中心同样在 y=25） */}
      {!darwin && <WindowControls />}
    </div>
  );
}

/** 自绘三键（原 Titlebar 的窗口键迁入工具栏；macOS 的红绿灯是系统的） */
function WindowControls() {
  const t = useT();
  const [isMaximized, setIsMaximized] = useState(false);
  return (
    <div className="win-ctl">
      <button className="win-ctl-btn" title={t.titlebar.minimize} onClick={() => void api.window.minimize()}>
        <Icon name="minus" size={14} />
      </button>
      <button
        className="win-ctl-btn"
        title={isMaximized ? t.titlebar.restore : t.titlebar.maximize}
        onClick={() => {
          setIsMaximized((maximized) => !maximized);
          void api.window.toggleMaximize();
        }}
      >
        <Icon name={isMaximized ? "copy" : "square"} size={13} />
      </button>
      <button className="win-ctl-btn close" title={t.common.close} onClick={() => void api.window.close()}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
