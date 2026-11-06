/**
 * 插件页里列表与详情共用的小件：头像、开关、能力行。
 */
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import type { PluginMcpInfo, PluginSkillInfo, PluginUnsupported, PluginView } from "@shared/plugin";
import type { PluginExternal } from "@shared/plugin-board";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { mcpProblemText } from "./plugin-text.ts";

/** 头像按种类取类别色 + 图标：技能是绿书、MCP 是蓝插头、插件（含草稿）是橙积木。 */
export function PluginAvatar(props: { view: Pick<PluginView, "origin">; big?: boolean }) {
  const { view } = props;
  const size = props.big === true ? 20 : 13;
  const kind = view.origin === "user-skill" ? "skill" : view.origin === "user-mcp" ? "mcp" : "plugin";
  return (
    <span className={`pl-av${props.big === true ? " big" : ""}`} data-kind={kind} aria-hidden="true">
      <Icon name={kind === "skill" ? "book-open" : kind === "mcp" ? "plug" : FEATURE_ICON.plugins} size={size} strokeWidth={1.8} />
    </span>
  );
}

/** 开关：设计稿 v2 的 switch（设计系统没有 Switch 配方，样式在 plugins.css，状态走 aria-checked）。 */
export function PluginSwitch(props: { checked: boolean; label: string; disabled?: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      className="pl-switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onChange}
    />
  );
}

/** 「它能做什么」里的一行：种类 / 名字 + 说明 / 用不了的原因。 */
function AbilityRow(props: { kind: string; children: React.ReactNode; warn?: string | null }) {
  return (
    <div className="pl-ab">
      <span className="pl-ab-kind">{props.kind}</span>
      <div className="pl-ab-body">{props.children}</div>
      {props.warn !== undefined && props.warn !== null && (
        <span className="pl-warn">
          <Icon name="info" size={12} strokeWidth={1.8} />
          {props.warn}
        </span>
      )}
    </div>
  );
}

export function SkillAbility(props: { skill: PluginSkillInfo }) {
  const t = useT().plugins;
  return (
    <AbilityRow kind={t.kindSkill}>
      <b>{props.skill.name}</b>
      {/* 描述原文常常很长（pdf 技能有十行）：卡里只留三行，全文在 title 里 */}
      <small className="clamp" title={props.skill.description}>
        {props.skill.description}
      </small>
    </AbilityRow>
  );
}

export function McpAbility(props: { server: PluginMcpInfo; /** 插件自带 MCP 的状态与工具（只读，跟着插件启停） */ runtime?: React.ReactNode }) {
  const t = useT().plugins;
  const { server } = props;
  return (
    <AbilityRow kind={t.kindMcp} warn={server.problem === null ? null : mcpProblemText(t, server.problem)}>
      <b>{server.name}</b>
      {/* 模型看到的服务名（工具叫 mcp__<它>__<工具>，/mcp: 点名也用它）；旧 MCP 两者相同不重复 */}
      {server.qualified !== server.name && <small className="mono">{server.qualified}</small>}
      {server.commandLine !== "" && (
        <code>
          {server.transport === "http" ? `${t.mcpHttp} ` : ""}
          {server.commandLine}
        </code>
      )}
      {props.runtime}
    </AbilityRow>
  );
}

export function ScriptsAbility() {
  const t = useT().plugins;
  return (
    <AbilityRow kind={t.kindScripts}>
      <small>{t.scriptsNote}</small>
    </AbilityRow>
  );
}

export function UnsupportedAbility(props: { entry: PluginUnsupported }) {
  const t = useT().plugins;
  const { entry } = props;
  const text = t.unsupported[entry.kind];
  const more = entry.count - entry.items.length;
  return (
    <AbilityRow kind={text.label} warn={text.reason}>
      {entry.items.length > 0 && (
        <small>
          {entry.items.join(", ")}
          {more > 0 ? ` ${t.moreItems(more)}` : ""}
        </small>
      )}
    </AbilityRow>
  );
}

/** 「外接」一行：外部服务 / 命令行的名字 + 种类，下面一句要不要账号、会不会常驻、插件自己的备注。 */
export function ExternalAbility(props: { items: readonly PluginExternal[] }) {
  const t = useT().plugins;
  return (
    <AbilityRow kind={t.kindExternal}>
      <span className="pl-ext">
        {props.items.map((item, index) => (
          <span key={index} className="pl-tag" title={t.externalKinds[item.kind]}>
            <Icon name={item.kind === "cli" ? "terminal" : item.kind === "mcp" ? "plug" : "globe"} size={11} strokeWidth={1.8} />
            {item.name}
          </span>
        ))}
      </span>
      {props.items.map((item, index) => {
        const facts = [
          item.account === null ? null : item.account ? t.externalAccountYes : t.externalAccountNo,
          item.resident === null ? null : item.resident ? t.externalResidentYes : t.externalResidentNo,
          item.note,
        ].filter((part): part is string => part !== null);
        return facts.length === 0 ? null : (
          <small key={index}>
            {props.items.length > 1 ? `${item.name}：` : ""}
            {facts.join(" · ")}
          </small>
        );
      })}
    </AbilityRow>
  );
}
