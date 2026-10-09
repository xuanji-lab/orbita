/**
 * 终端面板（PR1：人工终端全链）。右图标条入口 → 右栏共享面板位（RightPanelKind
 * "terminal"），面板内多终端 tab。**面板可以随时拆**：收起 / 切面板 / renderer
 * 刷新都只是视图消失，PTY 与快照缓冲在主进程；重开面板时 terminal:list 收养现存
 * 的 tab，各视图拉 snapshot 续画。真正杀 PTY 的只有两件事：关 tab（×）与关窗口。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { RightPanelFrame } from "../../shell/RightPanel";
import type { TerminalInfo } from "@shared/terminal";
import { TerminalView } from "./TerminalView";
import "./terminal.css";

export function TerminalPanel(props: {
  /** 新终端落在哪个目录（当前会话的工作区根；null = 主进程回退 homedir） */
  cwd: string | null;
  onClose: () => void;
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

  // 面板挂载：收养现存终端（renderer 整页刷新 / 收起再展开都在这条路上）；
  // 一个都没有（首次打开 / 全关过）就自动开一个
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

  // 主进程推送：Panel 只关心退出；输出事件由各 View 自行消费（各自 ack）
  useEffect(() => {
    return api.terminal.onEvent((event) => {
      if (event.type === "exit") exitRef.current(event.terminalId, event.exitCode);
    });
  }, []);

  const allIds = [...tabs.map((tab) => tab.terminalId), ...pendingIds];
  const active = activeId !== null && allIds.includes(activeId) ? activeId : (allIds[allIds.length - 1] ?? null);

  return (
    <RightPanelFrame
      header={
        <>
          <Icon name="square-terminal" size={14} />
          <strong style={{ fontSize: "var(--font-size-body)", fontWeight: 600 }}>{t.terminal.title}</strong>
        </>
      }
      headerExtra={
        <IconButton label={t.terminal.newTerminal} size={26} onClick={openTerminal}>
          <Icon name="plus" size={16} />
        </IconButton>
      }
      contentKey="terminal"
      onClose={props.onClose}
    >
      <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
        {allIds.length > 0 ? (
          <>
            <div className="terminal-tabstrip" role="tablist" aria-label={t.terminal.title}>
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
            <div className="terminal-views">
              {allIds.map((id) => (
                <TerminalView
                  key={id}
                  terminalId={id}
                  cwd={props.cwd}
                  exited={tabs.find((tab) => tab.terminalId === id)?.exited ?? null}
                  active={id === active}
                />
              ))}
            </div>
          </>
        ) : (
          <div className="terminal-empty">
            <IconButton label={t.terminal.newTerminal} size={26} onClick={openTerminal}>
              <Icon name="plus" size={16} />
            </IconButton>
          </div>
        )}
      </div>
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
