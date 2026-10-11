import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { PanelFilter, PanelHelp, PanelIconButton, PanelTitle, RightPanelFrame } from "./RightPanel";
import { ChatView } from "../features/chat/ChatView";
import type { ChatSession, SessionEngine } from "../features/chat/useChatSession";
import { rootSessions, type SessionMeta } from "@shared/session";
import type { ModelPair } from "@shared/settings";
import {
  NEW_TASK_TAB,
  closeTab,
  dockTab,
  neighborTab,
  replaceNewTab,
  type DockedTab,
} from "./drawer-state";
import { useT } from "../locale.ts";
import type { Messages } from "../messages-en.ts";

export type { DockedTab };

/**
 * 辅助对话 —— 右侧面板壳的三种内容之一（right-drawer-X，2026-09-13 并入统一壳）。
 *
 * 宽度、竖线分界与开合动画都在壳（RightPanelSlot）上；这里只出内容：
 * 标签条多开、单关 + 会话视图。
 *
 * 内容 = 辅助对话，即**一个普通 task 的并排视图**（Q2 裁决）：渲染的就是主会话
 * 同一个 ChatView，不存在第二套 UI。空态直接是 task 选择器（2026-09-21 方案 A）：
 * rail 的「辅助对话」入口一点就到选择器，中间不再隔一层只有一个可点的卡。
 */
export function Drawer(props: {
  engine: SessionEngine;
  /** 抽屉自己的查看槽——与主槽共用引擎，互不串 */
  view: ChatSession;
  /** 主槽正看着的会话：选择器里排除它（它已经在中间了） */
  mainSessionId: string | null;
  providersError: string | null;
  /** 星标过的模型：抽屉里的输入卡也会开模型卡片，那颗星与主槽同一份状态 */
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
  /** 模型卡片底部「配置模型」→ 设置面的服务商页 */
  onOpenProviders: () => void;
  docked: DockedTab[];
  onDockedChange: (docked: DockedTab[]) => void;
}) {
  const t = useT();
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
  // 没有标签 = 空态，直接出选择器；picking 只服务于「已有标签时点 + 再开一个」
  const showPicker = picking || activeTab === null;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minWidth: 0 }}>
      {hasTabs && (
          <div className="drawer-tabs">
            <div className="drawer-tablist">
              {props.docked.map((tab) => {
                const meta = tab === NEW_TASK_TAB ? null : findMeta(props.engine, tab);
                const title =
                  tab === NEW_TASK_TAB
                    ? t.common.newTask
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
                      title={t.drawer.closeTab}
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
            <button className="drawer-tab-add" title={t.drawer.newTab} onClick={() => setPicking(true)}>
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
              // 空态时没有「回」的地方（身后无标签），返回键就不渲染
              onBack={activeTab === null ? null : () => setPicking(false)}
            />
          ) : (
            // 辅助对话 = 主会话同一个 ChatView：标题头、消息列、输入卡全部同构（Q5/v9）。
            // 还没发过首条消息的新任务用极简首页——欢迎界面是主会话的仪式（wafo 2026-09-12）
            <ChatView
              session={props.view}
              providersError={props.providersError}
              starredModels={props.starredModels}
              onToggleStarModel={props.onToggleStarModel}
              onOpenProviders={props.onOpenProviders}
              homeBare={activeTab === NEW_TASK_TAB && props.view.sessionId === null}
              scrollToEnd
            />
          )}
        </div>
    </div>
  );
}

function findMeta(engine: SessionEngine, id: string): SessionMeta | null {
  return engine.sessions.find((meta) => meta.id === id) ?? null;
}

/**
 * task 选择器（Q7=C）：把另一条 task 并排打开，或当场新建一条。
 * 中间正在看的那条不列——它已经在它该在的位置上。
 * onBack 为 null = 身后没有标签可回（空态直达），返回键不渲染。
 *
 * 右栏统一（2026-10-11）：与其他面板同一副骨架——标题行（图标 + 辅助对话 + 过滤框 +
 * 「?」+ 新建），下面是任务列表；原先铺在列表上方的问句与解释收进「?」。
 */
function Picker(props: {
  sessions: SessionMeta[];
  excludeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onBack: (() => void) | null;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  // 子会话不进选择器（子会话 PR4c 2.3）：它唯一的入口是母会话的右栏 Sub-sessions
  // 面板，并排打开挑的是「另一条 task」，不该在这里意外把某条子会话拽出来单独开
  const candidates = rootSessions(props.sessions).filter((meta) => meta.id !== props.excludeId);
  const q = query.trim().toLowerCase();
  const shown = q === "" ? candidates : candidates.filter((meta) => meta.title.toLowerCase().includes(q));
  const onBack = props.onBack;
  return (
    <RightPanelFrame
      contentKey="drawer-picker"
      header={
        <>
          {onBack !== null && (
            <PanelIconButton title={t.common.back} onClick={onBack}>
              <Icon name="chevron-left" size={16} />
            </PanelIconButton>
          )}
          <PanelTitle icon="panel-right" title={t.drawer.title} />
          <PanelFilter
            value={query}
            onChange={setQuery}
            placeholder={t.drawer.filter}
            count={q === "" ? String(candidates.length) : `${shown.length} / ${candidates.length}`}
          />
        </>
      }
      headerExtra={
        <>
          <PanelHelp label={t.drawer.helpLabel} text={t.drawer.pickSub} />
          <PanelIconButton title={t.common.newTask} onClick={props.onNew}>
            <Icon name="plus" size={16} />
          </PanelIconButton>
        </>
      }
    >
      <div className="panel-list" style={{ paddingTop: "var(--space-2)" }}>
        {shown.map((meta) => (
          <button key={meta.id} className="drawer-pickrow" onClick={() => props.onPick(meta.id)}>
            <Icon name="message-square" size={14} />
            <span className="drawer-pickrow-name">{meta.title}</span>
            <span className="drawer-pickrow-meta row-trailing">{formatWhen(meta.updatedAt, t)}</span>
          </button>
        ))}
        {candidates.length === 0 && <p className="panel-empty">{t.drawer.noOther}</p>}
        {candidates.length > 0 && shown.length === 0 && (
          <p className="panel-empty">{t.skills.noMatch(query.trim())}</p>
        )}
      </div>
    </RightPanelFrame>
  );
}

/** 相对时间的最简口径：侧栏的同款信息，不引入第二个日期库 */
function formatWhen(updatedAt: number, t: Messages): string {
  const minutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60000));
  if (minutes < 1) return t.time.justNow;
  if (minutes < 60) return t.time.minutesAgo(minutes);
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t.time.hoursAgo(hours);
  return t.time.daysAgo(Math.round(hours / 24));
}
