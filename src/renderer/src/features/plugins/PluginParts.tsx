/**
 * 插件页里列表与详情共用的小件：头像、开关、能力行。
 */
import type { PluginMcpInfo, PluginSkillInfo, PluginUnsupported, PluginView } from "@shared/plugin";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { mcpProblemText } from "./plugin-text.ts";
import { initialOf } from "./plugin-view.ts";

/** 有图标用图标，没有就用名字首字（设计稿同款降级）：技能是书、MCP 是插头，真插件是首字。 */
export function PluginAvatar(props: { view: Pick<PluginView, "origin" | "name">; big?: boolean }) {
  const { view } = props;
  const size = props.big === true ? 20 : 13;
  return (
    <span
      className={`pl-av${props.big === true ? " big" : ""}`}
      data-kind={view.origin === "user-skill" ? "skill" : view.origin === "user-mcp" ? "mcp" : undefined}
      aria-hidden="true"
    >
      {view.origin === "user-skill" ? (
        <Icon name="book-open" size={size} strokeWidth={1.8} />
      ) : view.origin === "user-mcp" ? (
        <Icon name="plug" size={size} strokeWidth={1.8} />
      ) : (
        <b>{initialOf(view.name)}</b>
      )}
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
      <small>{props.skill.description}</small>
    </AbilityRow>
  );
}

export function McpAbility(props: { server: PluginMcpInfo }) {
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
