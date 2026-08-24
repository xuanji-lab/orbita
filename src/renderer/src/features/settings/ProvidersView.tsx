import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import {
  PROVIDER_APIS,
  type ProviderApi,
  type ProviderDto,
  type ValidationIssue,
} from "@shared/provider";

/**
 * Provider 设置面（最小可用版）。契约先行的最后一层：
 * shared 契约 → main store → IPC → 这里。UI 只做列表 + 新建/编辑 + 删除。
 * 「测试连接」「发现模型」「能力旗标」都还没有消费者，按落库纪律不在本轮出现。
 */
export function ProvidersView() {
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());

  const refresh = useCallback(async () => {
    try {
      setProviders(await api.provider.list());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;

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
                <button
                  type="button"
                  onClick={() => void api.provider.remove(provider.id).then(refresh)}
                  style={{ ...controlStyle, marginInlineStart: "auto" }}
                >
                  Remove
                </button>
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
        <Field label="Identifier" hint="Lowercase letters, digits and dashes" issue={issueFor("id")}>
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="openai"
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
        <Field label="Base URL" issue={issueFor("endpoint.baseUrl")}>
          <input
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            placeholder="https://api.openai.com/v1"
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
        <Field label="API key" hint="Stored by the operating system, write only" issue={issueFor("apiKey")}>
          <input
            type="password"
            value={draft.apiKey}
            onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
            placeholder="sk-…"
            style={inputStyle}
          />
        </Field>
        <button type="submit" style={{ ...controlStyle, ...primaryStyle }}>
          Save provider
        </button>
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
