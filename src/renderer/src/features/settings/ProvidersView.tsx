import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { KNOWN_PROVIDERS, type KnownProvider } from "@shared/known-providers";
import type { ProviderDto, ValidationIssue } from "@shared/provider";
import type { BuiltinProvider } from "@shared/agent-ipc";

/**
 * Provider 设置面。
 *
 * 三条刻意的设计约束，都是为了不重蹈 proma 那条路：
 *  1. **没有协议选择框**——协议由「选哪个 provider」完全决定（智谱标准 API 是 OpenAI 兼容，
 *     智谱 Coding Plan 是 Anthropic 兼容），让用户选第二次只会选错。
 *  2. **下拉框只列我们适配过的**，不是 pi 的 41 个。pi 的目录是「模型参数」的真源，
 *     不是「怎么接入」的真源。
 *  3. **已发现 / 已启用两张卡**：/models 拿回来的是候选，用户点进「已启用」才算数——
 *     发现的东西直接可用会让模型下拉框变得不确定。
 */
export function ProvidersView(props: { onChange?: () => void }) {
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [status, setStatus] = useState<{ tone: "ok" | "bad" | "busy"; text: string } | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  /** pi 的内建目录，按 catalogId 取官方模型清单——离线就有，不用打网络 */
  const [catalog, setCatalog] = useState<BuiltinProvider[]>([]);

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
    void api.provider.builtins().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  const known = KNOWN_PROVIDERS.find((k) => k.id === draft.kind);
  /** 某个已适配 provider 在 pi 目录里的模型清单（没有 catalogId 或目录未到则为空） */
  const catalogModels = (target: KnownProvider | undefined): string[] =>
    target?.catalogId === undefined
      ? []
      : (catalog.find((c) => c.id === target.catalogId)?.models ?? []);
  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  const editing = editingId === null ? undefined : providers?.find((p) => p.id === editingId);
  const keyMask = editing?.auth.scheme === "api_key" ? editing.auth.masked : null;

  /** 选 provider：baseUrl 与协议一并定下，用户只剩名称、模型、key */
  const pick = (kind: string) => {
    const target = KNOWN_PROVIDERS.find((k) => k.id === kind);
    setStatus(null);
    setDiscovered([]);
    // 目录进**候选池**，不进已启用（R10-01 的 C 方案：发现的结果要用户「提升」才算数）。
    // 这也让目录不必百分百准确——智谱 Coding Plan 实际不提供 glm-5v-turbo，
    // 而 pi 的 zai-coding-cn 目录里有它；候选池里多一条无害，你不 enable 就是了。
    setDiscovered(catalogModels(target));
    setDraft({
      ...draft,
      kind,
      id: target?.id ?? "",
      displayName: target?.label ?? "",
      baseUrl: target?.baseUrl ?? "",
      models: [],
    });
  };

  const edit = (provider: ProviderDto) => {
    const kind =
      KNOWN_PROVIDERS.find((k) => k.id === provider.id)?.id ??
      (provider.endpoint.api === "anthropic-messages" ? "anthropic-compatible" : "openai-compatible");
    setIssues([]);
    setStatus(null);
    setRevealed(null);
    setEditingId(provider.id);
    const enabled = provider.models.declared.map((m) => m.id);
    setDiscovered(
      catalogModels(KNOWN_PROVIDERS.find((k) => k.id === kind)).filter((m) => !enabled.includes(m)),
    );
    setDraft({
      kind,
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.endpoint.baseUrl,
      models: provider.models.declared.map((m) => m.id),
      apiKey: "",
    });
  };

  const reset = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setIssues([]);
    setStatus(null);
    setDiscovered([]);
    setRevealed(null);
  };

  const withKey = () => ({
    ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
    ...(editingId === null ? {} : { providerId: editingId }),
  });

  /**
   * 取模型清单。**目录优先，网络兜底**：
   * pi 的目录是离线的、比网关的 /models 更新（实测 zhipu 的目录有 glm-5.3，
   * 而 anthropic 兼容端点的 /models 返回 200 包着 404，根本没有这个接口）。
   */
  const fetchModels = () =>
    guard("Fetching models…", async () => {
      const fromCatalog = catalogModels(known);
      if (fromCatalog.length > 0) {
        setDiscovered(fromCatalog.filter((m) => !draft.models.includes(m)));
        return { tone: "ok" as const, text: `${fromCatalog.length} models from pi's catalog.` };
      }
      if (known?.api === "anthropic-messages") {
        return {
          tone: "bad" as const,
          text: "Anthropic-compatible gateways do not expose /models. Add model ids by hand.",
        };
      }
      const result = await api.provider.discover({ baseUrl: draft.baseUrl.trim(), ...withKey() });
      setDiscovered(result.models.filter((m) => !draft.models.includes(m)));
      return { tone: result.ok ? ("ok" as const) : ("bad" as const), text: result.message };
    });

  const test = () =>
    guard("Testing connection…", async () => {
      const result = await api.provider.test({
        api: known?.api ?? "openai-completions",
        baseUrl: draft.baseUrl.trim(),
        modelId: draft.models[0] ?? "",
        ...withKey(),
      });
      return { tone: result.ok ? ("ok" as const) : ("bad" as const), text: result.message };
    });

  /**
   * 异步动作的统一外壳。**没有它，一次 IPC reject 就会让状态永远停在「…ing」**——
   * 主进程没重启、通道没注册时正是如此，用户看到的是挂起而不是错误。
   */
  const guard = async (
    busy: string,
    run: () => Promise<{ tone: "ok" | "bad"; text: string }>,
  ): Promise<void> => {
    setStatus({ tone: "busy", text: busy });
    try {
      setStatus(await run());
    } catch (cause) {
      setStatus({ tone: "bad", text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const toggleReveal = async () => {
    if (revealed !== null) {
      setRevealed(null);
      return;
    }
    if (draft.apiKey !== "") {
      setRevealed(draft.apiKey);
      return;
    }
    if (editingId === null) return;
    setRevealed(await api.provider.reveal(editingId));
  };

  const save = async () => {
    setError(null);
    const result = await api.provider.upsert({
      provider: {
        id: draft.id.trim(),
        displayName: draft.displayName.trim(),
        endpoint: { baseUrl: draft.baseUrl.trim(), api: known?.api ?? "openai-completions" },
        models: { declared: draft.models.map((id) => ({ id })) },
        auth: { scheme: "api_key" },
      },
      ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
    });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    reset();
    await refresh();
  };

  return (
    <section style={{ display: "grid", gap: "var(--space-6)", maxWidth: 640, width: "100%" }}>
      <header style={{ display: "grid", gap: "var(--space-1)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-heading)", fontWeight: 600 }}>Providers</h2>
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          Model parameters come from pi's catalog, refreshed every four hours. You only supply the key.
        </p>
      </header>

      {error !== null && <Line tone="bad">{error}</Line>}

      {providers !== null && providers.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {providers.map((provider) => (
            <li key={provider.id} style={cardStyle}>
              <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
                <strong style={{ fontWeight: 600 }}>{provider.displayName}</strong>
                <code style={metaStyle}>{provider.endpoint.api}</code>
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
              <span style={metaStyle}>
                {provider.auth.scheme === "api_key" && provider.auth.masked !== null
                  ? `Key ${provider.auth.masked}`
                  : "No key stored"}
                {" · "}
                {provider.models.declared.length} enabled
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
        style={{ ...cardStyle, gap: "var(--space-4)" }}
      >
        <Field
          label="Provider"
          hint={known?.note ?? "Pick the provider you have an account with."}
        >
          <select value={draft.kind} onChange={(e) => pick(e.target.value)} disabled={editingId !== null} style={inputStyle}>
            <option value="">Choose a provider…</option>
            {KNOWN_PROVIDERS.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </select>
        </Field>

        {known && (
          <>
            <Field label="Name" issue={issueFor("displayName")}>
              <input
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                style={inputStyle}
              />
            </Field>

            <Field
              label="Base URL"
              hint={
                known.api === "anthropic-messages"
                  ? "The client appends /v1/messages."
                  : "The client appends /chat/completions."
              }
              issue={issueFor("endpoint.baseUrl")}
            >
              <input
                value={draft.baseUrl}
                onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                placeholder="https://…"
                style={inputStyle}
              />
            </Field>

            <Field
              label="API key"
              hint={
                editingId === null ? "Stored by the operating system" : "Leave blank to keep the current key"
              }
              issue={issueFor("apiKey")}
            >
              <span style={{ display: "flex", gap: "var(--space-2)" }}>
                <input
                  type={revealed === null ? "password" : "text"}
                  value={revealed ?? draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  readOnly={revealed !== null}
                  placeholder={keyMask ?? "sk-…"}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => void toggleReveal()}
                  aria-label={revealed === null ? "Show key" : "Hide key"}
                  style={controlStyle}
                >
                  {revealed === null ? "Show" : "Hide"}
                </button>
                <button type="button" onClick={() => void test()} style={controlStyle}>
                  Test
                </button>
              </span>
            </Field>

            {status !== null && <Line tone={status.tone}>{status.text}</Line>}

            <ModelCard
              title="Enabled models"
              empty="Nothing enabled yet — enable one from the list below, or type an id."
              models={draft.models}
              actionLabel="Remove"
              onAction={(id) => setDraft({ ...draft, models: draft.models.filter((m) => m !== id) })}
              issue={issueFor("models.declared")}
              footer={
                <AddModel onAdd={(id) => setDraft({ ...draft, models: [...new Set([...draft.models, id])] })} />
              }
            />

            <ModelCard
              title="Available"
              empty="Press Fetch to look up models for this provider."
              models={discovered}
              actionLabel="Enable"
              onAction={(id) => {
                setDraft({ ...draft, models: [...new Set([...draft.models, id])] });
                setDiscovered(discovered.filter((m) => m !== id));
              }}
              footer={
                <button
                  type="button"
                  onClick={() => void fetchModels()}
                  disabled={draft.baseUrl.trim() === ""}
                  style={controlStyle}
                >
                  Fetch
                </button>
              }
            />

            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button type="submit" style={{ ...controlStyle, ...primaryStyle }}>
                {editingId === null ? "Add provider" : "Save changes"}
              </button>
              <button type="button" onClick={reset} style={controlStyle}>
                Cancel
              </button>
            </div>
          </>
        )}
      </form>
    </section>
  );
}

/** 模型卡片：已启用与已发现共用一个形状，区别只在动作 */
function ModelCard(props: {
  title: string;
  empty: string;
  models: string[];
  actionLabel: string;
  onAction: (id: string) => void;
  issue?: string | undefined;
  footer?: React.ReactNode;
}) {
  return (
    <div style={{ ...cardStyle, background: "var(--color-bg-muted)", gap: "var(--space-2)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <span style={{ fontSize: "var(--font-size-control)", fontWeight: 500 }}>{props.title}</span>
        <span style={metaStyle}>{props.models.length}</span>
        <span style={{ marginInlineStart: "auto" }}>{props.footer}</span>
      </div>
      {props.models.length === 0 ? (
        <span style={metaStyle}>{props.empty}</span>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-1)" }}>
          {props.models.map((id) => (
            <li key={id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <code style={{ ...metaStyle, flex: 1 }}>{id}</code>
              <button type="button" onClick={() => props.onAction(id)} style={compactControlStyle}>
                {props.actionLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
      {props.issue !== undefined && (
        <span style={{ fontSize: "var(--font-size-micro)", color: "var(--color-danger)" }}>{props.issue}</span>
      )}
    </div>
  );
}

function AddModel(props: { onAdd: (id: string) => void }) {
  const [value, setValue] = useState("");
  const commit = () => {
    const id = value.trim();
    if (id === "") return;
    props.onAdd(id);
    setValue("");
  };
  return (
    <span style={{ display: "flex", gap: "var(--space-1)" }}>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          commit();
        }}
        placeholder="model id"
        style={{ ...inputStyle, height: "var(--control-height-sm)", width: 160 }}
      />
      <button type="button" onClick={commit} style={compactControlStyle}>
        Add
      </button>
    </span>
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
        <span style={{ fontSize: "var(--font-size-micro)", color: "var(--color-danger)" }}>{props.issue}</span>
      ) : props.hint !== undefined ? (
        <span style={metaStyle}>{props.hint}</span>
      ) : null}
    </label>
  );
}

/** 状态行：颜色是第二信号，文字才是主信号（设计系统：status prefers icons and words） */
function Line(props: { tone: "ok" | "bad" | "busy"; children: React.ReactNode }) {
  const color =
    props.tone === "ok"
      ? "var(--color-success)"
      : props.tone === "bad"
        ? "var(--color-danger)"
        : "var(--color-text-tertiary)";
  return (
    <p role="status" style={{ margin: 0, fontSize: "var(--font-size-control)", color }}>
      {props.children}
    </p>
  );
}

const cardStyle: React.CSSProperties = {
  display: "grid",
  gap: "var(--space-1)",
  padding: "var(--space-4)",
  background: "var(--color-bg-panel)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-lg)",
};

const metaStyle: React.CSSProperties = {
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-micro)",
  color: "var(--color-text-tertiary)",
};

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

const compactControlStyle: React.CSSProperties = {
  ...controlStyle,
  height: "var(--control-height-xs)",
  padding: "0 var(--space-2)",
  fontSize: "var(--font-size-micro)",
};

/** accent 只给主操作（设计系统硬规则：一屏一个 accent） */
const primaryStyle: React.CSSProperties = {
  background: "var(--color-accent)",
  color: "var(--color-accent-fg)",
  borderColor: "var(--color-accent)",
};

function emptyDraft() {
  return { kind: "", id: "", displayName: "", baseUrl: "", models: [] as string[], apiKey: "" };
}
