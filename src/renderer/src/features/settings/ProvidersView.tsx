import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import "./providers-view.css";
import { KNOWN_PROVIDERS, isPlanBilling, knownModelParams, type KnownProvider } from "@shared/known-providers";
import type { ModelDecl, ProviderDto, ValidationIssue } from "@shared/provider";
import type { BuiltinModel, BuiltinProvider } from "@shared/agent-ipc";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import {
  kindOf,
  mergeModelCost,
  modelContextText,
  modelIdIssue,
  nextCopyId,
  parseRateInput,
  parseTokenInput,
  reorderIds,
} from "./providers-view-model.ts";

/**
 * Provider 设置面 —— 主从两栏：左栏厂商列表（可拖动排序、可复制），右栏唯一编辑区。
 * 布局按已验收小样（docs/plans/2026-09-10-providers-view-mockup.html）重排。
 *
 * 保留旧版的四条刻意约束（都是为了不重蹈 proma 那条路）：
 *  1. **没有协议选择框**——协议由「选哪个 provider」完全决定，让用户选第二次只会选错；
 *     右栏把协议显性展示成锁定字段（API format）。
 *  2. **目录只列适配过的**（KNOWN_PROVIDERS），不是 pi 的 41 个。
 *  3. **发现的模型要用户提升才算数**：Fetch 结果进多选清单，勾选 Apply 才启用。
 *  4. **保存语义就近分层**：模型启用 / 删除 / 参数编辑立即落盘（mutateModels），
 *     Save 只管身份字段（名称 / URL / key）。
 */
export function ProvidersView(props: { onChange?: () => void }) {
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 右栏三态：详情 / 选厂商目录 / 新建表单 */
  const [view, setView] = useState<{ kind: "detail" } | { kind: "catalog" } | { kind: "new"; kindId: string }>({
    kind: "detail",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [status, setStatus] = useState<{ tone: "ok" | "bad" | "busy"; text: string } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** 正等待二次确认删除的模型 id；一次只有一条，点别的行的 trash 就换成那条 */
  const [confirmRemoveModel, setConfirmRemoveModel] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  /** Fetch 多选清单：null = 收起。ids 已过滤掉已启用项 */
  const [discovered, setDiscovered] = useState<{ ok: boolean; ids: string[]; message: string } | null>(null);
  /** 行内单模型测试：按模型 id 各自独立——可以同时测多个模型，互不顶掉 */
  const [modelTests, setModelTests] = useState<Record<string, { tone: "ok" | "bad" | "busy"; text: string }>>({});
  /** 模型弹窗：isNew = 新增（弹窗内填 id），否则编辑 id 指向的已启用模型 */
  const [editor, setEditor] = useState<{ isNew: boolean; id: string | null } | null>(null);
  /** pi 内建目录，按 catalogId 取官方模型清单——离线就有，不用打网络 */
  const [catalog, setCatalog] = useState<BuiltinProvider[]>([]);
  /** 拖拽排序中的厂商行 id；null = 没在拖 */
  const [dragId, setDragId] = useState<string | null>(null);
  /** 小框高亮的目标行：框住谁，松手就落到谁的位置 */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** onChange 走 ref：refresh 必须引用稳定——若依赖 props 对象，父组件每次渲染都会让它重建，
   * effect 随之重跑 IPC，成功后又经 onChange 拉动父组件重渲，形成「渲染 → IPC → 渲染」死循环
   * （2026-09-10 真实事故：Providers 页被渲染风暴占满主线程，所有按钮点击被挤掉，表现为点了没反应）。 */
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;

  const refresh = useCallback(async () => {
    try {
      const list = await api.provider.list();
      setProviders(list);
      onChangeRef.current?.();
      setError(null);
      // 当前选中的没了（刚被删 / 首次进入）→ 落到第一个，右栏永远有着落
      setSelectedId((cur) => (cur !== null && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void api.provider.builtins().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  // 弹窗开着时 Escape 关闭（与点遮罩 / Cancel 同语义）
  useEffect(() => {
    if (editor === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEditor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor]);

  /**
   * 详情态的草稿自愈：首次进入时 refresh 自动选中第一个厂商，但草稿还没装——
   * 不装的话 draft.kind 为空、known 为 undefined，连接区直接不渲染。
   * 以 draft.id 是否已指向选中项为准，不会冲掉用户未保存的输入。
   */
  useEffect(() => {
    if (view.kind !== "detail" || selectedId === null) return;
    if (draft.id === selectedId) return;
    const provider = providers?.find((x) => x.id === selectedId);
    if (provider !== undefined) loadDraft(provider);
  }, [view, selectedId, providers, draft.id]);

  const isNew = view.kind === "new";
  const editingId = view.kind === "detail" ? selectedId : null;
  const editing = editingId === null ? undefined : providers?.find((p) => p.id === editingId);
  const known = KNOWN_PROVIDERS.find((k) => k.id === draft.kind);
  const showForm = (view.kind === "detail" && editing !== undefined) || (isNew && known !== undefined);
  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  /** 目录里这个模型 id 的官方参数（自建网关没有 catalogId，查不到——如实走兜底） */
  const catalogMeta = (target: KnownProvider | undefined, id: string): BuiltinModel | undefined =>
    target?.catalogId === undefined
      ? undefined
      : catalog.find((c) => c.id === target.catalogId)?.models.find((m) => m.id === id);
  /** 某个已适配 provider 在 pi 目录里的模型 id 清单（Fetch 的兜底候选池） */
  const catalogIds = (target: KnownProvider | undefined): string[] =>
    target?.catalogId === undefined
      ? []
      : (catalog.find((c) => c.id === target.catalogId)?.models ?? []).map((m) => m.id);

  const withKey = () => ({
    ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
    ...(editingId === null ? {} : { providerId: editingId }),
  });

  /**
   * 网关要求的额外请求头（如 OpenCode Go 的会话头）：真实会话与测试 / 发现**同源**——
   * 已存 endpoint 的优先，目录预设兜底（老 provider 没存过 headers 也能吃到新预设）。
   */
  const endpointHeaders = editing?.endpoint.headers ?? known?.headers;
  const withHeaders = () => (endpointHeaders === undefined ? {} : { headers: endpointHeaders });

  /** 从盘上的 provider 装载身份草稿（切左栏行 / Cancel 回滚共用） */
  const loadDraft = (provider: ProviderDto) => {
    setDraft({
      kind: kindOf(provider),
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.endpoint.baseUrl,
      models: provider.models.declared.map((m) => ({ ...m })),
      apiKey: "",
    });
  };

  const resetTransient = () => {
    setIssues([]);
    setStatus(null);
    setRevealed(false);
    setDiscovered(null);
    setConfirmRemove(false);
    setConfirmRemoveModel(null);
    setModelTests({});
    setEditor(null);
  };

  const selectProvider = (id: string) => {
    const provider = providers?.find((p) => p.id === id);
    if (provider === undefined) return;
    setSelectedId(id);
    setView({ kind: "detail" });
    resetTransient();
    loadDraft(provider);
  };

  /** 拖拽排序：本地先重排（跟手），再落盘——写失败时 refresh 拉回盘上顺序 */
  const reorderProviders = async (from: string | null, to: string) => {
    if (providers === null || from === null) return;
    const nextIds = reorderIds(
      providers.map((p) => p.id),
      from,
      to,
    );
    const rank = new Map(nextIds.map((id, i) => [id, i]));
    setProviders([...providers].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)));
    try {
      await api.provider.reorder([...nextIds]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh();
    }
  };

  const openCatalog = () => {
    setView({ kind: "catalog" });
    resetTransient();
  };

  /** 选目录条目：baseUrl 与协议一并定下，用户只剩名称、key、模型 */
  const pickKnown = (kindId: string) => {
    const target = KNOWN_PROVIDERS.find((k) => k.id === kindId);
    setView({ kind: "new", kindId });
    resetTransient();
    // 候选池留空，等 Fetch 去问供应商——目录按厂商组织，分不清套餐
    setDraft({
      kind: kindId,
      id: target?.id ?? "",
      displayName: target?.label ?? "",
      baseUrl: target?.baseUrl ?? "",
      models: [],
      apiKey: "",
    });
  };

  const cancelSide = () => {
    setView({ kind: "detail" });
    resetTransient();
    const current = editingId === null ? providers?.find((p) => p.id === selectedId) : editing;
    if (current !== undefined) loadDraft(current);
  };

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

  /**
   * 取模型清单。**目录优先，网络兜底**：pi 的目录是离线的、比网关的 /models 更新
   * （实测 zhipu 的目录有 glm-5.3，而 anthropic 兼容端点的 /models 返回 200 包着 404）。
   */
  const fetchModels = () =>
    guard("Fetching models…", async () => {
      const result = await api.provider.discover({
        baseUrl: draft.baseUrl.trim(),
        api: known?.api ?? "openai-completions",
        ...withKey(),
        ...withHeaders(),
      });
      if (result.ok) {
        setDiscovered({
          ok: true,
          ids: result.models.filter((m) => !draft.models.some((d) => d.id === m)),
          message: result.message,
        });
        return { tone: "ok" as const, text: result.message };
      }
      const fromCatalog = catalogIds(known);
      if (fromCatalog.length === 0) return { tone: "bad" as const, text: result.message };
      setDiscovered({
        ok: false,
        ids: fromCatalog.filter((m) => !draft.models.some((d) => d.id === m)),
        message: result.message,
      });
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
        ...withHeaders(),
      });
      return { tone: result.ok ? ("ok" as const) : ("bad" as const), text: result.message };
    });

  /** 行内单模型测试：状态收在行内（图标转圈 / 结果徽标），不动布局。
   * 按模型 id 独立——连续点多个模型就是并行测试，谁也不顶谁。
   * 成功徽标 2.5s 后自动消失；失败原因留在行下，直到重测或切换。 */
  const testModel = (id: string) => {
    setModelTests((prev) => ({ ...prev, [id]: { tone: "busy", text: "Testing…" } }));
    api.provider
      .test({ api: known?.api ?? "openai-completions", baseUrl: draft.baseUrl.trim(), modelId: id, ...withKey(), ...withHeaders() })
      .then((result) => {
        setModelTests((prev) => ({ ...prev, [id]: { tone: result.ok ? "ok" : "bad", text: result.message } }));
        if (result.ok) dismissLater(id);
      })
      .catch((cause) => {
        setModelTests((prev) => ({
          ...prev,
          [id]: { tone: "bad", text: cause instanceof Error ? cause.message : String(cause) },
        }));
      });
  };

  const dismissLater = (id: string) =>
    setTimeout(() => setModelTests((prev) => {
      if (prev[id] === undefined || prev[id].tone === "busy") return prev;
      const { [id]: _drop, ...rest } = prev;
      return rest;
    }), 2500);

  const toggleReveal = async () => {
    if (revealed) {
      // 只收起显示（type 回 password），**不动 draft**——用户改过的字符不能被弹回
      setRevealed(false);
      return;
    }
    if (draft.apiKey !== "") {
      // 粘贴过的：直接明文显示，它本来就是可编辑的草稿
      setRevealed(true);
      return;
    }
    if (editingId === null) return;
    const stored = await api.provider.reveal(editingId);
    if (stored === null) return;
    // 已存 key 的「Show」= 把明文拉进输入框当**可编辑草稿**（wafo 2026-09-03）
    setDraft((d) => ({ ...d, apiKey: stored }));
    setRevealed(true);
  };

  /**
   * 模型层变更的就地落盘（约束 4）：已存在的 provider 立即 read-modify-write——
   * Enable / Remove / 弹窗 Apply 都不等表单底部的 Save。以**盘上的 provider** 为底
   * 合并，不夹带身份字段的未保存改动；还没落盘的新建 provider 只动草稿。
   * 返回是否成功（失败时 issues 已就位）。
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
        endpoint: {
          baseUrl: draft.baseUrl.trim(),
          api: known?.api ?? "openai-completions",
          ...(endpointHeaders === undefined ? {} : { headers: endpointHeaders }),
        },
        models: { declared: draft.models },
        auth: { scheme: "api_key" },
      },
      ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
    });
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setSavedAt(Date.now());
    setIssues([]);
    if (editingId === null) {
      // 新建落盘：切到它的详情
      setSelectedId(draft.id.trim());
      setView({ kind: "detail" });
      resetTransient();
    }
    await refresh();
    const fresh = await api.provider.list();
    const updated = fresh.find((p) => p.id === draft.id.trim());
    if (updated !== undefined) loadDraft(updated);
  };

  /**
   * 多账号场景：复制当前详情页的**全部现状**——包括还没 Save 的名称 / URL 修改与
   * 模型配置草稿。唯一例外是 key：一律不带（复制就是为了填另一把）。
   * scheme 落 "none"，新副本填了 key 走 Save 才升级成 api_key。
   */
  const copyProvider = async () => {
    if (editing === undefined) return;
    const id = nextCopyId((providers ?? []).map((p) => p.id), editing.id);
    const name = draft.displayName.trim() || editing.displayName;
    const baseUrl = draft.baseUrl.trim() || editing.endpoint.baseUrl;
    try {
      const result = await api.provider.upsert({
        provider: {
          id,
          displayName: `${name} (copy)`,
          endpoint: {
            baseUrl,
            api: known?.api ?? editing.endpoint.api,
            ...(editing.endpoint.headers === undefined ? {} : { headers: editing.endpoint.headers }),
          },
          models: {
            declared: draft.models.map((m) => ({
              ...m,
              ...(m.cost === undefined ? {} : { cost: { ...m.cost } }),
            })),
          },
          auth: { scheme: "none" },
        },
      });
      if (!result.ok) {
        setIssues(result.issues);
        return;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setSelectedId(id);
    setView({ kind: "detail" });
    resetTransient();
    setDraft({
      kind: kindOf(editing),
      id,
      displayName: `${name} (copy)`,
      baseUrl,
      models: draft.models.map((m) => ({ ...m })),
      apiKey: "",
    });
    await refresh();
  };

  const removeProvider = async () => {
    if (selectedId === null) return;
    try {
      await api.provider.remove(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setView({ kind: "detail" });
    resetTransient();
    await refresh();
  };

  /** 模型弹窗 Apply：decl 只带「用户填了的」覆盖字段，留空 = 继承目录 / 兜底 */
  const applyModel = (decl: ModelDecl) => {
    void mutateModels((models) =>
      editor?.isNew === true
        ? [...models, decl]
        : models.map((m) => (m.id === decl.id ? decl : m)),
    ).then((ok) => {
      if (ok) setEditor(null);
    });
  };

  const sorted = providers ?? [];
  const editorDecl =
    editor === null || editor.isNew ? undefined : draft.models.find((m) => m.id === editor.id);

  return (
    <section className="pv-root">
      <div className="pv-master">
        <nav className="pv-nav">
        <span className="pv-sec-label">Providers</span>
        <div
          className="pv-list"
          onDragLeave={(e) => {
            // relatedTarget 是拖拽进入的下一个元素——还在列表里就不收线
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
          }}
        >
          {sorted.length === 0 && <div className="pv-nav-empty">No providers yet.</div>}
          {sorted.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={`pv-row${view.kind === "detail" && provider.id === selectedId ? " on" : ""}${provider.id === dragId ? " dragging" : ""}${dropTarget === provider.id ? " drop-on" : ""}`}
              title={provider.displayName}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", provider.id);
                e.dataTransfer.effectAllowed = "move";
                setDragId(provider.id);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDropTarget(null);
              }}
              onDragOver={(e) => {
                if (dragId === null || dragId === provider.id) return;
                e.preventDefault();
                // 同值返回让 React 跳过无谓的重渲——dragover 事件是高频的
                setDropTarget((cur) => (cur === provider.id ? cur : provider.id));
              }}
              onDrop={(e) => {
                e.preventDefault();
                void reorderProviders(dragId, provider.id);
                setDropTarget(null);
              }}
              onClick={() => selectProvider(provider.id)}
            >
              <span
                className={`pv-dot ${provider.auth.scheme === "api_key" && provider.auth.hasSecret ? "ok" : "none"}`}
                title={
                  provider.auth.scheme === "api_key" && provider.auth.hasSecret
                    ? "API key configured"
                    : "No API key yet"
                }
              />
              <span className="pv-row-main">
                <span className="pv-row-name">{provider.displayName}</span>
                <span className="pv-row-sub">{hostOf(provider.endpoint.baseUrl)}</span>
              </span>
              <span className="pv-row-count" title={`${provider.models.declared.length} models`}>
                {provider.models.declared.length}
              </span>
            </button>
          ))}
        </div>
        <button type="button" className="pv-btn pv-add" onClick={openCatalog}>
          <Icon name="plus" size={14} /> Add provider
        </button>
      </nav>

      <div className="pv-detail">
        {error !== null && (
          <div className="pv-head">
            <span className="pv-status bad">
              {error}{" "}
              <button type="button" className="pv-btn sm" onClick={() => void refresh()}>
                Retry
              </button>
            </span>
          </div>
        )}
        {error === null && providers === null && (
          <div className="pv-head">
            <span className="pv-status busy">Loading providers…</span>
          </div>
        )}
        {error === null && providers !== null && sorted.length === 0 && view.kind === "detail" && (
          <div className="pv-empty">
            <p style={{ margin: 0 }}>No provider yet.</p>
            <button type="button" className="pv-btn" onClick={openCatalog}>
              <Icon name="plus" size={14} /> Add provider
            </button>
          </div>
        )}

        {view.kind === "catalog" && <CatalogView onCancel={cancelSide} onPick={pickKnown} />}

        {isNew && (
          <div className="pv-head">
            <span className="pv-title">{draft.displayName || "New provider"}</span>
            <span className="pv-headend">
              <button type="button" className="pv-btn" onClick={cancelSide}>
                Cancel
              </button>
            </span>
          </div>
        )}

        {showForm && known !== undefined && (
          <>
            {!isNew && (
              <div className="pv-head">
                <span className="pv-title">{draft.displayName || editing?.displayName}</span>
                <span className="pv-headend">
                  {confirmRemove ? (
                    <>
                      <button
                        type="button"
                        className="pv-btn icon danger-solid"
                        title="Click again to confirm remove"
                        onClick={() => void removeProvider()}
                      >
                        <Icon name="trash-2" size={15} />
                      </button>
                      <button
                        type="button"
                        className="pv-btn icon"
                        title="Cancel remove"
                        onClick={() => setConfirmRemove(false)}
                      >
                        <Icon name="x" size={15} />
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="pv-btn icon"
                        title="Duplicate this provider with its current settings — then fill a different API key"
                        onClick={() => void copyProvider()}
                      >
                        <Icon name="copy" size={15} />
                      </button>
                      <button
                        type="button"
                        className="pv-btn icon danger"
                        title="Remove this provider"
                        onClick={() => setConfirmRemove(true)}
                      >
                        <Icon name="trash-2" size={15} />
                      </button>
                    </>
                  )}
                </span>
              </div>
            )}
            <div className="pv-body">
              <span className="pv-sec-label">Connection</span>
              <div className="pv-fields" style={{ marginTop: 0 }}>
                <div className="pv-field">
                  <label htmlFor="pv-name">Name</label>
                  <input
                    id="pv-name"
                    className="pv-input"
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  />
                </div>
                <div className="pv-field">
                  <label>API format</label>
                  <div
                    className="pv-locked"
                    title="The API protocol is decided by the provider preset — there is no protocol selector; changing it means a new entry"
                  >
                    <Icon name="lock" size={13} strokeWidth={1.8} />
                    {known.api}
                  </div>
                  <span className="pv-sub">
                    Decided by the provider preset — switch protocol by switching the entry.
                  </span>
                </div>
                <div className="pv-field">
                  <label htmlFor="pv-url">Base URL</label>
                  <input
                    id="pv-url"
                    className="pv-input"
                    value={draft.baseUrl}
                    placeholder="https://…"
                    onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  />
                  <span className="pv-sub">
                    {known.api === "anthropic-messages"
                      ? "The client appends /v1/messages."
                      : "The client appends /chat/completions."}
                  </span>
                  {issueFor("endpoint.baseUrl") !== undefined && (
                    <span className="pv-sub" style={{ color: "var(--color-danger)" }}>
                      {issueFor("endpoint.baseUrl")}
                    </span>
                  )}
                </div>
                <div className="pv-field">
                  <label htmlFor="pv-key">API key</label>
                  <div className="pv-krow">
                    <input
                      id="pv-key"
                      className="pv-input"
                      type={revealed ? "text" : "password"}
                      value={draft.apiKey}
                      placeholder={
                        !isNew && editing?.auth.scheme === "api_key" && editing.auth.masked !== null
                          ? `Saved — ${editing.auth.masked}`
                          : "Paste your API key"
                      }
                      onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                    />
                    <button
                      type="button"
                      className="pv-btn icon"
                      aria-label={revealed ? "Hide key" : "Show key"}
                      title={revealed ? "Hide key" : "Show key"}
                      onClick={() => void toggleReveal()}
                    >
                      <Icon name={revealed ? "eye-off" : "eye"} size={15} strokeWidth={1.8} />
                    </button>
                    <button type="button" className="pv-btn" onClick={() => void test()}>
                      <Icon name="zap" size={14} /> Test
                    </button>
                  </div>
                  {status !== null && <Line tone={status.tone}>{status.text}</Line>}
                </div>
              </div>

              <div className="pv-mhead">
                <span className="pv-sec-label">Models · {draft.models.length}</span>
                <button
                  type="button"
                  className="pv-btn sm"
                  title="Add a model by id"
                  onClick={() => setEditor({ isNew: true, id: null })}
                >
                  <Icon name="plus" size={13} strokeWidth={1.8} /> Add
                </button>
                {discovered === null && (
                  <button
                    type="button"
                    className="pv-btn sm"
                    disabled={draft.baseUrl.trim() === ""}
                    title="Fetch the model list from the provider"
                    onClick={() => void fetchModels()}
                  >
                    <Icon name="refresh-cw" size={13} strokeWidth={1.8} /> Fetch list
                  </button>
                )}
              </div>
              {issueFor("models.declared") !== undefined && (
                <span className="pv-sub" style={{ color: "var(--color-danger)" }}>
                  {issueFor("models.declared")}
                </span>
              )}
              {discovered !== null && (
                <FetchPanel
                  discovered={discovered}
                  existing={draft.models.map((m) => m.id)}
                  onApply={(picked) => {
                    void mutateModels((models) => {
                      const add = picked
                        .filter((id) => !models.some((m) => m.id === id))
                        .map((id) => ({ id }) as ModelDecl);
                      return [...models, ...add];
                    }).then((ok) => {
                      if (ok) setDiscovered(null);
                    });
                  }}
                  onCancel={() => setDiscovered(null)}
                />
              )}
              <div className="pv-mlist">
                {draft.models.length === 0 ? (
                  <div className="pv-mempty">No models yet — fetch the list, or add one by id.</div>
                ) : (
                  draft.models.map((model) => {
                    const meta = catalogMeta(known, model.id);
                    const badge = modelContextText(model, meta, knownModelParams(model.id));
                    const tested = modelTests[model.id];
                    const busy = tested?.tone === "busy";
                    return (
                      <div className="pv-mitem" key={model.id}>
                        <div className="pv-mrow">
                          <span className="pv-grow">
                            {model.name !== undefined && <span className="pv-mname">{model.name}</span>}
                            <span className={`pv-mid${model.name !== undefined ? " dim" : ""}`} title={model.id}>
                              {model.id}
                            </span>
                            <span className="pv-badges">
                              {tested !== undefined && tested.tone !== "busy" && (
                                <span
                                  className={`pv-badge pv-test-${tested.tone}`}
                                  title={tested.tone === "bad" ? "See the failure reason below" : tested.text}
                                >
                                  {tested.tone === "ok" ? (
                                    <>
                                      <Icon name="check" size={11} /> Success
                                    </>
                                  ) : (
                                    <>
                                      <Icon name="triangle-alert" size={11} /> Failed
                                    </>
                                  )}
                                </span>
                              )}
                              <span
                                className="pv-badge"
                                title={
                                  badge.fallback
                                    ? "Not in the catalog — showing the 128k / 8k fallback"
                                    : "Context window"
                                }
                              >
                                {badge.text}
                              </span>
                              {model.vision === true && (
                                <span className="pv-badge" title="Accepts image input — multimodal">
                                  <Icon name="image" size={11} strokeWidth={1.8} />
                                </span>
                              )}
                            </span>
                          </span>
                          <span className="pv-acts">
                            <button
                              type="button"
                              className="pv-btn icon sm"
                              title={busy ? "Testing…" : `Test ${model.id}`}
                              onClick={() => testModel(model.id)}
                            >
                              <Icon name={busy ? "loader-circle" : "zap"} size={13} strokeWidth={1.8} spin={busy} />
                            </button>
                            <button
                              type="button"
                              className="pv-btn icon sm"
                              title={`Edit ${model.id}`}
                              onClick={() => setEditor({ isNew: false, id: model.id })}
                            >
                              <Icon name="pencil-line" size={13} strokeWidth={1.8} />
                            </button>
                            {confirmRemoveModel === model.id ? (
                              <>
                                {/* 与 provider 删除同款的两段式：一点就没是破坏性动作的禁忌（2026-09-11 验收发现） */}
                                <button
                                  type="button"
                                  className="pv-btn icon sm danger-solid"
                                  title={`Click again to remove ${model.id}`}
                                  onClick={() => {
                                    setConfirmRemoveModel(null);
                                    void mutateModels((models) => models.filter((m) => m.id !== model.id));
                                  }}
                                >
                                  <Icon name="trash-2" size={13} strokeWidth={1.8} />
                                </button>
                                <button
                                  type="button"
                                  className="pv-btn icon sm"
                                  title="Cancel remove"
                                  onClick={() => setConfirmRemoveModel(null)}
                                >
                                  <Icon name="x" size={13} strokeWidth={1.8} />
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className="pv-btn icon sm danger"
                                title={`Remove ${model.id}`}
                                onClick={() => setConfirmRemoveModel(model.id)}
                              >
                                <Icon name="trash-2" size={13} strokeWidth={1.8} />
                              </button>
                            )}
                          </span>
                        </div>
                        {tested !== undefined && tested.tone === "bad" && (
                          <div className="pv-mreason" role="status">
                            <Icon name="triangle-alert" size={12} />
                            <span>{tested.text}</span>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            <div className="pv-foot">
              <span className="pv-hint">
                Save applies name, base URL and key. Model changes apply immediately.
              </span>
              {Date.now() - savedAt < 1800 && (
                <span className="pv-saved">
                  <Icon name="check" size={12} /> Saved
                </span>
              )}
              <button type="button" className="pv-btn" onClick={cancelSide}>
                Cancel
              </button>
              <button type="button" className="pv-btn accent" onClick={() => void save()}>
                {isNew ? "Add provider" : "Save changes"}
              </button>
            </div>
          </>
        )}
      </div>
      </div>

      {editor !== null && known !== undefined && (
        <div className="pv-modal-root">
          <ModelDialog
            known={known}
            catalog={catalog}
            decl={editorDecl}
            existingIds={draft.models.map((m) => m.id)}
            plan={isPlanBilling(known.id)}
            onApply={applyModel}
            onClose={() => setEditor(null)}
          />
        </div>
      )}
    </section>
  );
}

/** catalog 里没有这家时的 kind 兜底由 providers-view-model 的 kindOf 提供——设置页与聊天底栏共用 */

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 目录视图：KNOWN_PROVIDERS 的轻量清单——协议跟随条目，没有协议选择框 */
function CatalogView(props: { onCancel: () => void; onPick: (kindId: string) => void }) {
  return (
    <>
      <div className="pv-head">
        <span className="pv-title">Add provider</span>
        <span className="pv-headend">
          <button type="button" className="pv-btn" onClick={props.onCancel}>
            Cancel
          </button>
        </span>
      </div>
      <div className="pv-body">
        <span className="pv-sec-label">Choose a provider</span>
        <p className="pv-note" style={{ marginTop: "var(--space-2)" }}>
          Only adapters verified against real endpoints are listed. The protocol follows the entry you
          pick — there is no protocol selector.
        </p>
        <div className="pv-catalog">
          {KNOWN_PROVIDERS.map((k) => (
            <button key={k.id} type="button" className="pv-crow" onClick={() => props.onPick(k.id)}>
              <span className="pv-crow-main">
                <span className="pv-crow-name">{k.label}</span>
                <span className="pv-crow-note">{k.note}</span>
              </span>
              <span className="pv-badge">{k.api}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="pv-foot">
        <span className="pv-hint">Model parameters come from the built-in catalog when the entry has one.</span>
      </div>
    </>
  );
}

/** Fetch 多选清单：搜索过滤、已启用项标 Added 并锁住、勾选批量启用 */
function FetchPanel(props: {
  discovered: { ok: boolean; ids: string[]; message: string };
  existing: readonly string[];
  onApply: (picked: string[]) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const d = props.discovered;
  const q = query.trim().toLowerCase();
  const ids = d.ids.filter((id) => q === "" || id.toLowerCase().includes(q));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  return (
    <div className="pv-fetch">
      <div className="pv-fetch-search">
        <Icon name="search" size={14} />
        <input
          className="pv-input"
          placeholder="Filter models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="pv-fetch-list">
        {ids.length === 0 ? (
          <div className="pv-mempty">No models match.</div>
        ) : (
          ids.map((id) => {
            const has = props.existing.includes(id);
            return (
              <label key={id} className={`pv-frow${has ? " has" : ""}`}>
                <input
                  type="checkbox"
                  checked={has || picked.has(id)}
                  disabled={has}
                  onChange={(e) => toggle(id, e.target.checked)}
                />
                <span className="pv-mid">{id}</span>
                {has && (
                  <span className="pv-added">
                    <Icon name="check" size={11} /> Added
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>
      <div className="pv-fetch-foot">
        <span className="pv-fetch-count">
          {picked.size} selected · {d.ids.length} found
        </span>
        <button type="button" className="pv-btn sm" onClick={props.onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="pv-btn sm accent"
          disabled={picked.size === 0}
          onClick={() => props.onApply([...picked])}
        >
          Add {picked.size > 0 ? picked.size : ""} selected
        </button>
      </div>
      <span className="pv-sub">{d.message}</span>
    </div>
  );
}

/**
 * 模型弹窗（Add / Edit 同一件）。**输入框只装用户覆盖值**：留空 = 继承目录 / 兜底，
 * placeholder 显示继承来的数——显示与数据不混在一根管子里。
 * Apply 时把 id / 名称 / 图片能力 / ctx / out / 费率合成一份 ModelDecl 交给父级落盘。
 */
function ModelDialog(props: {
  known: KnownProvider;
  catalog: BuiltinProvider[];
  decl: ModelDecl | undefined;
  existingIds: readonly string[];
  plan: boolean;
  onApply: (decl: ModelDecl) => void;
  onClose: () => void;
}) {
  const isNew = props.decl === undefined;
  const meta = (id: string): BuiltinModel | undefined =>
    props.known.catalogId === undefined
      ? undefined
      : props.catalog.find((c) => c.id === props.known.catalogId)?.models.find((m) => m.id === id);
  const [idValue, setIdValue] = useState(props.decl?.id ?? "");
  const [name, setName] = useState(props.decl?.name ?? "");
  const [ctxText, setCtxText] = useState(props.decl?.contextWindow?.toString() ?? "");
  const [outText, setOutText] = useState(props.decl?.maxTokens?.toString() ?? "");
  const [cinText, setCinText] = useState(props.decl?.cost?.input?.toString() ?? "");
  const [coutText, setCoutText] = useState(props.decl?.cost?.output?.toString() ?? "");
  const [vision, setVision] = useState<"inherit" | "on" | "off">(
    props.decl?.vision === true ? "on" : props.decl?.vision === false ? "off" : "inherit",
  );
  const [idIssue, setIdIssue] = useState<string | null>(null);
  const [fieldIssue, setFieldIssue] = useState<string | null>(null);

  // 新增：id 命中内置目录时，placeholder 处的继承值跟着换（不填输入框——填了就成了覆盖声明）
  const activeMeta = meta(idValue.trim().toLowerCase());
  const inheritCtx = props.decl?.contextWindow ?? activeMeta?.contextWindow;
  const inheritOut = props.decl?.maxTokens ?? activeMeta?.maxTokens;

  const apply = () => {
    const finalId = isNew ? idValue.trim().toLowerCase() : (props.decl?.id ?? "");
    if (isNew) {
      const shapeIssue = modelIdIssue(finalId);
      if (shapeIssue !== null) {
        setIdIssue(shapeIssue);
        return;
      }
      if (props.existingIds.includes(finalId)) {
        setIdIssue(`"${finalId}" is already enabled.`);
        return;
      }
    }
    const ctx = parseTokenInput(ctxText);
    const out = parseTokenInput(outText);
    const cin = parseRateInput(cinText);
    const cout = parseRateInput(coutText);
    if (ctx === "invalid" || out === "invalid" || cin === "invalid" || cout === "invalid") {
      setFieldIssue("Context, output and rates must be numbers (tokens accept 128k / 1M; rates ≥ 0).");
      return;
    }
    const decl: ModelDecl = { id: finalId };
    const trimmedName = name.trim();
    if (trimmedName !== "") decl.name = trimmedName;
    if (ctx !== undefined) decl.contextWindow = ctx;
    if (out !== undefined) decl.maxTokens = out;
    const cost = mergeModelCost(props.decl?.cost, activeMeta, { input: cin, output: cout });
    if (cost !== undefined) decl.cost = cost;
    if (vision === "on") decl.vision = true;
    if (vision === "off") decl.vision = false;
    props.onApply(decl);
  };

  return (
    <div
      className="pv-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="pv-modal" role="dialog" aria-modal="true" aria-label={isNew ? "Add model" : "Edit model"}>
        <div className="pv-modal-head">
          <strong>{isNew ? "Add model" : "Edit model"}</strong>
          <button type="button" className="pv-btn icon" title="Close" onClick={props.onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="pv-modal-body">
          <div className="pv-field">
            <label htmlFor="pv-model-id">Model id</label>
            {isNew ? (
              <>
                <input
                  id="pv-model-id"
                  className="pv-input pv-mono"
                  value={idValue}
                  placeholder="e.g. glm-5.3-flash"
                  spellCheck={false}
                  onChange={(e) => {
                    setIdValue(e.target.value);
                    setIdIssue(null);
                  }}
                  style={idIssue !== null ? { borderColor: "var(--color-danger)" } : undefined}
                />
                <span className="pv-sub">
                  Lowercase letters, digits, dots and dashes. Matching a built-in catalog entry inherits
                  its official parameters — leave fields empty to use them.
                </span>
                {idIssue !== null && (
                  <span className="pv-sub" style={{ color: "var(--color-danger)" }}>
                    {idIssue}
                  </span>
                )}
              </>
            ) : (
              <div
                className="pv-locked"
                title="Model id is its identity and cannot be edited — delete and re-add to change it"
              >
                <Icon name="lock" size={13} strokeWidth={1.8} />
                {props.decl?.id}
              </div>
            )}
          </div>
          <div className="pv-field">
            <label htmlFor="pv-model-name">Display name</label>
            <input
              id="pv-model-name"
              className="pv-input"
              value={name}
              placeholder="Optional — shown before the id on the row"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="pv-field">
            <label>Image input</label>
            <div role="group" aria-label="Image input" style={{ display: "flex", gap: 2 }}>
              {(
                [
                  ["inherit", "Inherit"],
                  ["on", "On"],
                  ["off", "Off"],
                ] as const
              ).map(([value, label]) => (
                <Chip
                  key={value}
                  active={vision === value}
                  onClick={() => setVision(value)}
                >
                  {label}
                </Chip>
              ))}
            </div>
            <span className="pv-sub">
              Multimodal image input — Inherit follows the catalog (unknown = text only). Vision models
              show an image badge on the row.
            </span>
          </div>
          <div className="pv-grid2">
            <div className="pv-field">
              <label htmlFor="pv-model-ctx">Context window</label>
              <input
                id="pv-model-ctx"
                className="pv-input pv-mono"
                value={ctxText}
                placeholder={inheritCtx !== undefined ? `Inherit (${inheritCtx})` : "Inherit"}
                onChange={(e) => setCtxText(e.target.value)}
              />
              <span className="pv-sub">tokens — accepts 128000 or 128k / 1M</span>
            </div>
            <div className="pv-field">
              <label htmlFor="pv-model-out">Max output</label>
              <input
                id="pv-model-out"
                className="pv-input pv-mono"
                value={outText}
                placeholder={inheritOut !== undefined ? `Inherit (${inheritOut})` : "Inherit"}
                onChange={(e) => setOutText(e.target.value)}
              />
              <span className="pv-sub">tokens</span>
            </div>
            <div className="pv-field">
              <label htmlFor="pv-model-cin">Input cost</label>
              <input
                id="pv-model-cin"
                className="pv-input pv-mono"
                value={cinText}
                placeholder={activeMeta !== undefined ? `Inherit ($${activeMeta.cost.input}/M)` : "Inherit"}
                onChange={(e) => setCinText(e.target.value)}
              />
              <span className="pv-sub">$ per 1M tokens</span>
            </div>
            <div className="pv-field">
              <label htmlFor="pv-model-cout">Output cost</label>
              <input
                id="pv-model-cout"
                className="pv-input pv-mono"
                value={coutText}
                placeholder={activeMeta !== undefined ? `Inherit ($${activeMeta.cost.output}/M)` : "Inherit"}
                onChange={(e) => setCoutText(e.target.value)}
              />
              <span className="pv-sub">$ per 1M tokens</span>
            </div>
          </div>
          <span className="pv-sub">
            {isNew
              ? "Leave fields empty to inherit the built-in catalog when the id matches; otherwise 128k ctx / 8k out."
              : activeMeta === undefined
                ? "No catalog entry — leave empty to fall back to 128k ctx / 8k out."
                : "Source: built-in catalog."}
            {props.plan ? " This provider bills by plan: cost estimates are not shown on rows." : ""}
          </span>
          {fieldIssue !== null && (
            <span className="pv-sub" style={{ color: "var(--color-danger)" }}>
              {fieldIssue}
            </span>
          )}
        </div>
        <div className="pv-modal-foot">
          <button
            type="button"
            className="pv-btn"
            title="Clear overrides — values fall back to the catalog / built-in defaults"
            onClick={() => {
              setCtxText("");
              setOutText("");
              setCinText("");
              setCoutText("");
              setVision("inherit");
            }}
          >
            <Icon name="refresh-cw" size={13} strokeWidth={1.8} /> Reset to inherited
          </button>
          <span className="pv-spacer" />
          <button type="button" className="pv-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="button" className="pv-btn accent" onClick={apply}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

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

function emptyDraft() {
  return { kind: "", id: "", displayName: "", baseUrl: "", models: [] as ModelDecl[], apiKey: "" };
}
