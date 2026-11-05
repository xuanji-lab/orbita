/**
 * 对话里的插件安装确认卡：agent 的 install_plugin 弹它，用户点「安装」才装。
 *
 * 与审批条同位同配方（浮在输入框上方的玻璃卡，比聊天面高一层，要一个回答才继续），
 * 内容与「接入本地插件」的确认单同一套事实：它带了什么、MCP 在本机启动的**完整命令行**、
 * 会请你填什么、暂不支持什么、启用在哪。键盘优先：打开即聚焦「安装」，Enter 安装、Esc 不装。
 * 清单里有问题 / 重名 / workflow 对不上的，主进程在弹卡之前就退回给 agent 了，卡上不会有。
 */
import { useEffect, useRef, useState } from "react";
import type { AgentEvent } from "@shared/agent-ipc";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { McpAbility, ScriptsAbility, SkillAbility, UnsupportedAbility } from "./PluginParts.tsx";
import "./plugins.css";

export function PluginInstallCard(props: {
  ask: Extract<AgentEvent, { type: "pluginInstallAsk" }>;
  onAnswer: (requestId: string, approve: boolean) => void;
}) {
  const t = useT().plugins;
  const { ask } = props;
  const { preview } = ask;
  const [answered, setAnswered] = useState(false);
  const installRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setAnswered(false);
    installRef.current?.focus();
  }, [ask.requestId]);

  const answer = (approve: boolean): void => {
    if (answered) return;
    setAnswered(true);
    props.onAnswer(ask.requestId, approve);
  };

  const scopeLine =
    ask.scope === "global"
      ? t.ask.scopeGlobal
      : ask.workspaceName === null
        ? t.ask.scopeWorkspaceUnknown
        : t.ask.scopeWorkspace(ask.workspaceName);

  return (
    <section
      className="glass-card glass-float pl-ask"
      aria-label={t.ask.aria}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          answer(false);
        }
      }}
    >
      <div className="pl-ask-head">
        <Icon name="blocks" size={14} strokeWidth={1.8} />
        <strong>{t.ask.title(preview.displayName)}</strong>
        <span className="pl-ask-keys">{t.ask.keys}</span>
      </div>

      <div className="pl-ask-body">
        <span className="pl-field-hint">{t.ask.intro}</span>
        {preview.description !== "" && <div className="pl-ask-desc">{preview.description}</div>}
        <dl className="pl-kv">
          <dt>{t.kvSource}</dt>
          <dd className="mono">{preview.root}</dd>
          <dt>{t.scopeTitle}</dt>
          <dd>{scopeLine}</dd>
        </dl>
        <span className="pl-field-hint">{t.ask.linkNote}</span>

        <section className="pl-section">
          <div className="pl-section-h">{t.install.bringsTitle}</div>
          <div className="pl-box">
            {preview.skills.map((skill) => (
              <SkillAbility key={skill.slug} skill={skill} />
            ))}
            {preview.hasScripts && <ScriptsAbility />}
            {preview.skills.length === 0 && !preview.hasScripts && <span className="pl-muted">{t.abilitiesEmpty}</span>}
          </div>
        </section>

        {preview.workflow.length > 0 && (
          <section className="pl-section">
            <div className="pl-section-h">{t.ask.workflowTitle}</div>
            <ol className="pl-ask-steps">
              {preview.workflow.map((step, index) => (
                <li key={index}>
                  <b>{step.title}</b>
                  {step.skill !== null && <small className="mono">{step.skill}</small>}
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="pl-section">
          <div className="pl-section-h">{t.ask.commandsTitle}</div>
          {preview.mcp.length === 0 ? (
            <span className="pl-muted">{t.ask.commandsNone}</span>
          ) : (
            <>
              <div className="pl-box">
                {preview.mcp.map((server) => (
                  <McpAbility key={server.name} server={server} />
                ))}
              </div>
              <span className="pl-field-hint">{t.ask.commandsNote}</span>
            </>
          )}
        </section>

        {preview.config.length > 0 && (
          <section className="pl-section">
            <div className="pl-section-h">{t.install.configTitle}</div>
            <ul className="pl-list">
              {preview.config.map((field) => (
                <li key={field.key}>
                  <b>{field.title}</b>
                  {field.required ? ` · ${t.configRequired}` : ""}
                </li>
              ))}
            </ul>
          </section>
        )}

        {preview.unsupported.length > 0 && (
          <section className="pl-section">
            <div className="pl-section-h">{t.install.unsupportedTitle}</div>
            <div className="pl-box">
              {preview.unsupported.map((entry) => (
                <UnsupportedAbility key={entry.kind} entry={entry} />
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="pl-ask-foot">
        <button ref={installRef} type="button" className="pl-btn btn-accent" disabled={answered} onClick={() => answer(true)}>
          {answered ? t.ask.installing : t.ask.install}
        </button>
        <button type="button" className="pl-btn" disabled={answered} onClick={() => answer(false)}>
          {t.ask.decline}
        </button>
      </div>
    </section>
  );
}
