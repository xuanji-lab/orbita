/**
 * 配置表单（清单里 userConfig 声明的项）与「装在哪」选择器。
 * 详情页与安装确认对话框共用同一个 ScopeEditor——两处各写一遍就会走出两套交互。
 */
import { useEffect, useState } from "react";
import type { PluginConfigState, PluginConfigValue, PluginScope } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { scopeModeOf, toggleWorkspaceInScope, type ScopeMode } from "./plugin-view.ts";

// ---------- 装在哪 ----------

/**
 * 三选一：所有工作区 / 只在这些工作区… / 停用。点「只在这些」时名单可能还是空的——
 * 这时只改本地的「正在选」状态、不写盘（空名单写下去要么等于停用要么被误读成全开），
 * 勾上第一个才落盘；取消最后一个落到停用，选择器仍停在「只在这些」让人接着选。
 */
export function ScopeEditor(props: {
  scope: PluginScope;
  workspaces: readonly Workspace[];
  onChange: (scope: PluginScope) => void;
  /** 第三项的文案：详情里是「停用」，安装确认里是「先装上，不启用」 */
  offLabel: string;
  disabled?: boolean;
}) {
  const t = useT().plugins;
  const mode = scopeModeOf(props.scope);
  const [choosing, setChoosing] = useState(mode === "workspaces");
  // 外部把范围改成了别的种类（别处拨了开关）：选择器跟着走
  useEffect(() => {
    if (mode !== "off") setChoosing(mode === "workspaces");
  }, [mode]);
  const shown: ScopeMode = choosing ? "workspaces" : mode;
  const ids = props.scope.kind === "workspaces" ? props.scope.ids : [];
  const options: { id: ScopeMode; label: string }[] = [
    { id: "global", label: t.scopeAll },
    { id: "workspaces", label: t.scopeSome },
    { id: "off", label: props.offLabel },
  ];
  return (
    <div className="pl-col" style={{ gap: "var(--space-2)" }}>
      <div className="pl-scopes" role="radiogroup" aria-label={t.scopeTitle}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            className="pl-opt"
            aria-checked={shown === option.id}
            disabled={props.disabled}
            onClick={() => {
              if (option.id === "workspaces") {
                setChoosing(true);
                // 已经是「只在这些」就什么都不改；否则等用户勾第一个
                return;
              }
              setChoosing(false);
              props.onChange(option.id === "global" ? { kind: "global" } : { kind: "off" });
            }}
          >
            {shown === option.id && <Icon name="circle-check" size={12} strokeWidth={1.8} />}
            {option.label}
          </button>
        ))}
      </div>
      {shown === "workspaces" &&
        (props.workspaces.length === 0 ? (
          <span className="pl-muted">{t.scopeNoWorkspaces}</span>
        ) : (
          <>
            <div className="pl-ws-list">
              {props.workspaces.map((workspace) => (
                <label key={workspace.id} className="pl-ws-item">
                  <input
                    type="checkbox"
                    checked={ids.includes(workspace.id)}
                    disabled={props.disabled}
                    onChange={() => props.onChange(toggleWorkspaceInScope(props.scope, workspace.id))}
                  />
                  <Icon name="folder" size={13} strokeWidth={1.8} />
                  <span>{workspace.name}</span>
                </label>
              ))}
            </div>
            {ids.length === 0 && <span className="pl-field-hint">{t.scopePickHint}</span>}
          </>
        ))}
    </div>
  );
}

// ---------- 要你填的 ----------

function valueText(value: PluginConfigValue | null): string {
  if (value === null) return "";
  return Array.isArray(value) ? value.join(",") : String(value);
}

/** 一个配置项。文本 / 数字：离开输入框或按回车保存；布尔 / 选项：改了就存。敏感项只说有没有填。 */
export function ConfigField(props: {
  state: PluginConfigState;
  /** 保存（null = 清除）；失败抛出，这里就地显示原因 */
  onSave: (value: PluginConfigValue | null) => Promise<void>;
}) {
  const messages = useT();
  const t = messages.plugins;
  const { field, value, isSet } = props.state;
  const [draft, setDraft] = useState(valueText(value));
  const [editingSecret, setEditingSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(valueText(value)), [value]);

  const save = async (next: PluginConfigValue | null): Promise<void> => {
    setError(null);
    try {
      await props.onSave(next);
      setEditingSecret(false);
    } catch (cause) {
      setError(t.configInvalid(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const commitText = (): void => {
    if (draft === valueText(value)) return;
    if (draft.trim() === "") return void save(null);
    if (field.type === "number") {
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setError(t.configNotNumber);
        return;
      }
      return void save(parsed);
    }
    void save(draft);
  };

  const defaultLine =
    field.default !== null && field.default !== "" && !field.sensitive ? t.configDefault(valueText(field.default)) : null;

  let control: React.ReactNode;
  if (field.sensitive) {
    control =
      isSet && !editingSecret ? (
        <span className="pl-field-row">
          <span className="pl-secret">
            <span className="mask">••••••••</span>
            {t.configSecretSet}
          </span>
          <button type="button" className="pl-btn" onClick={() => setEditingSecret(true)}>
            {t.configSecretEdit}
          </button>
          <button type="button" className="pl-btn" onClick={() => void save(null)}>
            {t.configClear}
          </button>
        </span>
      ) : (
        <span className="pl-field-row">
          <input
            className="text-field"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder={t.configSecretPlaceholder}
            aria-label={field.title}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft !== "") void save(draft).then(() => setDraft(""));
            }}
          />
          <button
            type="button"
            className="pl-btn btn-accent"
            disabled={draft === ""}
            onClick={() => void save(draft).then(() => setDraft(""))}
          >
            {t.configSave}
          </button>
          {editingSecret && (
            <button type="button" className="pl-btn" onClick={() => setEditingSecret(false)}>
              {messages.common.cancel}
            </button>
          )}
        </span>
      );
  } else if (field.type === "boolean") {
    control = (
      <label className="pl-checks">
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <input
            type="checkbox"
            checked={value === true || (value === null && field.default === true)}
            onChange={(event) => void save(event.target.checked)}
          />
          <span className="pl-field-hint">{field.description}</span>
        </span>
      </label>
    );
  } else if (field.options !== null && field.multiple) {
    const current = Array.isArray(value) ? value : Array.isArray(field.default) ? field.default : [];
    control = (
      <div className="pl-checks">
        {field.options.map((option) => (
          <label key={option}>
            <input
              type="checkbox"
              checked={current.includes(option)}
              onChange={(event) =>
                void save(event.target.checked ? [...current, option] : current.filter((each) => each !== option))
              }
            />
            {option}
          </label>
        ))}
      </div>
    );
  } else if (field.options !== null) {
    control = (
      <select
        className="text-field"
        value={typeof value === "string" ? value : typeof field.default === "string" ? field.default : ""}
        aria-label={field.title}
        onChange={(event) => void save(event.target.value)}
      >
        {field.required || value === null ? <option value="">—</option> : null}
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        className="text-field"
        type={field.type === "number" ? "number" : "text"}
        spellCheck={false}
        value={draft}
        placeholder={field.default !== null ? valueText(field.default) : field.type === "directory" || field.type === "file" ? t.configPickFolder : ""}
        aria-label={field.title}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitText}
        onKeyDown={(event) => {
          if (event.key === "Enter") commitText();
        }}
      />
    );
  }

  return (
    <div className="pl-field">
      <span className="pl-field-label">
        {field.title}
        {field.required && <span className="req">{t.configRequired}</span>}
      </span>
      {control}
      {field.type !== "boolean" && field.description !== "" && <span className="pl-field-hint">{field.description}</span>}
      {defaultLine !== null && field.type !== "string" && <span className="pl-field-hint">{defaultLine}</span>}
      {error !== null && <span className="pl-field-error">{error}</span>}
    </div>
  );
}
