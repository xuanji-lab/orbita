import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import {
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderDto,
  type ValidationIssue,
} from "@shared/provider";
import type { BuiltinProvider } from "@shared/agent-ipc";

/**
 * Provider 设置面（最小可用版）。契约先行的最后一层：
 * shared 契约 → main store → IPC → 这里。UI 只做列表 + 新建/编辑 + 删除。
 * 「测试连接」「发现模型」「能力旗标」都还没有消费者，按落库纪律不在本轮出现。
 */
/**
 * 各 api 的 baseUrl 约定。两种主流协议正好相反，而 pi 是把 baseUrl 原样交给官方 SDK
 * 客户端的（openai / @anthropic-ai/sdk），由 SDK 自己接后半段——**我们不做任何 append**，
 * 所以用户填错就是直接 404。这张表就是为了让用户不用猜。
 */
const BASE_URL_HINTS: Record<ProviderApi, { placeholder: string; hint: string }> = {
  "openai-completions": {
    placeholder: "https://open.bigmodel.cn/api/coding/paas/v4",
    hint: "Include the version segment. The client appends /chat/completions.",
  },
  "openai-responses": {
    placeholder: "https://api.openai.com/v1",
    hint: "Include the version segment. The client appends /responses.",
  },
  "openai-codex-responses": {
    placeholder: "https://chatgpt.com/backend-api/codex",
    hint: "Codex gateway root. The client appends the responses path.",
  },
  "anthropic-messages": {
    placeholder: "https://api.anthropic.com",
    hint: "Gateway root only — no version segment. The client appends /v1/messages.",
  },
  "google-generative-ai": {
    placeholder: "https://generativelanguage.googleapis.com",
    hint: "Host root only. The client appends the v1beta model path.",
  },
  "mistral-conversations": {
    placeholder: "https://api.mistral.ai/v1",
    hint: "Include the version segment. The client appends /chat/completions.",
  },
};

export function ProvidersView(props: { onChange?: () => void }) {
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  /** 非 null 时表单处于「编辑既有 provider」状态，id 不可改。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** pi 内建目录。为空说明 agent 进程还没起来或 pi 没给出目录——那就退回手填。 */
  const [builtins, setBuiltins] = useState<BuiltinProvider[]>([]);

  const refresh = useCallback(async () => {
    try {
      setProviders(await api.provider.list());
      props.onChange?.();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [props]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void api.provider.builtins().then(setBuiltins).catch(() => setBuiltins([]));
  }, []);

  /** 选中一个内建 provider：baseUrl / 协议 / 模型全部按 pi 的官方目录预填，用户只需填 key。 */
  const pickBuiltin = (id: string) => {
    if (id === "") {
      setDraft({ ...emptyDraft(), apiKey: draft.apiKey });
      return;
    }
    const builtin = builtins.find((b) => b.id === id);
    if (!builtin) return;
    setDraft({
      id: builtin.id,
      displayName: builtin.name,
      baseUrl: builtin.baseUrl,
      api: (PROVIDER_APIS as readonly string[]).includes(builtin.api)
        ? (builtin.api as ProviderApi)
        : "openai-completions",
      models: builtin.models.slice(0, 6).join(", "),
      apiKey: draft.apiKey,
    });
  };

  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;

  /** 正在编辑的 provider 已存密钥的掩码（没有则 null） */
  const editing = editingId === null ? undefined : providers?.find((p) => p.id === editingId);
  const editingKeyMask =
    editing?.auth.scheme === "api_key" ? editing.auth.masked : null;

  /** 编辑：装回表单。密钥永远不会回到 renderer，所以留空 = 保留原密钥（store.upsert 的语义）。 */
  const edit = (provider: ProviderDto) => {
    setIssues([]);
    setEditingId(provider.id);
    setDraft({
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.endpoint.baseUrl,
      api: provider.endpoint.api,
      models: provider.models.declared.map((m) => m.id).join(", "),
      apiKey: "",
    });
  };

  const save = async () => {
    setError(null);
    const result = await api.provider.upsert({
      provider: {
        id: draft.id.trim(),
        displayName: draft.displayName.trim(),
        endpoint: { baseUrl: draft.baseUrl.trim(), api: draft.api },
        models: {
          declared: draft.models
            .split(",")
            .map((m) => m.trim())
            .filter(Boolean)
            .map((id) => ({ id })),
        },
        auth: { scheme: "api_key" },
      },
      ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
    });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    setDraft(emptyDraft());
    setEditingId(null);
    await refresh();
  };

  return (
    <section style={{ display: "grid", gap: "var(--space-6)", maxWidth: 640, width: "100%" }}>
      <header style={{ display: "grid", gap: "var(--space-1)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-heading)", fontWeight: 600 }}>
          Providers
        </h2>
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          The API key never leaves this machine and is never sent to the interface — only a masked
          preview is shown.
        </p>
      </header>

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "var(--font-size-control)", color: "var(--color-danger)" }}>
          {error}
        </p>
      )}

      {providers === null ? (
        <p style={{ margin: 0, color: "var(--color-text-tertiary)" }}>Loading…</p>
      ) : providers.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: "var(--space-6)",
            border: "1px dashed var(--color-border-default)",
            borderRadius: "var(--radius-lg)",
            color: "var(--color-text-tertiary)",
            fontSize: "var(--font-size-control)",
            textAlign: "center",
          }}
        >
          No provider yet. Add one below to give the agent a model to talk to.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {providers.map((provider) => (
            <li
              key={provider.id}
              style={{
                display: "grid",
                gap: "var(--space-1)",
                padding: "var(--space-4)",
                background: "var(--color-bg-panel)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: "var(--radius-lg)",
              }}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
                <strong style={{ fontWeight: 600 }}>{provider.displayName}</strong>
                <code style={{ fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>
                  {provider.endpoint.api}
                </code>
                <span style={{ marginInlineStart: "auto", display: "flex", gap: "var(--space-2)" }}>
                  <button type="button" onClick={() => edit(provider)} style={controlStyle}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void api.provider.remove(provider.id).then(refresh)}
                    style={controlStyle}
                  >
                    Remove
                  </button>
                </span>
              </div>
              <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" }}>
                {provider.endpoint.baseUrl}
              </span>
              <span style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>
                {provider.auth.scheme === "api_key" && provider.auth.masked !== null
                  ? `Key ${provider.auth.masked}`
                  : "No key stored"}
                {" · "}
                {provider.models.declared.length} model
                {provider.models.declared.length === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        style={{
          display: "grid",
          gap: "var(--space-3)",
          padding: "var(--space-5)",
          background: "var(--color-bg-panel)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "var(--radius-lg)",
        }}
      >
        {editingId === null && builtins.length > 0 && (
          <Field
            label="Provider"
            hint={`Pick one of pi's ${builtins.length} known providers to fill everything but the key, or choose Custom.`}
          >
            <select
              value={builtins.some((b) => b.id === draft.id) ? draft.id : ""}
              onChange={(e) => pickBuiltin(e.target.value)}
              style={inputStyle}
            >
              <option value="">Custom (fill in manually)</option>
              {builtins.map((builtin) => (
                <option key={builtin.id} value={builtin.id}>
                  {builtin.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Identifier" hint="Lowercase letters, digits and dashes" issue={issueFor("id")}>
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="zai"
            disabled={editingId !== null}
            style={inputStyle}
          />
        </Field>
        <Field label="Display name" issue={issueFor("displayName")}>
          <input
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            placeholder="OpenAI"
            style={inputStyle}
          />
        </Field>
        <Field
          label="Base URL"
          hint={BASE_URL_HINTS[draft.api].hint}
          issue={issueFor("endpoint.baseUrl")}
        >
          <input
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            placeholder={BASE_URL_HINTS[draft.api].placeholder}
            style={inputStyle}
          />
        </Field>
        <Field label="Protocol" issue={issueFor("endpoint.api")}>
          <select
            value={draft.api}
            onChange={(e) => setDraft({ ...draft, api: e.target.value as ProviderApi })}
            style={inputStyle}
          >
            {PROVIDER_APIS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Models" hint="Comma separated ids" issue={issueFor("models.declared")}>
          <input
            value={draft.models}
            onChange={(e) => setDraft({ ...draft, models: e.target.value })}
            placeholder="gpt-5, gpt-5-mini"
            style={inputStyle}
          />
        </Field>
        <Field
          label="API key"
          hint={
            editingId === null
              ? "Stored by the operating system, write only"
              : "Leave blank to keep the current key"
          }
          issue={issueFor("apiKey")}
        >
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            // 编辑态用**已存密钥的掩码**当 placeholder：框里是空的（明文不回 renderer），
            // 但灰字显示 sk-…1234 就是「它确实存住了」的肉眼凭据。
            placeholder={editingKeyMask ?? "sk-…"}
            style={inputStyle}
          />
        </Field>
        <div style={{ display: "flex", gap: "var(--space-2)" }}>
          <button type="submit" style={{ ...controlStyle, ...primaryStyle }}>
            {editingId === null ? "Add provider" : "Save changes"}
          </button>
          {editingId !== null && (
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft(emptyDraft());
                setIssues([]);
              }}
              style={controlStyle}
            >
              Cancel
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function Field(props: {
  label: string;
  hint?: string;
  issue?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: "var(--space-1)" }}>
      <span style={{ fontSize: "var(--font-size-control)", fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.issue !== undefined ? (
        <span style={{ fontSize: "var(--font-size-micro)", color: "var(--color-danger)" }}>
          {props.issue}
        </span>
      ) : props.hint !== undefined ? (
        <span style={{ fontSize: "var(--font-size-micro)", color: "var(--color-text-tertiary)" }}>
          {props.hint}
        </span>
      ) : null}
    </label>
  );
}

const inputStyle: React.CSSProperties = {
  height: "var(--control-height-md)",
  padding: "0 var(--space-3)",
  background: "var(--color-bg-app)",
  color: "var(--color-text-primary)",
  border: "1px solid var(--color-border-default)",
  borderRadius: "var(--radius-md)",
  font: "inherit",
  fontSize: "var(--font-size-input)",
};

const controlStyle: React.CSSProperties = {
  height: "var(--control-height-md)",
  padding: "0 var(--space-4)",
  background: "var(--color-bg-app)",
  color: "var(--color-text-primary)",
  border: "1px solid var(--color-border-default)",
  borderRadius: "var(--radius-md)",
  font: "inherit",
  fontSize: "var(--font-size-control)",
  cursor: "pointer",
  transition: "var(--transition-hover)",
};

/** accent 只给主操作（设计系统硬规则：一屏一个 accent） */
const primaryStyle: React.CSSProperties = {
  background: "var(--color-accent)",
  color: "var(--color-accent-fg)",
  borderColor: "var(--color-accent)",
  justifySelf: "start",
};

function emptyDraft() {
  return {
    id: "",
    displayName: "",
    baseUrl: "",
    api: "openai-completions" as ProviderApi,
    models: "",
    apiKey: "",
  };
}
