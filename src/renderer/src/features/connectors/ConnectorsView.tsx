/**
 * 能力页的「连接」页签：10 家待配置的品牌入口。
 * 宽档（设置 › 能力，容器 ≥ 640px）是两列卡片墙，窄档（右栏、被挤窄的设置页）退成安静列表——
 * 哪棵显示由 plugins.css 的 `@container pl` 定，JS 不量宽度（同「已装」页）。
 * 状态一律来自主进程实测；「配置」要么开一条新会话让智能体带着接（命令行 / 引导型），
 * 要么就在卡内贴 token（远程 MCP 类）。即将支持的没有按钮。
 */
import { useState } from "react";
import "./connectors.css";
import { CONNECTORS, connectorSetupPrompt, type ConnectorEntry, type ConnectorId, type ConnectorSaveResult, type ConnectorVia } from "@shared/connectors";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { Icon } from "../../shell/Icon";
import { ConnectorLogo } from "./ConnectorLogo.tsx";
import {
  actionOf,
  configureRoute,
  filterConnectors,
  manageRoute,
  phaseOf,
  rowSubline,
  statusLine,
  textOf,
  tokenProblemText,
  type ActionModel,
  type ProbeState,
} from "./connectors-view.ts";
import type { ConnectorStates } from "./useConnectors.ts";

export interface ConnectorsViewProps {
  /** 外壳：右栏只有列表；设置页同时带卡片墙与列表（宽窄由容器查询选） */
  chrome: "rail" | "page";
  locale: "zh" | "en";
  states: ConnectorStates;
  query: string;
  onRecheck: () => void;
  /** 命令行 / 引导型的「配置」「管理」：新开会话并预填这句话（App 接到会话引擎上） */
  onStartSession: (draft: string) => void;
  /** 远程 MCP 类连上之后的「管理」：切到「已装」页签 */
  onShowInstalled: () => void;
  saveToken: (id: ConnectorId, token: string) => Promise<ConnectorSaveResult>;
}

function ViaTag(props: { via: ConnectorVia; t: Messages["connectors"] }) {
  const { via, t } = props;
  switch (via.kind) {
    case "cli":
      return (
        <span className="pl-tag cn-via">
          <Icon name="terminal" size={12} strokeWidth={1.8} />
          {via.command}
        </span>
      );
    case "cli-builtin":
      return (
        <span className="pl-tag cn-via plain">
          <Icon name="terminal" size={12} strokeWidth={1.8} />
          {t.via.cliBuiltin}
        </span>
      );
    case "mcp":
      return (
        <span className="pl-tag cn-via plain">
          <Icon name="plug" size={12} strokeWidth={1.8} />
          {t.via.mcp}
        </span>
      );
    case "token":
      return (
        <span className="pl-tag cn-via plain">
          <Icon name="key" size={12} strokeWidth={1.8} />
          {via.bearer ? t.via.bearer : t.via.token}
        </span>
      );
    case "skill":
      return (
        <span className="pl-tag cn-via plain">
          <Icon name="book-open" size={12} strokeWidth={1.8} />
          {t.via.skill}
        </span>
      );
    case "oauth":
      return (
        <span className="pl-tag cn-via plain">
          <Icon name="lock" size={12} strokeWidth={1.8} />
          {t.via.oauth}
        </span>
      );
  }
}

/** 状态：图标 + 文字（颜色是第二信号） */
function Status(props: { entry: ConnectorEntry; state: ProbeState; small?: boolean; inlineNote?: boolean }) {
  const t = useT().connectors;
  const line = statusLine(t, props.entry, props.state);
  const phase = phaseOf(props.state);
  return (
    <span className={`cn-status${props.small === true ? " sm" : ""}`} data-kind={phase} title={props.state.kind === "failed" ? props.state.message : undefined}>
      <Icon name={line.icon} size={props.small === true ? 12 : 14} strokeWidth={1.8} spin={phase === "checking"} />
      <span>{line.text}</span>
      {props.inlineNote !== false && line.note !== "" && <span className="cn-status-note">{line.note}</span>}
    </span>
  );
}

function ActionButton(props: { action: ActionModel; onClick: () => void }) {
  const t = useT().connectors;
  return (
    <button type="button" className="pl-btn" disabled={props.action.disabled} title={props.action.tip} onClick={props.onClick}>
      {t.action[props.action.kind]}
    </button>
  );
}

/** 卡内 / 行下的 token 输入。保存 = 写 mcp.json 并真连一次；失败的话字段留着、错误就地说。 */
function TokenField(props: { entry: ConnectorEntry; onSave: (token: string) => Promise<ConnectorSaveResult>; onCancel: () => void }) {
  const t = useT().connectors;
  const text = textOf(t, props.entry.id);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await props.onSave(value);
    setBusy(false);
    if (!result.ok) {
      setError(tokenProblemText(t.token, result.code, result.message));
      return;
    }
    // 写进去了：连得上就收起；连不上字段留着让用户改，卡片状态已经是「连接失败」
    if (result.status.kind === "failed") setError(t.token.savedFailed(result.status.code === "timeout" ? t.failedTimeout : result.status.message));
    else props.onCancel();
  };
  return (
    <div className="pl-field cn-edit">
      <label className="pl-field-label" htmlFor={`cn-token-${props.entry.id}`}>
        {t.token.label}
      </label>
      <input
        id={`cn-token-${props.entry.id}`}
        className="text-field"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        disabled={busy}
        placeholder={t.token.placeholder(text.name)}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && !busy) void save();
          else if (event.key === "Escape") props.onCancel();
        }}
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
      />
      {error !== null ? (
        <span className="pl-field-error" role="alert">
          {error}
        </span>
      ) : (
        <span className="pl-field-hint">{[text.tokenHint, t.token.stored].filter((part): part is string => part !== undefined).join(" ")}</span>
      )}
      <div className="cn-actions row-trailing">
        <button type="button" className="pl-btn" disabled={busy} onClick={props.onCancel}>
          {t.token.cancel}
        </button>
        <button type="button" className="pl-btn btn-accent" disabled={busy || value.trim() === ""} onClick={() => void save()}>
          {busy ? t.token.checking : t.token.saveAndCheck}
        </button>
      </div>
    </div>
  );
}

export function ConnectorsView(props: ConnectorsViewProps) {
  const t = useT().connectors;
  const [editing, setEditing] = useState<ConnectorId | null>(null);
  const entries = filterConnectors(t, CONNECTORS, props.query);

  /** 点按钮：按条目与状态决定去哪 */
  const act = (entry: ConnectorEntry, action: ActionModel): void => {
    const state = props.states[entry.id];
    const name = textOf(t, entry.id).name;
    if (action.kind === "manage") {
      if (manageRoute(entry, state) === "installed") props.onShowInstalled();
      else props.onStartSession(connectorSetupPrompt(entry, name, props.locale, "manage"));
      return;
    }
    if (configureRoute(entry) === "token") setEditing(entry.id);
    else props.onStartSession(connectorSetupPrompt(entry, name, props.locale, "setup"));
  };

  const save = (entry: ConnectorEntry) => (token: string) => props.saveToken(entry.id, token);

  const cards = entries.map((entry) => {
    const state = props.states[entry.id];
    const text = textOf(t, entry.id);
    const action = actionOf(t, entry, state);
    const open = editing === entry.id;
    return (
      <article key={entry.id} className="pv-vcard cn-card" data-phase={phaseOf(state)} aria-label={text.name}>
        <div className="cn-card-main">
          <ConnectorLogo entry={entry} size="big" />
          <div className="cn-card-text">
            <span className="pv-vcard-name">{text.name}</span>
            <span className="pv-vcard-note pl-vcard-note">{text.desc}</span>
          </div>
        </div>
        <div className="cn-chips">
          {entry.via.map((via) => (
            <ViaTag key={via.kind === "cli" ? `cli:${via.command}` : via.kind} via={via} t={t} />
          ))}
          <span className="cn-caps">{text.caps.join(" · ")}</span>
        </div>
        {open && <TokenField entry={entry} onSave={save(entry)} onCancel={() => setEditing(null)} />}
        {!open && (
          <div className="cn-foot">
            <Status entry={entry} state={state} />
            {action !== null && (
              <span className="cn-actions row-trailing">
                <ActionButton action={action} onClick={() => act(entry, action)} />
              </span>
            )}
          </div>
        )}
      </article>
    );
  });

  const rows = entries.map((entry) => {
    const state = props.states[entry.id];
    const text = textOf(t, entry.id);
    const action = actionOf(t, entry, state);
    const open = editing === entry.id;
    const sub = rowSubline(t, entry, state);
    return (
      <div key={entry.id} className="cn-rowwrap">
        <div className="pl-row cn-row" data-phase={phaseOf(state)}>
          <div className="pl-row-main cn-row-main" aria-label={text.name} title={entry.kind === "coming-soon" ? t.actionTip.soon : undefined}>
            <ConnectorLogo entry={entry} size="row" />
            <span className="pl-name">
              <b>{text.name}</b>
              <small>
                <Status entry={entry} state={state} small inlineNote={false} />
                {sub !== "" && (
                  <>
                    <span className="cn-sep">·</span>
                    <span className="cn-sub" title={state.kind === "failed" ? state.message : undefined}>{sub}</span>
                  </>
                )}
              </small>
            </span>
          </div>
          {action !== null && !open && <ActionButton action={action} onClick={() => act(entry, action)} />}
        </div>
        {open && (
          <div className="cn-row-edit">
            <TokenField entry={entry} onSave={save(entry)} onCancel={() => setEditing(null)} />
          </div>
        )}
      </div>
    );
  });

  return (
    <>
      <div className="cn-intro">
        <p>{t.intro}</p>
        <button type="button" className="pl-btn" title={t.recheckTip} onClick={props.onRecheck}>
          <Icon name="refresh-cw" size={13} strokeWidth={1.8} />
          {t.recheck}
        </button>
      </div>
      {entries.length === 0 && <p className="pl-empty">{t.empty(props.query.trim())}</p>}
      {props.chrome === "page" && entries.length > 0 && <div className="cn-wall">{cards}</div>}
      {entries.length > 0 && (
        <section className="pl-grp cn-list" aria-label={t.tab}>
          {rows}
        </section>
      )}
    </>
  );
}
