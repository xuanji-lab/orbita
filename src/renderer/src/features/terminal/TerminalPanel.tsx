/**
 * 终端面板（PR1：人工终端全链；PR2：agent 开的终端也住在这里）。右图标条入口 →
 * 右栏共享面板位（RightPanelKind "terminal"），面板内多终端 tab。**面板可以随时拆**：
 * 收起 / 切面板 / renderer 刷新都只是视图消失，PTY 与快照缓冲在主进程；重开面板时
 * terminal:list 收养现存的 tab，各视图拉 snapshot 续画。真正杀 PTY 的只有两件事：
 * 关 tab（×）与关窗口。
 *
 * ⚠ agent 终端的收养是**硬要求**不是体验优化：没有视图就没有 ack，runtime 的输出
 * 背压会把那个终端永久卡在第 1 批（见下面那个 effect 的注释）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import type { TerminalDock } from "@shared/settings";
import type { TerminalInfo } from "@shared/terminal";
import { TerminalView } from "./TerminalView";
import { activeTerminalId, mergeTerminals } from "./terminal-tabs.ts";
import { terminalHeaderIsTitlebar } from "../../shell/terminal-dock.ts";
import "./terminal.css";

export function TerminalPanel(props: {
  /** 新终端落在哪个目录（当前会话的工作区根；null = 主进程回退 homedir） */
  cwd: string | null;
  /**
   * agent 刚开的终端 id（App 从 terminal:agent-open 事件转来）：面板要点亮并**激活
   * 这个 tab**——agent 在用户眼前干活，人一抬头就看见它，而不是要去 tab 条里翻。
   * 一次性信号：消费完调 onActivated 清掉。
   */
  activateId: string | null;
  onActivated: () => void;
  /**
   * 停靠位（右侧 = 右栏面板位；底部 = 横跨对话区下方，不占右栏位）。标题行右侧
   * 的二选一分段开关（panel-right / panel-bottom）显示与扳动都走这两个 props，
   * 落设置与「终端搬家」由 App 编排（moveDockTo）。
   */
  dock: TerminalDock;
  onDockChange: (dock: TerminalDock) => void;
}) {
  const t = useT();
  /** 现存终端（创建顺序即 tab 顺序）；pendingIds 是视图还在创建中的（info 未回） */
  const [tabs, setTabs] = useState<TerminalInfo[]>([]);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  /**
   * 选中的 tab。null = 「落最后一个」：关掉当前 tab 后自然落到余下最后一个，
   * 不必在 setState 的 updater 里读列表（StrictMode 双跑不安全）。
   */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** 退出事件落到 tab 状态（标题降级 + 视图提示）。ref 活过 effect 重跑 */
  const exitRef = useRef<(terminalId: string, exitCode: number) => void>(() => undefined);
  exitRef.current = (terminalId, exitCode) => {
    setTabs((current) =>
      current.map((tab) => (tab.terminalId === terminalId ? { ...tab, exited: exitCode } : tab)),
    );
  };

  const openTerminal = useCallback((): void => {
    // id 由 renderer 铸（契约注释）：create 幂等，重挂载重复 create 不开第二个 PTY
    const terminalId = crypto.randomUUID();
    setPendingIds((current) => [...current, terminalId]);
    setActiveId(terminalId);
  }, []);

  const closeTerminal = useCallback((terminalId: string): void => {
    // 杀PTY只有这一个入口。tab 若还在创建途中，主进程的 cancelledCreates 会在
    // created 回来后补杀——视图与面板先各自退场
    void api.terminal.kill(terminalId).catch(() => undefined);
    setTabs((current) => current.filter((tab) => tab.terminalId !== terminalId));
    setPendingIds((current) => current.filter((id) => id !== terminalId));
    setActiveId((active) => (active === terminalId ? null : active));
  }, []);

  /**
   * 视图报 create 回来：转圈 tab → 真 tab（标题 / shell / 可关）。之前没有这一步，
   * 「+」新开的 tab 永远停在转圈、也没有 ×，只有整页刷新后靠 list 收养才变回来。
   * 已在 tabs 里（收养来的 tab 重挂载也会走 create）只更新不重复。
   */
  const promoteTerminal = useCallback((info: TerminalInfo): void => {
    setPendingIds((current) => current.filter((id) => id !== info.terminalId));
    setTabs((current) =>
      current.some((tab) => tab.terminalId === info.terminalId)
        ? current
        : [...current, info],
    );
  }, []);

  // 面板挂载：收养现存终端（renderer 整页刷新 / 收起再展开都在这条路上）；
  // 一个都没有（首次打开 / 全关过）就自动开一个。**挂载后不重拉列表**——运行期的
  // 新终端有两条明确来路：本面板的动作（pendingIds）与 agent-open 事件（下面收养）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await api.terminal.list();
        if (cancelled) return;
        setTabs(existing);
        if (existing.length === 0) openTerminal();
      } catch {
        if (!cancelled) openTerminal();
      }
    })();
    // 运行期不重拉 list：新 tab 只由本面板的动作产生，exit 由 exitRef 兜住
    return () => {
      cancelled = true;
    };
  }, [openTerminal]);

  // 主进程推送：Panel 只关心退出与「agent 开了新终端」；输出事件由各 View 自行
  // 消费（各自 ack）
  useEffect(() => {
    return api.terminal.onEvent((event) => {
      if (event.type === "exit") {
        exitRef.current(event.terminalId, event.exitCode);
        return;
      }
      if (event.type === "agent-open") setTabs((current) => mergeTerminals(current, [event.terminal]));
    });
  }, []);

  // agent 开的终端：激活它。list 可能还没回来（面板刚挂载），activeId 先记着——
  // 下面的 `active` 只在 id 真在列表里时才认它，list 一到就自然落在那个 tab 上
  useEffect(() => {
    if (props.activateId === null) return;
    setActiveId(props.activateId);
    props.onActivated();
  }, [props.activateId, props.onActivated]);

  /**
   * **收养 agent 开的终端**（PR2 线上故障的根因，2026-10-10）。
   *
   * 面板的 tabs 是挂载时的一次性快照，而 agent 随时能开新终端。不收养的后果不是
   * 「少一个 tab」：那个终端没有 xterm 视图 → 没有人给主进程回 ack → runtime 的
   * 输出背压把它永久卡在第 1 批 → 主进程的重放缓冲不再增长 → agent 的
   * `terminal_read` 永远读到空，而命令其实早就跑完了。现象是「execute 报成功但
   * 命令从未落进 PTY」，且只在面板已经开着时出现（关着的时候 agent-open 会先把
   * 面板挂起来，挂载时的 list 自然收养——这就是它表现为间歇性的原因）。
   *
   * 事件里带上了刚建成的 `terminal` 全文，所以这是**精确加法**：不必再拉一次 list
   * （那条路上的旧清单会把用户刚关掉的 tab 复活），也不会漏。
   */

  const allIds = [...tabs.map((tab) => tab.terminalId), ...pendingIds];
  const active = activeTerminalId(allIds, activeId);

  return (
    <RightPanelFrame
      header={
        <>
          <PanelTitle icon="square-terminal" title={t.terminal.title} />
          {/* 终端标签住在标题行中段（右栏统一方案 B：没有第二条工具行） */}
          {allIds.length > 0 && (
            <div className="terminal-tabstrip panel-head-grow no-drag" role="tablist" aria-label={t.terminal.title}>
              {tabs.map((tab) => (
                <TabButton
                  key={tab.terminalId}
                  label={tab.title === "" ? tab.shell : tab.title}
                  shell={tab.shell}
                  exited={tab.exited}
                  active={tab.terminalId === active}
                  onSelect={() => setActiveId(tab.terminalId)}
                  onClose={() => closeTerminal(tab.terminalId)}
                  closeLabel={t.terminal.closeTab}
                />
              ))}
              {pendingIds.map((id) => (
                <span key={id} className="quiet-control terminal-tab" title={t.terminal.newTerminal}>
                  <Icon name="loader-circle" size={12} spin />
                </span>
              ))}
            </div>
          )}
        </>
      }
      headerExtra={
        <>
          {/* 停靠位分段开关：两个安静按钮（mg-seg 同款配方），按下的那个 mode 底 */}
          <span className="terminal-dock-seg no-drag" role="group" aria-label={t.terminal.dockPosition}>
            <button
              type="button"
              className="quiet-control terminal-dock-seg-btn"
              aria-pressed={props.dock === "right"}
              aria-label={t.terminal.dockRight}
              title={t.terminal.dockRight}
              onClick={() => props.onDockChange("right")}
            >
              <Icon name="panel-right" size={13} />
            </button>
            <button
              type="button"
              className="quiet-control terminal-dock-seg-btn"
              aria-pressed={props.dock === "bottom"}
              aria-label={t.terminal.dockBottom}
              title={t.terminal.dockBottom}
              onClick={() => props.onDockChange("bottom")}
            >
              <Icon name="panel-bottom" size={13} />
            </button>
          </span>
          <IconButton label={t.terminal.newTerminal} size={26} onClick={openTerminal} className="no-drag">
            <Icon name="plus" size={16} />
          </IconButton>
        </>
      }
      contentKey="terminal"
      titlebar={terminalHeaderIsTitlebar(props.dock)}
    >
      {allIds.length > 0 ? (
        <div className="terminal-views" style={{ height: "100%" }}>
          {allIds.map((id) => (
            <TerminalView
              key={id}
              terminalId={id}
              cwd={props.cwd}
              exited={tabs.find((tab) => tab.terminalId === id)?.exited ?? null}
              active={id === active}
              onCreated={promoteTerminal}
            />
          ))}
        </div>
      ) : (
        // 空态：一行浅灰字（右栏统一），新建在标题行的 +
        <p className="panel-empty" style={{ paddingTop: "var(--space-3)" }}>
          {t.terminal.empty}
        </p>
      )}
    </RightPanelFrame>
  );
}

/** tab：安静控件配方 + tab 形状（terminal.css）。关闭键 hover / 选中才浮现 */
function TabButton(props: {
  label: string;
  shell: string;
  exited: number | null;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <span
      className={`quiet-control terminal-tab${props.exited !== null ? " is-exited" : ""}`}
      role="tab"
      aria-selected={props.active}
      title={`${props.label} · ${props.shell}`}
      onClick={props.onSelect}
      style={{ cursor: "pointer" }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{props.label}</span>
      <button
        type="button"
        className="terminal-tab-close"
        aria-label={props.closeLabel}
        title={props.closeLabel}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose();
        }}
      >
        <Icon name="x" size={10} />
      </button>
    </span>
  );
}
