/**
 * 插件详情页里的两块：「面板」（标题、模板路径、替换后的数据路径、在右栏打开）与「最近产出」
 * （数据文件与面板动作记录的最后修改时间、条数）。插件没声明面板时两块都不出现。
 * 解析问题不在这里列——并进详情页原有的「问题」卡（PluginDetail），一处看全。
 */
import { useMemo } from "react";
import type { PluginPanelInfo } from "@shared/plugin-panel";
import { PANEL_DATA_MAX_BYTES } from "@shared/plugin-panel";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { dataProblemText, formatBytes } from "./panel-view.ts";

export function PluginPanelCards(props: { info: PluginPanelInfo; onOpen: () => void }) {
  const messages = useT();
  const t = messages.pluginPanel;
  // 按界面语言（<html lang>）格式化，不按系统区域：中文界面不该冒出「03:41 PM」
  const WHEN = useMemo(
    () => new Intl.DateTimeFormat(document.documentElement.lang || undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }),
    [messages],
  );
  const { info } = props;
  const data = info.data;
  return (
    <>
      <section className="pl-card">
        <div className="pl-card-h">
          {t.detailTitle}
          <span className="hint">{t.detailHint}</span>
        </div>
        <dl className="pl-kv wide">
          {info.title !== "" && (
            <>
              <dt>{t.kvTitle}</dt>
              <dd>{info.title}</dd>
            </>
          )}
          {info.template !== "" && (
            <>
              <dt>{t.kvTemplate}</dt>
              <dd className="mono">{info.template}</dd>
            </>
          )}
          {info.dataRaw !== "" && (
            <>
              <dt>{t.kvData}</dt>
              <dd className="mono" title={info.dataRaw}>
                {info.dataPath ?? info.dataRaw}
              </dd>
            </>
          )}
        </dl>
        <div className="pl-panel-open">
          <button type="button" className="pl-btn" disabled={!info.openable} onClick={props.onOpen}>
            <Icon name="panel-right" size={13} strokeWidth={1.8} />
            {t.openInRail}
          </button>
          {!info.openable && info.problems.length === 0 && <span className="pl-muted">{t.notEnabledHere}</span>}
        </div>
      </section>

      <section className="pl-card">
        <div className="pl-card-h">{t.recentTitle}</div>
        <dl className="pl-kv wide">
          <dt>{t.recentData}</dt>
          <dd>
            {data === null ? (
              <span className="pl-muted">{t.recentNone}</span>
            ) : data.problem !== null ? (
              <span className="pl-warn">{dataProblemText(t, data.problem, PANEL_DATA_MAX_BYTES)}</span>
            ) : data.exists && data.updatedAt !== null ? (
              <span>
                {t.recentWhen(WHEN.format(data.updatedAt))}
                {data.items !== null && ` · ${t.recentCount(data.items)}`}
                {data.bytes !== null && ` · ${formatBytes(data.bytes)}`}
              </span>
            ) : (
              <span className="pl-muted">{t.recentNone}</span>
            )}
          </dd>
          <dt>{t.recentActions}</dt>
          <dd>
            {info.actions.updatedAt === null ? (
              <span className="pl-muted">{t.recentNone}</span>
            ) : (
              <span>
                {t.recentWhen(WHEN.format(info.actions.updatedAt))}
                {info.actions.count !== null && ` · ${t.recentCount(info.actions.count)}`}
              </span>
            )}
          </dd>
        </dl>
        <span className="pl-muted">{t.recentActionsHint}</span>
      </section>
    </>
  );
}
