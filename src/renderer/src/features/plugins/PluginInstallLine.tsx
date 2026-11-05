/**
 * 对话里「装上插件」那一行：agent 的 install_plugin 留下的。**不是卡，不拦路，不等人**——
 * 低风险的直接装了，这一行是「已装上 X · [卸载]」；带 MCP（会在本机启动程序）/ 范围是所有工作区 /
 * manual 档的没装，这一行是「装上 X　[安装] [看详情]」，agent 已经结束了这一轮，用户什么时候点都行
 * （关掉会话、隔几天再开都在——数据落在工具结果里，见 shared/plugin.ts 的 PluginInstallRow）。
 *
 * 画哪一种**看此刻的已装列表**，不看这一行落盘时的样子：点了「安装」、在别处装了、后来卸载了，
 * 这一行都照实说。行的语言是对话里已有的行 / chip 语言：一行字 + 行尾血线上的小按钮，没有卡片底。
 */
import { useState } from "react";
import type { PluginInstallRow } from "@shared/plugin";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { refreshInstalledPlugins, useInstalledPluginNames } from "./installed-plugins.ts";
import { rowFailureText, rowMode, rowReasonText, rowScopeText, rowSkillsText } from "./plugin-text.ts";
import "./plugins.css";

export function PluginInstallLine(props: {
  row: PluginInstallRow;
  /** 这条会话（点「安装」时主进程按它重验工作区）；拿不到就不给装 */
  sessionId: string | null;
}) {
  const t = useT().plugins.row;
  const { row } = props;
  const names = useInstalledPluginNames();
  const mode = rowMode(row, names === null ? undefined : names.has(row.name));
  const [busy, setBusy] = useState<"install" | "uninstall" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const install = async (): Promise<void> => {
    if (props.sessionId === null || busy !== null) return;
    setBusy("install");
    setError(null);
    try {
      const result = await api.plugin.installFromRow({
        sessionId: props.sessionId,
        path: row.path,
        scope: row.scope,
        fingerprint: row.fingerprint,
      });
      if (!result.ok) {
        setError(rowFailureText(t, result.reason, result.detail));
        return;
      }
      // 主进程装好后会广播 pluginsChanged；这里再等一次重读，行不闪回「安装」
      await refreshInstalledPlugins();
    } catch (cause) {
      setError(t.failed.failed(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async (): Promise<void> => {
    if (busy !== null) return;
    setBusy("uninstall");
    setError(null);
    try {
      await api.plugin.uninstall(row.name);
      await refreshInstalledPlugins();
    } catch (cause) {
      setError(t.failed.uninstall(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(null);
    }
  };

  const title =
    mode === "installed" ? t.installedTitle(row.displayName) : mode === "uninstalled" ? t.uninstalledTitle(row.displayName) : t.pendingTitle(row.displayName);
  const meta = [rowSkillsText(t, row), rowScopeText(t, row)].filter((part) => part !== "").join(" · ");
  const reason = mode === "pending" ? rowReasonText(t, row) : "";

  return (
    <div className="pl-line" data-mode={mode} role="group" aria-label={t.aria}>
      <div className="pl-line-main">
        <Icon
          name={mode === "installed" ? "circle-check" : mode === "uninstalled" ? "circle-off" : "blocks"}
          size={14}
          strokeWidth={1.8}
          className={mode === "installed" ? "pl-line-ic ok" : "pl-line-ic"}
        />
        <span className="pl-line-text">
          <b>{title}</b>
          {meta !== "" && <span className="pl-line-meta"> · {meta}</span>}
        </span>
        <span className="row-trailing pl-line-acts">
          {mode === "pending" && (
            <>
              <button type="button" className="pl-btn btn-accent" disabled={busy !== null || props.sessionId === null} onClick={() => void install()}>
                {busy === "install" ? t.installing : t.install}
              </button>
              <button type="button" className="pl-btn" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
                {open ? t.hideDetails : t.details}
              </button>
            </>
          )}
          {mode === "installed" && (
            <button type="button" className="pl-btn" disabled={busy !== null} onClick={() => void uninstall()}>
              {t.uninstall}
            </button>
          )}
          {mode === "uninstalled" && (
            <button type="button" className="pl-btn" disabled={busy !== null || props.sessionId === null} onClick={() => void install()}>
              {busy === "install" ? t.installing : t.reinstall}
            </button>
          )}
        </span>
      </div>
      {mode === "pending" && row.commands.length > 0 && (
        <div className="pl-line-cmds">
          <span className="pl-line-cmds-h">{t.willRun}</span>
          {row.commands.map((command, index) => (
            <code key={index}>{command}</code>
          ))}
        </div>
      )}
      {mode === "pending" && reason !== "" && <div className="pl-line-note">{reason}</div>}
      {mode === "pending" && open && (
        <dl className="pl-kv pl-line-detail">
          <dt>{t.folder}</dt>
          <dd className="mono">{row.path}</dd>
        </dl>
      )}
      {mode === "pending" && open && <div className="pl-line-note">{row.commands.length === 0 ? `${t.commandsNone} ` : ""}{t.linkNote}</div>}
      {error !== null && (
        <div className="pl-line-error" role="alert">
          <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
