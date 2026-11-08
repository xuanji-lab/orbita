/**
 * 能力页的「连接」页签：10 家待配置的品牌入口。
 * 宽档（设置 › 能力，容器 ≥ 640px）是两列卡片墙，窄档（右栏、被挤窄的设置页）退成安静列表——
 * 哪棵显示由 plugins.css 的 `@container pl` 定，JS 不量宽度（同「已装」页）。
 * 状态一律来自主进程实测；「配置」要么开一条新会话让智能体带着接（命令行 / 引导型），
 * 要么就在卡内贴 token（远程 MCP 类）；OAuth 型（Notion / Supabase / Pangram）点「连接」在系统浏览器里登录，
 * 回来自动实测，已连接时「断开」（行内二次确认）。
 */
import { useEffect, useRef, useState } from "react";
import "./connectors.css";
import { CONNECTORS, connectorSetupPrompt, type ConnectorEntry, type ConnectorId, type ConnectorSaveResult, type ConnectorVia } from "@shared/connectors";
import type { McpOauthLoginResult } from "@shared/mcp-oauth";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { Icon } from "../../shell/Icon";
import { ConnectorLogo } from "./ConnectorLogo.tsx";
import {
  actionOf,
  configureRoute,
  filterConnectors,
  loginFailureText,
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
  /** OAuth 型：浏览器登录，等到结束 */
  login: (id: ConnectorId) => Promise<McpOauthLoginResult>;
  cancelLogin: (id: ConnectorId) => void;
  disconnect: (id: ConnectorId) => Promise<void>;
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
    // 写进去了就收起：连上了卡片显示「已连接」，连不上卡片显示「连接失败 + 原因」和「重新配置」（不把字段留在那里
    // 摆一条「已保存但失败」）。没写进去（校验 / 写盘失败）才留着字段，让用户改
    props.onCancel();
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

/** 行内二次确认：就在状态 / 按钮那一行原地换成这条（插件详情「移除」的同一个做法），后果小字挂在下面 */
function DisconnectConfirm(props: { name: string; onConfirm: () => void; onCancel: () => void }) {
  const t = useT();
  const text = t.connectors.oauth;
  const cancelRef = useRef<HTMLButtonElement>(null);
  // 破坏性确认的焦点落在「取消」上：手快按回车不会误断开
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      className="pl-ic cn-confirm"
      role="alertdialog"
      aria-label={text.disconnectAsk(props.name)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          props.onCancel();
        }
      }}
    >
      <div className="pl-ic-bar">
        <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
        <span className="pl-ic-ask">{text.disconnectAsk(props.name)}</span>
        <span className="cn-confirm-acts">
          <button type="button" className="pl-btn solid-danger" onClick={props.onConfirm}>
            {text.disconnectAction}
          </button>
          <button type="button" className="pl-btn" ref={cancelRef} onClick={props.onCancel}>
            {t.common.cancel}
          </button>
        </span>
      </div>
      <p className="pl-ic-hint">{text.disconnectHint}</p>
    </div>
  );
}

export function ConnectorsView(props: ConnectorsViewProps) {
  const t = useT().connectors;
  const [editing, setEditing] = useState<ConnectorId | null>(null);
  /** 正在二次确认「断开」的那一家 */
  const [confirming, setConfirming] = useState<ConnectorId | null>(null);
  /** 登录没成时每家卡上留的一句话（下一次登录开始时清掉；取消不算失败，不留） */
  const [notices, setNotices] = useState<Partial<Record<ConnectorId, string>>>({});
  const entries = filterConnectors(t, CONNECTORS, props.query);

  const startLogin = (entry: ConnectorEntry): void => {
    setNotices((prev) => ({ ...prev, [entry.id]: undefined }));
    void props.login(entry.id).then((result) => {
      if (result.ok) return;
      const text = loginFailureText(t.oauth, result);
      if (text !== null) setNotices((prev) => ({ ...prev, [entry.id]: text }));
    });
  };

  /** 点按钮：按条目与状态决定去哪 */
  const act = (entry: ConnectorEntry, action: ActionModel): void => {
    const state = props.states[entry.id];
    const name = textOf(t, entry.id).name;
    if (action.kind === "connect" || action.kind === "login") {
      startLogin(entry);
      return;
    }
    if (action.kind === "cancel") {
      props.cancelLogin(entry.id);
      return;
    }
    if (action.kind === "disconnect") {
      setConfirming(entry.id);
      return;
    }
    if (action.kind === "manage") {
      if (manageRoute(entry, state) === "installed") props.onShowInstalled();
      else props.onStartSession(connectorSetupPrompt(entry, name, props.locale, "manage"));
      return;
    }
    if (configureRoute(entry) === "token") setEditing(entry.id);
    else props.onStartSession(connectorSetupPrompt(entry, name, props.locale, "setup"));
  };

  const save = (entry: ConnectorEntry) => (token: string) => props.saveToken(entry.id, token);
  const confirmDisconnect = (entry: ConnectorEntry): void => {
    setConfirming(null);
    setNotices((prev) => ({ ...prev, [entry.id]: undefined }));
    void props.disconnect(entry.id);
  };

  const cards = entries.map((entry) => {
    const state = props.states[entry.id];
    const text = textOf(t, entry.id);
    const action = actionOf(t, entry, state);
    const open = editing === entry.id;
    const asking = confirming === entry.id && state.kind === "connected";
    const notice = notices[entry.id];
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
        {asking && <DisconnectConfirm name={text.name} onConfirm={() => confirmDisconnect(entry)} onCancel={() => setConfirming(null)} />}
        {!open && !asking && (
          <div className="cn-foot">
            <Status entry={entry} state={state} />
            <span className="cn-actions row-trailing">
              <ActionButton action={action} onClick={() => act(entry, action)} />
            </span>
          </div>
        )}
        {notice !== undefined && !asking && (
          <span className="pl-field-error cn-notice" role="alert">
            {notice}
          </span>
        )}
      </article>
    );
  });

  const rows = entries.map((entry) => {
    const state = props.states[entry.id];
    const text = textOf(t, entry.id);
    const action = actionOf(t, entry, state);
    const open = editing === entry.id;
    const asking = confirming === entry.id && state.kind === "connected";
    const notice = notices[entry.id];
    const sub = rowSubline(t, entry, state);
    return (
      <div key={entry.id} className="cn-rowwrap">
        <div className="pl-row cn-row" data-phase={phaseOf(state)}>
          <div className="pl-row-main cn-row-main" aria-label={text.name}>
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
          {!open && !asking && <ActionButton action={action} onClick={() => act(entry, action)} />}
        </div>
        {open && (
          <div className="cn-row-edit">
            <TokenField entry={entry} onSave={save(entry)} onCancel={() => setEditing(null)} />
          </div>
        )}
        {asking && (
          <div className="cn-row-edit">
            <DisconnectConfirm name={text.name} onConfirm={() => confirmDisconnect(entry)} onCancel={() => setConfirming(null)} />
          </div>
        )}
        {notice !== undefined && !asking && (
          <div className="cn-row-edit">
            <span className="pl-field-error cn-notice" role="alert">
              {notice}
            </span>
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
