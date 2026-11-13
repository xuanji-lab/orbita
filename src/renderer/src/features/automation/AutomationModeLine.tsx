/**
 * 对话里「改权限」那一行：agent 用 automation_update（或 automation_create 带 mode）申请让一条自动化到点能写文件时留下的。
 * **不是卡，不拦路，不等人**——会话是「放行」档：已改好，这一行是「已改成放行 · 到点能写文件　[改回只读]」；
 * 会话是「手动 / 计划」档：agent 不能把自动化调得比会话还宽，没改，这一行是「让它到点能写文件（放行）？　[允许] [保持只读]」，
 * agent 已经结束了这一轮，用户什么时候点都行（数据落在工具结果里，见 shared/automation.ts 的 AutomationModeRow）。
 *
 * 画哪一种**看此刻那条自动化的 mode**，不看落盘时的样子（modeRowView）：用户在面板里改了、点了按钮，行都照实说。
 * 点按钮走 automation:mode-from-row，主进程重验会话与自动化后才改，结果以数据返回；点完行内状态更新，不弹窗。
 * 行的语言与 PluginInstallLine 同一套（一行字 + 行尾血线上的小按钮，没有卡片底），样式复用 plugins.css 的 `.pl-line*`。
 */
import { useEffect, useState } from "react";
import type { AutomationModeRow, AutomationModeRowAction } from "../../../../shared/automation.ts";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { useAutomationUi } from "./automation-context.ts";
import { modeRowFailureText, modeRowView, type ModeRowView } from "./automation-view.ts";
import "../plugins/plugins.css";
import "./automation.css";

const ICON: Record<ModeRowView, "circle-check" | "shield-check" | "circle-off"> = {
  allowed: "circle-check",
  pending: "shield-check",
  kept: "circle-off",
  gone: "circle-off",
};

export function AutomationModeLine(props: {
  row: AutomationModeRow;
  /** 这条会话（点按钮时主进程按它重验）；拿不到就不给点 */
  sessionId: string | null;
}) {
  const t = useT();
  const a = t.automation.modeRow;
  const { row } = props;
  const ui = useAutomationUi();
  const live = ui.automations.find((automation) => automation.id === row.automationId);
  // 列表还没读到：按落盘时的样子画，不闪成「已不存在」
  const derived = modeRowView(row, ui.loaded ? live : null);
  // 点完立刻照点的结果画，等主进程广播、列表重读之后（live 变了）再回到「看此刻」
  const [local, setLocal] = useState<ModeRowView | null>(null);
  const liveKey = `${live?.mode ?? ""}|${(live?.modeDeclined ?? []).join(",")}`;
  useEffect(() => setLocal(null), [liveKey]);
  const view = local ?? derived;
  const [busy, setBusy] = useState<AutomationModeRowAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: AutomationModeRowAction): Promise<void> => {
    if (props.sessionId === null || busy !== null) return;
    setBusy(action);
    setError(null);
    try {
      const result = await api.automation.modeFromRow({
        sessionId: props.sessionId,
        automationId: row.automationId,
        requestId: row.requestId,
        action,
      });
      if (!result.ok) {
        setError(modeRowFailureText(a, result));
        return;
      }
      setLocal(action === "allow" ? "allowed" : "kept");
    } catch (cause) {
      setError(a.failed.failed(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(null);
    }
  };

  const title =
    view === "allowed" ? a.allowedTitle(row.title) : view === "pending" ? a.pendingTitle(row.title) : view === "kept" ? a.keptTitle(row.title) : a.goneTitle(row.title);
  const meta = view === "allowed" ? a.allowedMeta : view === "kept" ? a.keptMeta : "";
  const disabled = busy !== null || props.sessionId === null;

  return (
    <div className="aml" role="group" aria-label={a.aria}>
      <div className="pl-line" data-mode={view === "allowed" || view === "pending" ? "installed" : "uninstalled"}>
        <div className="pl-line-main">
          <Icon name={ICON[view]} size={14} strokeWidth={1.8} className={view === "allowed" ? "pl-line-ic ok" : "pl-line-ic"} />
          <span className="pl-line-text">
            {view === "pending" ? title : <b>{title}</b>}
            {meta !== "" && <span className="pl-line-meta"> · {meta}</span>}
          </span>
          <span className="row-trailing pl-line-acts">
            {view === "pending" && (
              <>
                <button type="button" className="pl-btn btn-accent" disabled={disabled} onClick={() => void act("allow")}>
                  {busy === "allow" ? a.allowing : a.allow}
                </button>
                <button type="button" className="pl-btn" disabled={disabled} onClick={() => void act("keep")}>
                  {a.keep}
                </button>
              </>
            )}
            {view === "allowed" && (
              <button type="button" className="pl-btn" disabled={disabled} onClick={() => void act("readonly")}>
                {busy === "readonly" ? a.reverting : a.revert}
              </button>
            )}
          </span>
        </div>
        {error !== null && (
          <div className="pl-line-error" role="alert">
            <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
            <span>{error}</span>
          </div>
        )}
      </div>
      {view === "pending" && <div className="aml-note">{a.note(t.permissionModes[row.sessionMode].label)}</div>}
    </div>
  );
}
