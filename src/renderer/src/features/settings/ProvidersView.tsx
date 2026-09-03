import { useCallback, useEffect, useState } from "react";
import { api } from "../../api";
import { KNOWN_PROVIDERS, type KnownProvider } from "@shared/known-providers";
import type { ModelDecl, ProviderDto, ValidationIssue } from "@shared/provider";
import type { BuiltinModel, BuiltinProvider } from "@shared/agent-ipc";
import { formatCostRate, formatTokens } from "../../utils/format-tokens.ts";

/**
 * Provider 设置面。
 *
 * 四条刻意的设计约束，都是为了不重蹈 proma 那条路：
 *  1. **没有协议选择框**——协议由「选哪个 provider」完全决定（智谱标准 API 是 OpenAI 兼容，
 *     智谱 Coding Plan 是 Anthropic 兼容），让用户选第二次只会选错。
 *  2. **下拉框只列我们适配过的**，不是 pi 的 41 个。pi 的目录是「模型参数」的真源，
 *     不是「怎么接入」的真源。
 *  3. **已发现 / 已启用两张卡**：/models 拿回来的是候选，用户点进「已启用」才算数——
 *     发现的东西直接可用会让模型下拉框变得不确定。
 *  4. **保存语义就近分层**（对齐 pi 的 /models 即选即生效）：已存在 provider 的启停与
 *     参数改动在操作发生的那一层立即落盘；表单的 Save 只管身份字段（名称 / URL / key）。
 *     此前三层嵌套一个保存还沉在表单最底部——用户改完参数找不到保存按钮，真实事故。
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
  /** 行内参数编辑器展开在第几个模型上（Enabled 列表的下标） */
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
  /** 目录里这个模型的官方参数（自建网关没有 catalogId，查不到——如实显示走兜底） */
  const catalogMeta = (target: KnownProvider | undefined, id: string): BuiltinModel | undefined =>
    target?.catalogId === undefined
      ? undefined
      : catalog.find((c) => c.id === target.catalogId)?.models.find((m) => m.id === id);
  /** 某个已适配 provider 在 pi 目录里的模型 id 清单（Fetch 的兜底候选池） */
  const catalogIds = (target: KnownProvider | undefined): string[] =>
    target?.catalogId === undefined
      ? []
      : (catalog.find((c) => c.id === target.catalogId)?.models ?? []).map((m) => m.id);
  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  const editing = editingId === null ? undefined : providers?.find((p) => p.id === editingId);
  const keyMask = editing?.auth.scheme === "api_key" ? editing.auth.masked : null;

  /** 选 provider：baseUrl 与协议一并定下，用户只剩名称、模型、key */
  const pick = (kind: string) => {
    const target = KNOWN_PROVIDERS.find((k) => k.id === kind);
    setStatus(null);
    setDiscovered([]);
    // 候选池留空，等 Fetch 去问供应商——目录是按厂商组织的，分不清套餐
    // （pi 的 zai-coding-cn 含 glm-5v-turbo，但智谱 Coding Plan 并不提供它）。
    setDiscovered([]);
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
    setDiscovered([]);
    setDraft({
      kind,
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.endpoint.baseUrl,
      // 保留已填的参数覆盖（浅拷贝 cost 引用即可——编辑时整个替换，从不动内层）
      models: provider.models.declared.map((m) => ({ ...m })),
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
      // **先问供应商本人**：拿回来的是这把 key、这个套餐实际能用的清单，比任何目录都准。
      const result = await api.provider.discover({
        baseUrl: draft.baseUrl.trim(),
        api: known?.api ?? "openai-completions",
        ...withKey(),
      });
      if (result.ok) {
        setDiscovered(result.models.filter((m) => !draft.models.some((d) => d.id === m)));
        return { tone: "ok" as const, text: result.message };
      }
      // 供应商不给（没有该端点 / 网络不通）才退回 pi 目录，并说明它可能不精确
      const fromCatalog = catalogIds(known);
      if (fromCatalog.length === 0) return { tone: "bad" as const, text: result.message };
      setDiscovered(fromCatalog.filter((m) => !draft.models.some((d) => d.id === m)));
      return {
        tone: "bad" as const,
        text: `${result.message} Showing ${fromCatalog.length} from pi's catalog instead — these may not all be on your plan.`,
      };
    });

  const test = () =>
    guard("Testing connection…", async () => {
      const result = await api.provider.test({
        api: known?.api ?? "openai-completions",
        baseUrl: draft.baseUrl.trim(),
        modelId: draft.models[0]?.id ?? "",
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
      // 只收起显示（type 回 password），**不动 draft**——用户改过的字符不能被弹回
      setRevealed(null);
      return;
    }
    if (draft.apiKey !== "") {
      // 粘贴过的：直接明文显示，它本来就是可编辑的草稿
      setRevealed(draft.apiKey);
      return;
    }
    if (editingId === null) return;
    const stored = await api.provider.reveal(editingId);
    if (stored === null) return;
    // 已存 key 的「Show」= 把明文拉进输入框当**可编辑草稿**。
    // 上一版把 revealed 接管 value 还加 readOnly——backspace 全部无效，
    // 用户删不掉粘贴的 key（wafo 2026-09-03）。
    setDraft({ ...draft, apiKey: stored });
    setRevealed(stored);
  };

  /**
   * 模型层变更的就地落盘（约束 4）：已存在的 provider 立即 read-modify-write——
   * Enable / Remove / 参数 Apply 都不再等表单底部的 Save。以**盘上的 provider** 为底
   * 合并，不夹带身份字段（名称 / URL / key）的未保存改动；还没落盘的新建 provider
   * 只动草稿，随 Add provider 一起提交。返回是否成功（失败时 issues 已就位，编辑器留着标红）。
   */
  const mutateModels = async (mutate: (models: ModelDecl[]) => ModelDecl[]): Promise<boolean> => {
    const next = mutate(draft.models.map((m) => ({ ...m })));
    if (editingId === null) {
      setDraft((d) => ({ ...d, models: next }));
      return true;
    }
    const current = providers?.find((p) => p.id === editingId);
    if (current === undefined) return false;
    try {
      const result = await api.provider.upsert({
        provider: {
          id: current.id,
          displayName: current.displayName,
          endpoint: current.endpoint,
          models: { declared: next },
          auth: { scheme: current.auth.scheme },
        },
      });
      if (!result.ok) {
        setIssues(result.issues);
        return false;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
    setIssues([]);
    setDraft((d) => ({ ...d, models: next.map((m) => ({ ...m })) }));
    await refresh();
    return true;
  };

  const save = async () => {
    setError(null);
    const result = await api.provider.upsert({
      provider: {
        id: draft.id.trim(),
        displayName: draft.displayName.trim(),
        endpoint: { baseUrl: draft.baseUrl.trim(), api: known?.api ?? "openai-completions" },
        models: { declared: draft.models },
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
    <section style={{ display: "grid", gap: "var(--space-6)", width: "100%" }}>
      {/* 标题由内容面的页头统一给（SettingsView），这里不再重复一个 h2 */}
      <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" }}>
        Model parameters come from pi's catalog, refreshed every four hours. For models the catalog
        doesn't know (custom gateways), fill in the parameters yourself — they override the catalog
        wherever it's wrong. Enabling, removing and parameter changes apply immediately; Save only
        covers the name, URL and key.
      </p>

      {error !== null && <Line tone="bad">{error}</Line>}

      {/*
        加载与空必须分得开：providers === null 是「还在读」（或读失败——失败走上面的
        error 行），[] 是「真的一个都没有」。三态一种脸的话，第一次打开永远像坏了。
      */}
      {providers === null && error === null && <Line tone="busy">Loading providers…</Line>}
      {providers !== null && providers.length === 0 && (
        <p
          style={{
            margin: 0,
            fontSize: "var(--font-size-caption)",
            color: "var(--color-text-secondary)",
          }}
        >
          No provider yet. Pick one below and save it with a key.
        </p>
      )}

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
                  value={draft.apiKey}
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
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
              count={draft.models.length}
              issue={issueFor("models.declared")}
              footer={
                <AddModel
                  onAdd={(id) =>
                    void mutateModels((models) =>
                      models.some((m) => m.id === id) ? models : [...models, { id }],
                    )
                  }
                />
              }
            >
              {draft.models.map((model, index) => {
                const meta = catalogMeta(known, model.id);
                const costTitle = modelCostTitle(model, meta);
                return (
                  <li key={model.id} style={{ display: "grid", gap: "var(--space-1)" }}>
                    <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                      <code style={{ ...metaStyle, flex: 1 }}>{model.id}</code>
                      <span style={metaStyle} title={costTitle}>
                        {modelMetaText(model, meta)}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          void mutateModels((models) => models.filter((m) => m.id !== model.id));
                        }}
                        style={compactControlStyle}
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                );
              })}
            </ModelCard>

            <ModelCard
              title="Available"
              empty="Press Fetch to ask the provider which models this key can use."
              count={discovered.length}
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
            >
              {discovered.map((id) => {
                const meta = catalogMeta(known, id);
                return (
                  <li key={id} style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                    <code style={{ ...metaStyle, flex: 1 }}>{id}</code>
                    <span style={metaStyle} title={modelCostTitle(undefined, meta)}>
                      {modelMetaText(undefined, meta)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        void mutateModels((models) =>
                          models.some((m) => m.id === id) ? models : [...models, { id }],
                        );
                        setDiscovered(discovered.filter((m) => m !== id));
                      }}
                      style={compactControlStyle}
                    >
                      Enable
                    </button>
                  </li>
                );
              })}
            </ModelCard>

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

/**
 * 模型卡片的外壳：标题 / 计数 / 底部动作。行内容由调用方给——
 * 已启用（ModelDecl + 行内编辑器）与候选（id + 目录摘要）两张卡行形状不同了。
 */
function ModelCard(props: {
  title: string;
  empty: string;
  count: number;
  issue?: string | undefined;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        ...cardStyle,
        background: "var(--color-chat-muted-bg)",
        border: 0,
        boxShadow: "none",
        backdropFilter: "none",
        WebkitBackdropFilter: "none",
        borderRadius: "var(--radius-md)",
        gap: "var(--space-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <span style={{ fontSize: "var(--font-size-control)", fontWeight: 500 }}>{props.title}</span>
        <span style={metaStyle}>{props.count}</span>
        <span style={{ marginInlineStart: "auto" }}>{props.footer}</span>
      </div>
      {props.count === 0 ? (
        <span style={metaStyle}>{props.empty}</span>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-1)" }}>
          {props.children}
        </ul>
      )}
      {props.issue !== undefined && (
        <span style={{ fontSize: "var(--font-size-micro)", color: "var(--color-danger)" }}>{props.issue}</span>
      )}
    </div>
  );
}

/**
 * 目录不认识且用户未填时的兜底显示值——与 agent 侧 model-registration 的 FALLBACK_MODEL
 * 是同一组数字（那边还有 reasoning / 零费率）。改任一处要同步另一处。
 */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 8_192;

/**
 * 模型行的参数摘要：**生效值 = 用户覆盖 > pi 目录 > 兜底**。目录不认识也没填过时
 * 如实标注走兜底，不把 128k 假装成官方值。
 */
function modelMetaText(decl: ModelDecl | undefined, meta: BuiltinModel | undefined): string {
  const ctx = decl?.contextWindow ?? meta?.contextWindow;
  const maxOut = decl?.maxTokens ?? meta?.maxTokens;
  const inputRate = decl?.cost?.input ?? meta?.cost.input;
  const parts =
    ctx === undefined
      ? [`${formatTokens(FALLBACK_CONTEXT_WINDOW)} ctx (fallback)`]
      : [`${formatTokens(ctx)} ctx`];
  if (maxOut !== undefined) parts.push(`${formatTokens(maxOut)} out`);
  const rate = inputRate === undefined ? null : formatCostRate(inputRate);
  if (rate !== null) parts.push(`${rate} in`);
  return parts.join(" · ");
}

/** hover 的四档费率全文。全零（定价未知）不给 title——没有可看的信息 */
function modelCostTitle(decl: ModelDecl | undefined, meta: BuiltinModel | undefined): string | undefined {
  const cost = decl?.cost ?? meta?.cost;
  if (cost === undefined) return undefined;
  if (cost.input === 0 && cost.output === 0 && cost.cacheRead === 0 && cost.cacheWrite === 0) return undefined;
  return [
    `input $${cost.input}/M`,
    `output $${cost.output}/M`,
    `cache read $${cost.cacheRead}/M`,
    `cache write $${cost.cacheWrite}/M`,
  ].join("\n");
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

/** 设置面的卡走的是同一个玻璃配方——一个卡片配方，改宽高即可复用 */
const cardStyle: React.CSSProperties = {
  display: "grid",
  gap: "var(--space-1)",
  padding: "var(--space-4)",
  background: "var(--glass-bg)",
  border: "1px solid var(--glass-border)",
  borderRadius: "var(--radius-xl)",
  boxShadow: "var(--shadow-composer)",
  WebkitBackdropFilter: "blur(var(--glass-blur))",
  backdropFilter: "blur(var(--glass-blur))",
};

const metaStyle: React.CSSProperties = {
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-micro)",
  color: "var(--color-text-tertiary)",
};

const inputStyle: React.CSSProperties = {
  height: "var(--control-height-md)",
  padding: "0 var(--space-3)",
  background: "var(--color-bg-panel)",
  color: "var(--color-text-primary)",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-md)",
  font: "inherit",
  fontSize: "var(--font-size-input)",
};

const controlStyle: React.CSSProperties = {
  height: "var(--control-height-md)",
  padding: "0 var(--space-4)",
  background: "var(--color-bg-muted)",
  color: "var(--color-text-primary)",
  border: 0,
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
  fontWeight: "var(--weight-medium)",
};

function emptyDraft() {
  return { kind: "", id: "", displayName: "", baseUrl: "", models: [] as ModelDecl[], apiKey: "" };
}
