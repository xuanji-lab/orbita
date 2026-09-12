import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { ChatView } from "../features/chat/ChatView";
import type { ChatSession, SessionEngine } from "../features/chat/useChatSession";
import type { SessionMeta } from "@shared/session";
import {
  NEW_TASK_TAB,
  closeTab,
  dockTab,
  neighborTab,
  replaceNewTab,
  type DockedTab,
} from "./drawer-state";

export type { DockedTab };

/**
 * 辅助对话 —— 右侧面板壳的三种内容之一（right-drawer-X，2026-09-13 并入统一壳）。
 *
 * 宽度、竖线分界与开合动画都在壳（RightPanelSlot）上；这里只出内容：
 * 标签条多开、单关 + 会话视图。
 *
 * 内容 = 辅助对话，即**一个普通 task 的并排视图**（Q2 裁决）：渲染的就是主会话
 * 同一个 ChatView，不存在第二套 UI。空态选择卡列出四类标签——审查/终端/浏览器
 * 在「明确不做」清单里，按仓库规矩「留着、禁用、标注 planned」，不藏也不假装。
 */
export function Drawer(props: {
  engine: SessionEngine;
  /** 抽屉自己的查看槽——与主槽共用引擎，互不串 */
  view: ChatSession;
  /** 主槽正看着的会话：选择器里排除它（它已经在中间了） */
  mainSessionId: string | null;
  providersError: string | null;
  docked: DockedTab[];
  onDockedChange: (docked: DockedTab[]) => void;
}) {
  const [activeTab, setActiveTab] = useState<DockedTab | null>(props.docked[0] ?? null);
  const [picking, setPicking] = useState(false);

  // 新任务发出第一句话、拿到真 id：把 "new" 占位换成它，激活跟随
  useEffect(() => {
    const id = props.view.sessionId;
    if (id === null || !props.docked.includes(NEW_TASK_TAB)) return;
    props.onDockedChange(replaceNewTab(props.docked, id));
    setActiveTab(id);
    // 只在「从无到有拿到 id」这一刻需要跑
  }, [props.view.sessionId]);

  /** 把某条 task 开进抽屉（切换 / 恢复共用）。已在本槽就不再重开。 */
  const openInDrawer = (id: string): void => {
    if (props.view.sessionId === id || props.view.opened?.id === id) return;
    props.view.openSession(id);
  };

  const activate = (tab: DockedTab): void => {
    setActiveTab(tab);
    if (tab !== NEW_TASK_TAB) openInDrawer(tab);
  };

  const dock = (tab: DockedTab): void => {
    props.onDockedChange(dockTab(props.docked, tab));
    activate(tab);
    setPicking(false);
  };

  const close = (tab: DockedTab): void => {
    const next = closeTab(props.docked, tab);
    props.onDockedChange(next);
    if (activeTab === tab) {
      const neighbor = neighborTab(props.docked, tab);
      setActiveTab(neighbor);
      if (neighbor !== null && neighbor !== NEW_TASK_TAB) openInDrawer(neighbor);
    }
    setPicking(false);
  };

  // 激活的是某条落盘会话：确保它真的在本槽打开（首启恢复 / 切换共用）
  useEffect(() => {
    if (activeTab === null || activeTab === NEW_TASK_TAB) return;
    if (props.view.sessionId === activeTab || props.view.opened?.id === activeTab) return;
    props.view.openSession(activeTab);
    // 只在「激活标签」变化时才需要补打开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // 新任务标签在抽屉视图里就是首页（干净的新 task）；切走再切回来也还是干净的
  const hasTabs = props.docked.length > 0;
  const showPicker = picking;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
      {hasTabs && (
          <div className="drawer-tabs">
            <div className="drawer-tablist">
              {props.docked.map((tab) => {
                const meta = tab === NEW_TASK_TAB ? null : findMeta(props.engine, tab);
                const title =
                  tab === NEW_TASK_TAB
                    ? "新任务"
                    : (meta?.title ?? tab.slice(0, 6) + "…");
                return (
                  <button
                    key={tab}
                    className={`drawer-tab${activeTab === tab ? " on" : ""}`}
                    onClick={() => activate(tab)}
                  >
                    <Icon name="message-square" size={13} />
                    <span className="drawer-tab-name">{title}</span>
                    <span
                      className="drawer-tab-close"
                      title="关闭标签"
                      onClick={(click) => {
                        click.stopPropagation();
                        close(tab);
                      }}
                    >
                      <Icon name="x" size={11} />
                    </span>
                  </button>
                );
              })}
            </div>
            <button className="drawer-tab-add" title="新开标签" onClick={() => setPicking(true)}>
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}

        <div className="drawer-body">
          {showPicker ? (
            <Picker
              sessions={props.engine.sessions}
              excludeId={props.mainSessionId}
              onPick={(id) => dock(id)}
              onNew={() => dock(NEW_TASK_TAB)}
              onBack={() => setPicking(false)}
            />
          ) : activeTab === null ? (
            <Chooser onAux={() => setPicking(true)} />
          ) : (
            // 辅助对话 = 主会话同一个 ChatView：标题头、消息列、输入卡全部同构（Q5/v9）。
            // 还没发过首条消息的新任务用极简首页——欢迎界面是主会话的仪式（wafo 2026-09-12）
            <ChatView
              session={props.view}
              providersError={props.providersError}
              homeBare={activeTab === NEW_TASK_TAB && props.view.sessionId === null}
            />
          )}
        </div>
    </div>
  );
}

function findMeta(engine: SessionEngine, id: string): SessionMeta | null {
  return engine.sessions.find((meta) => meta.id === id) ?? null;
}

/** 空态选择卡：辅助对话可用；审查/终端/浏览器按仓库规矩禁用 + 标 planned */
function Chooser(props: { onAux: () => void }) {
  return (
    <div className="drawer-choose">
      <div className="drawer-choose-card">
        <div className="drawer-choose-title">打开标签页</div>
        <div className="drawer-choose-sub">选择要在侧边面板中打开的标签。</div>
        <div className="drawer-choose-grid">
          <button className="drawer-typebtn" onClick={props.onAux}>
            <Icon name="message-square" size={18} />
            辅助对话
          </button>
          <button className="drawer-typebtn" disabled title="planned — 单独立项后再启用">
            <span className="drawer-typebtn-plan">planned</span>
            <Icon name="search-check" size={18} />
            审查
          </button>
          <button className="drawer-typebtn" disabled title="planned — guideline「明确不做」">
            <span className="drawer-typebtn-plan">planned</span>
            <Icon name="terminal" size={18} />
            终端
          </button>
          <button className="drawer-typebtn" disabled title="planned — guideline「明确不做」">
            <span className="drawer-typebtn-plan">planned</span>
            <Icon name="globe" size={18} />
            浏览器
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * task 选择器（Q7=C）：把另一条 task 并排打开，或当场新建一条。
 * 中间正在看的那条不列——它已经在它该在的位置上。
 */
function Picker(props: {
  sessions: SessionMeta[];
  excludeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onBack: () => void;
}) {
  const candidates = props.sessions.filter((meta) => meta.id !== props.excludeId);
  return (
    <div className="drawer-picker">
      <div className="drawer-picker-head">
        <button className="drawer-picker-back" title="返回" onClick={props.onBack}>
          <Icon name="chevron-down" size={14} style={{ transform: "rotate(90deg)" }} />
        </button>
        并排打开哪个 task？
      </div>
      <div className="drawer-picker-sub">
        辅助对话就是一个普通 task：并排显示、侧栏可见、随时切回。中间正开着的那条不列在这里。
      </div>
      <button className="drawer-pickrow new" onClick={props.onNew}>
        <Icon name="plus" size={15} />
        新建 task
      </button>
      <div className="drawer-picksep" />
      {candidates.map((meta) => (
        <button key={meta.id} className="drawer-pickrow" onClick={() => props.onPick(meta.id)}>
          <Icon name="message-square" size={15} />
          <span className="drawer-pickrow-name">{meta.title}</span>
          <span className="drawer-pickrow-meta">{formatWhen(meta.updatedAt)}</span>
        </button>
      ))}
      {candidates.length === 0 && (
        <div className="drawer-picker-sub">还没有别的 task——新建一条吧。</div>
      )}
    </div>
  );
}

/** 相对时间的最简口径：侧栏的同款信息，不引入第二个日期库 */
function formatWhen(updatedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}小时`;
  return `${Math.round(hours / 24)}天`;
}
