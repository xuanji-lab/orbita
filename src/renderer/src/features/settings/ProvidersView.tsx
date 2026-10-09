import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import "./providers-view.css";
import { KNOWN_PROVIDERS, knownProviderDefaultName, type KnownProvider } from "@shared/known-providers";
import type { ProviderCardSize } from "@shared/settings";
import { resolveModelDefaults, type ModelDefaults } from "@shared/model-defaults";
import type { ModelDecl, ProviderDto, ValidationIssue } from "@shared/provider";
import type { BuiltinProvider } from "@shared/agent-ipc";
import { MODEL_ASSIGN_TARGET_GONE_CODE, type ModelAssignGroups, type ModelAssignRunResult } from "@shared/model-assign";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { InfoTip, useSettingTip } from "./InfoTip";
import {
  compactTokens,
  connectionDirty,
  hasCredentials,
  kindOf,
  mergeModelCost,
  modelAcceptsImage,
  modelContextText,
  modelIdIssue,
  nextCopyId,
  nextFreeId,
  parseRateInput,
  parseTokenInput,
  providerCards,
  reorderIds,
  type ProviderCard,
  urlSuffix,
} from "./providers-view-model.ts";
import { assignEntries, assignHint, assignPreview, type AssignPreview } from "./providers-assign.ts";
import { useT } from "../../locale.ts";
import { VendorLogo } from "./VendorLogo";

/**
 * Provider 设置面 —— 两层：**卡片墙**（每个目录条目一张卡，加过的挂「已添加」角标，顶部搜索 /
 * 仅显示已添加 / 大小两档）与**详情页**（点卡进入：这一家的实例标签 + 唯一编辑区）。
 * 同一家可以加多个实例（不同账号 / key）：卡片悬停的「+」与详情页的「再添加一个」都走 pickKnown，
 * id 由 nextFreeId 避撞，kind 字段记下它来自哪张卡。实例标签可拖动排序（模型菜单按这个顺序列）。
 * 说明文字能换成效果的都换了：协议是标题旁的锁形徽标、客户端要接的路径是 URL 框尾的灰字、
 * Save 条只在连接区有改动时出现，其余整句进悬停（InfoTip / useSettingTip）。
 *
 * 保留旧版的四条刻意约束（都是为了不重蹈 proma 那条路）：
 *  1. **没有协议选择框**——协议由「选哪个 provider」完全决定，让用户选第二次只会选错；
 *     右栏把协议显性展示成锁定字段（API format）。
 *  2. **目录只列适配过的**（KNOWN_PROVIDERS），不是 pi 的 41 个。
 *  3. **发现的模型要用户提升才算数**：Fetch 结果进多选清单，勾选 Apply 才启用。
 *  4. **保存语义就近分层**：模型启用 / 删除 / 参数编辑立即落盘（mutateModels），
 *     Save 只管身份字段（名称 / URL / key），所以它收在连接区里，而不是整页底栏。
 */
export function ProvidersView(props: {
  onChange?: () => void;
  onSessionsChanged?: () => void;
  /** 卡片墙的尺寸档（AppSettings.providerCardSize，缺席 = large）；切换即落设置 */
  cardSize: ProviderCardSize;
  onCardSize: (size: ProviderCardSize) => void;
}) {
  const t = useT();
  const [providers, setProviders] = useState<ProviderDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 页面四态：卡片墙 / 某个实例的详情 / 新建表单 / 给导入的会话分配模型 */
  const [view, setView] = useState<
    { kind: "grid" } | { kind: "detail" } | { kind: "new"; kindId: string } | { kind: "assign" }
  >({ kind: "grid" });
  /** 卡片墙的搜索词与「仅显示已添加」：只活在这一页，离开设置就清 */
  const [query, setQuery] = useState("");
  const [onlyAdded, setOnlyAdded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft());
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [status, setStatus] = useState<{ tone: "ok" | "bad" | "busy"; text: string } | null>(null);
  /** 正在跑的 guard 动作是不是 Test——按钮的转圈 / disabled 只认这个，不比对 status 文案 */
  const [testing, setTesting] = useState(false);
  /** Claude OAuth 登录进行中：等浏览器回调，可能长达几分钟 */
  const [loggingIn, setLoggingIn] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /** 正等待二次确认删除的模型 id；一次只有一条，点别的行的 trash 就换成那条 */
  const [confirmRemoveModel, setConfirmRemoveModel] = useState<string | null>(null);
  /** 「Show」从盘上拉进输入框的已存 key：原样未动时不算连接区的改动（connectionDirty） */
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  /** Fetch 多选清单：null = 收起。ids 已过滤掉已启用项 */
  const [discovered, setDiscovered] = useState<{ ids: string[] } | null>(null);
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

  // —— 给导入的会话分配模型（model-assign.ts）：分组只随会话变，挂载与分配后各读一次 ——
  const [assignGroups, setAssignGroups] = useState<ModelAssignGroups | null>(null);
  const [assignBusy, setAssignBusy] = useState(false);
  /** 上一轮分配的结果行；开着让用户看得到「配上了几个」，再进预览或离开本页才清 */
  const [assignDone, setAssignDone] = useState<ModelAssignRunResult | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);

  const loadAssignGroups = useCallback(() => {
    void api.session
      .modelAssignGroups()
      .then(setAssignGroups)
      .catch(() => setAssignGroups(null)); // 读不到当没有：不挡服务商页
  }, []);
  useEffect(() => {
    loadAssignGroups();
  }, [loadAssignGroups]);

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
  /** 这张目录卡走 OAuth 登录（目前只有 Claude 订阅）：表单不画密钥框，画登录钮 */
  const oauthEntry = known?.auth === "oauth";
  const oauthLoggedIn = editing?.auth.scheme === "oauth" && editing.auth.loggedIn;
  const showForm = (view.kind === "detail" && editing !== undefined) || (isNew && known !== undefined);
  const issueFor = (field: string) => issues.find((i) => i.field === field)?.message;
  /**
   * 这个模型 id 的生效参数基线（白名单 > pi 目录 > 兜底）。**按 id 跨目录查**：
   * 自建网关没有 catalogId，但它跑的 claude-opus-5 / k3 / glm-5.3 都有官方口径。
   */
  const modelDefaults = (target: KnownProvider | undefined, id: string): ModelDefaults =>
    resolveModelDefaults(catalog, id, { catalogId: target?.catalogId, api: target?.api });
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
    setRevealedKey(null);
  };

  const resetTransient = () => {
    setIssues([]);
    setRevealedKey(null);
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

  /** 回卡片墙：编辑区里没存的改动就此丢弃（与原来切走左栏行同一语义） */
  const backToGrid = () => {
    setView({ kind: "grid" });
    resetTransient();
  };

  /** 同一张卡下的实例（按存储顺序）：卡片角标、详情页标签共用这一个口径 */
  const instancesOfKind = (kindId: string): ProviderDto[] =>
    (providers ?? []).filter((provider) => kindOf(provider) === kindId);

  /** 点卡片：加过的进第一个实例的详情，没加过的直接开新建表单 */
  const openKind = (kindId: string) => {
    const first = instancesOfKind(kindId)[0];
    if (first === undefined) pickKnown(kindId);
    else selectProvider(first.id);
  };

  /** 打开分配预览：先拿一份最新分组（预览到确认之间会话可能又变） */
  const openAssign = () => {
    setView({ kind: "assign" });
    resetTransient();
    setAssignError(null);
    loadAssignGroups();
  };

  const runAssign = async () => {
    if (providers === null || assignGroups === null || assignBusy) return;
    const entries = assignEntries(assignPreview(assignGroups, providers));
    if (entries.length === 0) return;
    setAssignBusy(true);
    try {
      const result = await api.session.modelAssignRun(entries);
      setAssignDone(result);
      setView({ kind: "grid" });
      loadAssignGroups();
      // 左栏会话列表 / 正开着的会话用导入完成的同一条刷新通路（engine.refreshSessions）
      props.onSessionsChanged?.();
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      setAssignError(
        raw.startsWith(MODEL_ASSIGN_TARGET_GONE_CODE)
          ? t.providers.assignTargetGone(raw.slice(MODEL_ASSIGN_TARGET_GONE_CODE.length))
          : raw,
      );
    } finally {
      setAssignBusy(false);
    }
  };

  /** 选目录条目：baseUrl 与协议一并定下，用户只剩名称、key、模型 */
  const pickKnown = (kindId: string) => {
    const target = KNOWN_PROVIDERS.find((k) => k.id === kindId);
    setView({ kind: "new", kindId });
    resetTransient();
    // 候选池留空，等 Fetch 去问供应商——目录按厂商组织，分不清套餐
    setDraft({
      kind: kindId,
      // 同一条目可以加第二次：id 撞了就带序号，否则落盘会覆盖先加的那个
      id: target === undefined ? "" : nextFreeId((providers ?? []).map((p) => p.id), target.id),
      // 这一家已经有实例：名字带上序号，否则详情页的标签是两个一模一样的「DeepSeek」
      displayName:
        target === undefined
          ? ""
          : instancesOfKind(target.id).length === 0
            ? knownProviderDefaultName(target)
            : `${knownProviderDefaultName(target)} ${instancesOfKind(target.id).length + 1}`,
      baseUrl: target?.baseUrl ?? "",
      models: [],
      apiKey: "",
    });
  };

  /**
   * 取消：新建表单 → 回这一家的第一个实例（没有就回卡片墙）；分配预览 → 回卡片墙；
   * 详情页的 Save 条 → 原地把草稿拉回盘上的值。
   */
  const cancelSide = () => {
    if (view.kind === "new") {
      const first = instancesOfKind(view.kindId)[0];
      if (first === undefined) backToGrid();
      else selectProvider(first.id);
      return;
    }
    if (view.kind === "assign") {
      backToGrid();
      return;
    }
    resetTransient();
    if (editing !== undefined) loadDraft(editing);
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
    guard(t.providers.fetchingModels, async () => {
      const result = await api.provider.discover({
        baseUrl: draft.baseUrl.trim(),
        api: known?.api ?? "openai-completions",
        ...withKey(),
        ...withHeaders(),
      });
      if (result.ok) {
        setDiscovered({
          ids: result.models.filter((m) => !draft.models.some((d) => d.id === m)),
        });
        return { tone: "ok" as const, text: result.message };
      }
      const fromCatalog = catalogIds(known);
      if (fromCatalog.length === 0) return { tone: "bad" as const, text: result.message };
      setDiscovered({
        ids: fromCatalog.filter((m) => !draft.models.some((d) => d.id === m)),
      });
      return {
        tone: "bad" as const,
        text: t.providers.fetchFallback(result.message, fromCatalog.length),
      };
    });

  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      await guard(t.providers.testingConnection, async () => {
        const result = await api.provider.test({
          api: known?.api ?? "openai-completions",
          baseUrl: draft.baseUrl.trim(),
          modelId: draft.models[0]?.id ?? "",
          ...withKey(),
          ...withHeaders(),
        });
        return { tone: result.ok ? ("ok" as const) : ("bad" as const), text: result.message };
      });
    } finally {
      setTesting(false);
    }
  };

  /**
   * Claude OAuth 登录：登录即保存。主进程起回调服务器 + 开系统浏览器，授权完成
   * 回来时 provider 连凭据已落盘——这里只负责切视图与展示结果。令牌全程不进 renderer。
   */
  const loginClaude = async (): Promise<void> => {
    if (loggingIn || known === undefined) return;
    setLoggingIn(true);
    setStatus({ tone: "busy", text: t.providers.oauthWaiting });
    try {
      const result = await api.provider.oauthLogin({
        id: draft.id.trim(),
        displayName: draft.displayName.trim() || knownProviderDefaultName(known),
        ...(isNew ? { create: true, models: draft.models } : {}),
      });
      if (!result.ok) {
        setIssues(result.issues);
        showIdIssue(result.issues);
        return;
      }
      setIssues([]);
      if (isNew) {
        setSelectedId(draft.id.trim());
        setView({ kind: "detail" });
        resetTransient();
      }
      await refresh();
      const updated = (await api.provider.list()).find((p) => p.id === draft.id.trim());
      if (updated !== undefined) loadDraft(updated);
      const account = updated?.auth.scheme === "oauth" ? updated.auth.account : null;
      setStatus({ tone: "ok", text: t.providers.oauthLoggedIn(account) });
    } catch (cause) {
      setStatus({ tone: "bad", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setLoggingIn(false);
    }
  };

  /** 行内单模型测试：状态收在行内（图标转圈 / 结果徽标），不动布局。
   * 按模型 id 独立——连续点多个模型就是并行测试，谁也不顶谁。
   * 成功徽标 2.5s 后自动消失；失败原因留在行下，直到重测或切换。 */
  const testModel = (id: string) => {
    setModelTests((prev) => ({ ...prev, [id]: { tone: "busy", text: t.providers.testing } }));
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
    setRevealedKey(stored);
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

  /** id 没有输入框，撞名的 issue 挂不到字段上——走顶部错误条，别让保存无声失败 */
  const showIdIssue = (list: readonly ValidationIssue[]) => {
    const message = list.find((i) => i.field === "id")?.message;
    if (message !== undefined) setError(message);
  };

  const save = async () => {
    setError(null);
    const result = await api.provider.upsert({
      provider: {
        id: draft.id.trim(),
        // 记下来自哪张卡：第二个实例的 id 是 deepseek-2，光凭 id 认不回来
        ...(known === undefined ? {} : { kind: known.id }),
        displayName: draft.displayName.trim(),
        endpoint: {
          baseUrl: draft.baseUrl.trim(),
          api: known?.api ?? "openai-completions",
          ...(endpointHeaders === undefined ? {} : { headers: endpointHeaders }),
        },
        models: { declared: draft.models },
        // 编辑 oauth provider（改名 / 换地址）时保住 scheme：凭据在密钥库里，不能被这里抹掉
        auth: { scheme: editing?.auth.scheme ?? "api_key" },
      },
      ...(draft.apiKey === "" ? {} : { apiKey: draft.apiKey }),
      ...(editingId === null ? { create: true } : {}),
    });
    if (!result.ok) {
      setIssues(result.issues);
      showIdIssue(result.issues);
      return;
    }
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
    // Save 条随改动清零一起收起；这一行状态告诉用户「刚才那一下落盘了」
    setStatus({ tone: "ok", text: t.providers.saved });
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
          ...(known === undefined ? {} : { kind: known.id }),
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
        create: true,
      });
      if (!result.ok) {
        setIssues(result.issues);
        showIdIssue(result.issues);
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
    // 同一家还有别的实例就留在这家的详情页，删光了回卡片墙
    const sibling = instancesOfKind(draft.kind).find((provider) => provider.id !== selectedId);
    resetTransient();
    await refresh();
    if (sibling === undefined) {
      setView({ kind: "grid" });
      return;
    }
    setSelectedId(sibling.id);
    setView({ kind: "detail" });
    loadDraft(sibling);
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
  // 分配提示的三态（providers-assign.ts）：没有导入记录的用户永远看不到那块
  const hint = assignHint(assignGroups, sorted);
  const editorDecl =
    editor === null || editor.isNew ? undefined : draft.models.find((m) => m.id === editor.id);
  /**
   * Save 条只在连接区有没存的改动时出现——它的出现本身就说明「这里要点 Save」，
   * 模型区没有 Save 也就说明了「模型的改动即时生效」，代替原来底部那句双语说明。
   * 新建时还没落盘，条常驻（Add provider 就在上面）。
   */
  const dirty =
    isNew ||
    (editing !== undefined &&
      connectionDirty(
        draft,
        { displayName: editing.displayName, baseUrl: editing.endpoint.baseUrl },
        revealedKey,
      ));

  /** 分配提示（providers-assign.ts 三态）：放在卡片墙顶部，没有导入记录的用户永远看不到 */
  const assignBanner =
    hint.kind === "none" && assignDone === null ? null : (
      <div className="pv-assign-hint" data-tone={hint.kind === "leftover" ? "muted" : undefined}>
        {assignDone !== null && (
          <span className="pv-assign-done">
            <Icon name="circle-check" size={12} strokeWidth={1.8} />
            {t.providers.assignResult(assignDone.assigned)}
            {assignDone.skipped > 0 ? t.providers.assignSkipped(assignDone.skipped) : ""}
          </span>
        )}
        {hint.kind === "offer" && (
          <>
            <span className="pv-assign-line">{t.providers.assignHint(hint.total)}</span>
            <span className="pv-assign-sub">{t.providers.assignHintBody}</span>
            <button type="button" className="pv-btn accent" disabled={assignBusy} onClick={openAssign}>
              <Icon name="arrow-left-right" size={13} /> {t.providers.assignButton}
            </button>
          </>
        )}
        {hint.kind === "leftover" && <span className="pv-assign-sub">{t.providers.assignLeftover(hint.unmatched)}</span>}
      </div>
    );

  /** 详情页顶部这一家的实例：标签可切换、可拖动排序，末尾「再添加一个」 */
  const kindInstances = known === undefined ? [] : instancesOfKind(known.id);

  return (
    <section className="pv-root">
      <div className="pv-detail">
        {error !== null && (
          <div className="pv-banner">
            <Line tone="bad">{error}</Line>
            <button type="button" className="pv-btn sm" onClick={() => void refresh()}>
              {t.common.retry}
            </button>
          </div>
        )}
        {error === null && providers === null && (
          <div className="pv-banner">
            <Line tone="busy">{t.providers.loadingProviders}</Line>
          </div>
        )}

        {view.kind === "grid" && providers !== null && (
          <ProviderGrid
            providers={sorted}
            banner={assignBanner}
            query={query}
            onQuery={setQuery}
            onlyAdded={onlyAdded}
            onOnlyAdded={setOnlyAdded}
            size={props.cardSize}
            onSize={props.onCardSize}
            onOpen={openKind}
            onAddAnother={pickKnown}
          />
        )}

        {view.kind === "assign" && providers !== null && assignGroups !== null && (
          <AssignView
            preview={assignPreview(assignGroups, providers)}
            providers={providers}
            busy={assignBusy}
            error={assignError}
            onCancel={cancelSide}
            onRun={() => void runAssign()}
          />
        )}

        {showForm && known !== undefined && (
          <div className="pv-scroll">
            <div className="pv-content">
              <button type="button" className="pv-back" onClick={backToGrid}>
                <Icon name="chevron-left" size={14} /> {t.settings.tabs.providers}
              </button>
              <div className="pv-kind">
                <VendorLogo kindId={known.id} label={known.label} size={22} />
                <span className="pv-kind-text">
                  <span className="pv-kind-name">{t.providers.knownLabel(known.id, known.label)}</span>
                  <span className="pv-kind-note">{t.providers.knownNote(known.id, known.note)}</span>
                </span>
              </div>
              <div
                className="pv-tabs"
                role="tablist"
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
                }}
              >
                {kindInstances.map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    role="tab"
                    aria-selected={view.kind === "detail" && provider.id === selectedId}
                    className={`pv-tab${provider.id === dragId ? " dragging" : ""}${dropTarget === provider.id ? " drop-on" : ""}`}
                    title={hasCredentials(provider.auth) ? provider.endpoint.baseUrl : t.providers.noApiKey}
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
                      setDropTarget((cur) => (cur === provider.id ? cur : provider.id));
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      void reorderProviders(dragId, provider.id);
                      setDropTarget(null);
                    }}
                    onClick={() => selectProvider(provider.id)}
                  >
                    <span className="pv-tab-name">{provider.displayName}</span>
                    {/* 没填 key 直接写出来（原左栏行的口径），不靠一个图标让人猜 */}
                    {hasCredentials(provider.auth) ? (
                      <span className="pv-row-count">{provider.models.declared.length}</span>
                    ) : (
                      <span className="pv-tab-nokey">{t.providers.noApiKey}</span>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  role="tab"
                  aria-selected={isNew}
                  className="pv-tab add"
                  title={t.providers.addAnotherTip(t.providers.knownLabel(known.id, known.label))}
                  onClick={() => {
                    if (!isNew) pickKnown(known.id);
                  }}
                >
                  <Icon name="plus" size={13} /> {kindInstances.length === 0 ? t.providers.newProvider : t.providers.addAnother}
                </button>
              </div>
              <div className="pv-head">
                <span className="pv-title">
                  {draft.displayName || (isNew ? t.providers.newProvider : editing?.displayName)}
                </span>
                {/* 协议是锁定的事实，不是一个要填的字段：从整行降成标题旁的徽标 */}
                <ApiFormatBadge api={known.api} />
                <span className="pv-headend">
                  {isNew ? null : confirmRemove ? (
                    <>
                      <button
                        type="button"
                        className="pv-btn icon danger-solid"
                        aria-label={t.providers.confirmRemove}
                        title={t.providers.confirmRemoveProviderTip}
                        onClick={() => void removeProvider()}
                      >
                        <Icon name="trash-2" size={15} />
                      </button>
                      <button
                        type="button"
                        className="pv-btn icon"
                        aria-label={t.providers.cancelRemove}
                        title={t.providers.cancelRemove}
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
                        aria-label={t.providers.duplicate}
                        title={t.providers.duplicateTip}
                        onClick={() => void copyProvider()}
                      >
                        <Icon name="copy" size={15} />
                      </button>
                      <button
                        type="button"
                        className="pv-btn icon danger"
                        aria-label={t.providers.removeProvider}
                        title={t.providers.removeProviderTip}
                        onClick={() => setConfirmRemove(true)}
                      >
                        <Icon name="trash-2" size={15} />
                      </button>
                    </>
                  )}
                </span>
              </div>

              <section className="pv-block" aria-label={t.providers.connection}>
                <div className="pv-form">
                  <div className="pv-fld">
                    <label htmlFor="pv-name">{t.providers.name}</label>
                    <input
                      id="pv-name"
                      className="pv-input"
                      value={draft.displayName}
                      onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                    />
                  </div>
                  <div className="pv-fld">
                    <label htmlFor="pv-url">{t.providers.baseUrl}</label>
                    <span className="pv-fld-stack">
                      <UrlField
                        value={draft.baseUrl}
                        suffix={urlSuffix(known.api)}
                        invalid={issueFor("endpoint.baseUrl") !== undefined}
                        onChange={(baseUrl) => setDraft({ ...draft, baseUrl })}
                      />
                      {issueFor("endpoint.baseUrl") !== undefined && (
                        <span className="pv-issue">{issueFor("endpoint.baseUrl")}</span>
                      )}
                    </span>
                  </div>
                  {oauthEntry ? (
                    <div className="pv-fld">
                      <label>{t.providers.oauthAccount}</label>
                      <div className="pv-krow">
                        <span className="pv-oauth-state">
                          {loggingIn ? (
                            <>
                              <Icon name="loader-circle" size={14} spin />
                              <span>{t.providers.oauthWaiting}</span>
                            </>
                          ) : oauthLoggedIn && editing?.auth.scheme === "oauth" ? (
                            <>
                              <Icon name="circle-check" size={14} strokeWidth={1.8} />
                              <span title={t.providers.oauthNote}>
                                {t.providers.oauthLoggedIn(editing.auth.account)}
                              </span>
                            </>
                          ) : (
                            <span className="pv-oauth-out" title={t.providers.oauthNote}>
                              {t.providers.oauthLoggedOut}
                            </span>
                          )}
                        </span>
                        <button
                          type="button"
                          className={oauthLoggedIn ? "pv-btn line" : "pv-btn accent"}
                          disabled={loggingIn}
                          onClick={() => void loginClaude()}
                        >
                          <Icon name="external-link" size={13} strokeWidth={1.8} />
                          {oauthLoggedIn ? t.providers.oauthRelogin : t.providers.oauthLoginButton}
                        </button>
                        <button type="button" className="pv-btn line" disabled={testing} onClick={() => void test()}>
                          <Icon name={testing ? "loader-circle" : "zap"} size={13} spin={testing} />
                          {testing ? t.providers.testing : t.providers.test}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="pv-fld">
                      <label htmlFor="pv-key">{t.providers.apiKey}</label>
                      <div className="pv-krow">
                        <input
                          id="pv-key"
                          className="pv-input pv-mono"
                          type={revealed ? "text" : "password"}
                          value={draft.apiKey}
                          placeholder={
                            !isNew && editing?.auth.scheme === "api_key" && editing.auth.masked !== null
                              ? t.providers.savedKey(editing.auth.masked)
                              : t.providers.pasteKey
                          }
                          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                        />
                        <button
                          type="button"
                          className="pv-btn icon"
                          aria-label={revealed ? t.providers.hideKey : t.providers.showKey}
                          title={revealed ? t.providers.hideKey : t.providers.showKey}
                          onClick={() => void toggleReveal()}
                        >
                          <Icon name={revealed ? "eye-off" : "eye"} size={15} strokeWidth={1.8} />
                        </button>
                        <button
                          type="button"
                          className="pv-btn line"
                          disabled={testing}
                          onClick={() => void test()}
                        >
                          <Icon name={testing ? "loader-circle" : "zap"} size={13} spin={testing} />
                          {testing ? t.providers.testing : t.providers.test}
                        </button>
                      </div>
                    </div>
                  )}
                  {/* testing 时按钮本身已经说明「在跑」，busy 行不用再重复一遍 */}
                  {status !== null && !(testing && status.tone === "busy") && (
                    <div className="pv-fld">
                      <span />
                      <Line tone={status.tone}>{status.text}</Line>
                    </div>
                  )}
                </div>
                {/* oauth 新建没有 Save 条：登录即保存，登录钮就是主操作（编辑已有实例时改名仍走 Save） */}
                {dirty && !(oauthEntry && isNew) && (
                  <div className="pv-savebar">
                    <span className="pv-savebar-note">
                      <Icon name="pencil-line" size={12} strokeWidth={1.8} /> {t.providers.unsaved}
                    </span>
                    <button type="button" className="pv-btn" onClick={cancelSide}>
                      {t.common.cancel}
                    </button>
                    <button type="button" className="pv-btn accent" onClick={() => void save()}>
                      {isNew ? t.providers.addProvider : t.common.save}
                    </button>
                  </div>
                )}
              </section>

              <div className="pv-mhead">
                <span className="section-label">{t.providers.models}</span>
                <span className="pv-count">{draft.models.length}</span>
                <span className="pv-spacer" />
                <button
                  type="button"
                  className="pv-btn sm"
                  title={t.providers.addModelByIdTip}
                  onClick={() => setEditor({ isNew: true, id: null })}
                >
                  <Icon name="plus" size={13} strokeWidth={1.8} /> {t.common.add}
                </button>
                {discovered === null && (
                  <button
                    type="button"
                    className="pv-btn sm"
                    disabled={draft.baseUrl.trim() === ""}
                    title={t.providers.fetchListTip}
                    onClick={() => void fetchModels()}
                  >
                    <Icon name="refresh-cw" size={13} strokeWidth={1.8} /> {t.providers.fetchList}
                  </button>
                )}
              </div>
              {issueFor("models.declared") !== undefined && (
                <span className="pv-issue">{issueFor("models.declared")}</span>
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
              <div className="pv-block">
                {draft.models.length === 0 ? (
                  // 空态用两个按钮说话，代替「No models yet — fetch the list, or add one by id.」
                  <div className="pv-mempty">
                    <Icon name="cpu" size={20} strokeWidth={1.8} />
                    <span>{t.providers.noModels}</span>
                    <span className="pv-inline">
                      <button
                        type="button"
                        className="pv-btn line"
                        disabled={draft.baseUrl.trim() === "" || discovered !== null}
                        onClick={() => void fetchModels()}
                      >
                        <Icon name="refresh-cw" size={13} strokeWidth={1.8} /> {t.providers.fetchList}
                      </button>
                      <button
                        type="button"
                        className="pv-btn line"
                        onClick={() => setEditor({ isNew: true, id: null })}
                      >
                        <Icon name="plus" size={13} strokeWidth={1.8} /> {t.providers.addById}
                      </button>
                    </span>
                  </div>
                ) : (
                  draft.models.map((model) => {
                    const defaults = modelDefaults(known, model.id);
                    const badge = modelContextText(model, defaults);
                    const tested = modelTests[model.id];
                    const busy = tested?.tone === "busy";
                    const confirming = confirmRemoveModel === model.id;
                    return (
                      <div
                        className={`pv-mitem${confirming || busy ? " pinned" : ""}`}
                        key={model.id}
                      >
                        <div className="pv-mrow">
                          <span className="pv-grow">
                            {model.name !== undefined && <span className="pv-mname">{model.name}</span>}
                            <span className={`pv-mid${model.name !== undefined ? " dim" : ""}`} title={model.id}>
                              {model.id}
                            </span>
                            <span
                              className="pv-badge"
                              title={
                                badge.fallback
                                  ? t.providers.ctxFallbackTip
                                  : t.providers.contextWindow
                              }
                            >
                              {badge.fallback && <Icon name="triangle-alert" size={10} strokeWidth={1.8} />}
                              {badge.text}
                            </span>
                            {modelAcceptsImage(model, defaults) && (
                              <span className="pv-badge" title={t.providers.acceptsImage}>
                                <Icon name="image" size={11} strokeWidth={1.8} />
                              </span>
                            )}
                            {tested !== undefined && tested.tone !== "busy" && (
                              <span
                                className={`pv-badge pv-test-${tested.tone}`}
                                title={tested.tone === "bad" ? t.providers.seeFailureBelow : tested.text}
                              >
                                <Icon name={tested.tone === "ok" ? "check" : "triangle-alert"} size={11} />
                                {tested.tone === "ok" ? t.providers.success : t.common.failed}
                              </span>
                            )}
                          </span>
                          <span className="pv-acts">
                            {confirming ? (
                              <>
                                {/* 与 provider 删除同款的两段式：一点就没是破坏性动作的禁忌（2026-09-11 验收发现） */}
                                <button
                                  type="button"
                                  className="pv-btn icon sm danger-solid"
                                  aria-label={t.providers.confirmRemove}
                                  title={t.providers.confirmRemoveModelTip(model.id)}
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
                                  aria-label={t.providers.cancelRemove}
                                  title={t.providers.cancelRemove}
                                  onClick={() => setConfirmRemoveModel(null)}
                                >
                                  <Icon name="x" size={13} strokeWidth={1.8} />
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="pv-btn icon sm"
                                  aria-label={t.providers.testModel(model.id)}
                                  title={busy ? t.providers.testing : t.providers.testModel(model.id)}
                                  onClick={() => testModel(model.id)}
                                >
                                  <Icon name={busy ? "loader-circle" : "zap"} size={13} strokeWidth={1.8} spin={busy} />
                                </button>
                                <button
                                  type="button"
                                  className="pv-btn icon sm"
                                  aria-label={t.providers.editModel(model.id)}
                                  title={t.providers.editModel(model.id)}
                                  onClick={() => setEditor({ isNew: false, id: model.id })}
                                >
                                  <Icon name="pencil-line" size={13} strokeWidth={1.8} />
                                </button>
                                <button
                                  type="button"
                                  className="pv-btn icon sm danger"
                                  aria-label={t.providers.removeModel(model.id)}
                                  title={t.providers.removeModel(model.id)}
                                  onClick={() => setConfirmRemoveModel(model.id)}
                                >
                                  <Icon name="trash-2" size={13} strokeWidth={1.8} />
                                </button>
                              </>
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
          </div>
        )}
      </div>

      {editor !== null && known !== undefined && (
        <div className="pv-modal-root">
          <ModelDialog
            known={known}
            catalog={catalog}
            decl={editorDecl}
            existingIds={draft.models.map((m) => m.id)}
            plan={known.billing === "plan"}
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

/**
 * 协议徽标：原来的「API format」整行 + 一句说明，收成标题旁一枚锁形徽标，说明进悬停。
 * 可聚焦（tabIndex）——键盘用户也要能读到「为什么锁着」。
 */
function ApiFormatBadge(props: { api: string }) {
  const t = useT();
  const tip = useSettingTip<HTMLSpanElement>(t.providers.apiFormatTip);
  return (
    <>
      <span className="pv-format" tabIndex={0} {...tip.anchor}>
        <Icon name="lock" size={11} strokeWidth={1.8} />
        {props.api}
      </span>
      {tip.layer}
    </>
  );
}

/**
 * Base URL 输入框：框尾灰字是客户端会接上的路径（`/chat/completions` 或 `/v1/messages`），
 * 代替原来框下那句「The client appends …」——看得见完整请求地址长什么样。
 * 输入框按内容定宽（`field-sizing: content`），后缀因此紧贴在用户输入的末尾；
 * 整个框是一个 label，点后缀也聚焦到输入框。
 */
function UrlField(props: {
  value: string;
  suffix: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const t = useT();
  const tip = useSettingTip<HTMLSpanElement>(t.providers.urlSuffixTip);
  return (
    <label className="pv-url" data-invalid={props.invalid || undefined}>
      <input
        id="pv-url"
        value={props.value}
        placeholder="https://…"
        spellCheck={false}
        aria-invalid={props.invalid}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <span className="pv-url-suffix" {...tip.anchor}>
        {props.suffix}
      </span>
      {tip.layer}
    </label>
  );
}

/** 分配预览（右栏）：每个原模型一行，底部分配 / 取消。 */
function AssignView(props: {
  preview: AssignPreview;
  providers: readonly ProviderDto[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onRun: () => void;
}) {
  const t = useT();
  const nameOf = (providerId: string): string =>
    props.providers.find((provider) => provider.id === providerId)?.displayName ?? providerId;
  return (
    <div className="pv-scroll">
      <div className="pv-content">
        <div className="pv-head">
          <span className="pv-title">{t.providers.assignTitle}</span>
          <InfoTip label={t.providers.aboutAssign}>{t.providers.aboutAssignBody}</InfoTip>
          <span className="pv-headend">
            <button type="button" className="pv-btn" onClick={props.onCancel}>
              {t.common.cancel}
            </button>
          </span>
        </div>
        <div className="pv-assign-rows">
          {props.preview.rows.map((row) => (
            <div key={row.model} className="pv-assign-row" data-hit={row.target !== null || undefined}>
              <span className="pv-assign-model" title={row.model}>
                {row.model}
              </span>
              <span className="pv-assign-count">{t.providers.assignSessions(row.sessions)}</span>
              {row.target !== null ? (
                <span className="pv-assign-target">
                  <Icon name="arrow-left-right" size={12} strokeWidth={1.8} />
                  {/* 服务商名可截断、模型名完整保留——多渠道同名时用户要看的恰恰是
                      配到了哪家的哪个模型；完整「服务商 · 模型」放悬停 */}
                  <span
                    className="pv-assign-pair"
                    title={`${nameOf(row.target.providerId)} · ${row.target.modelId}`}
                  >
                    <span className="pv-assign-provider">{nameOf(row.target.providerId)}</span>
                    <span className="pv-assign-dot"> · </span>
                    <span className="pv-assign-modelid">{row.target.modelId}</span>
                  </span>
                  {row.target.ambiguous && (
                    <span className="pv-assign-note" title={t.providers.assignAmbiguousTip}>
                      {t.providers.assignAmbiguous}
                    </span>
                  )}
                </span>
              ) : (
                <span className="pv-assign-target none">
                  <Icon name="circle-off" size={12} strokeWidth={1.8} />
                  {t.providers.assignNoMatch}
                </span>
              )}
            </div>
          ))}
        </div>
        {props.error !== null && (
          <p className="pv-assign-error">
            <Icon name="triangle-alert" size={12} />
            {props.error}
          </p>
        )}
        <div className="pv-assign-foot">
          <span className="pv-assign-sum">
            {props.preview.unmatched > 0 ? t.providers.assignUnmatchedNote(props.preview.unmatched) : ""}
          </span>
          <button
            type="button"
            className="pv-btn accent lg"
            disabled={props.busy || props.preview.assignable === 0}
            onClick={props.onRun}
          >
            {props.busy ? <Icon name="loader-circle" size={14} spin /> : <Icon name="arrow-left-right" size={14} />}
            {t.providers.assignConfirm(props.preview.assignable)}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 卡片墙：顶部工具条（搜索 / 仅显示已添加 / 大小两档）+ 三个分区的厂商卡片。
 * 分区与过滤在 providerCards（纯函数、有测试），这里只画。
 */
function ProviderGrid(props: {
  providers: readonly ProviderDto[];
  /** 分配模型的提示条（没有就是 null） */
  banner: React.ReactNode;
  query: string;
  onQuery: (query: string) => void;
  onlyAdded: boolean;
  onOnlyAdded: (only: boolean) => void;
  size: ProviderCardSize;
  onSize: (size: ProviderCardSize) => void;
  onOpen: (kindId: string) => void;
  onAddAnother: (kindId: string) => void;
}) {
  const t = useT();
  const groups = providerCards(props.providers, {
    query: props.query,
    onlyAdded: props.onlyAdded,
    textOf: (known) => `${t.providers.knownLabel(known.id, known.label)} ${t.providers.knownNote(known.id, known.note)}`,
  });
  const addedKinds = new Set(props.providers.map((provider) => kindOf(provider))).size;
  return (
    <div className="pv-scroll">
      <div className="pv-wall">
        {props.banner}
        <div className="pv-toolbar">
          <label className="pv-search">
            <Icon name="search" size={14} />
            <input
              value={props.query}
              placeholder={t.providers.searchProviders}
              aria-label={t.providers.searchProviders}
              onChange={(e) => props.onQuery(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="pv-btn line"
            aria-pressed={props.onlyAdded}
            onClick={() => props.onOnlyAdded(!props.onlyAdded)}
          >
            <Icon name="list-filter" size={13} /> {t.providers.onlyAdded}
            <span className="pv-row-count">{addedKinds}</span>
          </button>
          <span className="pv-seg" role="group" aria-label={t.providers.cardSize}>
            {(["large", "small"] as const).map((size) => (
              <button
                key={size}
                type="button"
                aria-pressed={props.size === size}
                title={t.providers.cardSizes[size]}
                onClick={() => props.onSize(size)}
              >
                <Icon name={size === "large" ? "layout-grid" : "grid-3x3"} size={13} /> {t.providers.cardSizes[size]}
              </button>
            ))}
          </span>
        </div>
        {groups.length === 0 && (
          <div className="pv-wall-empty">
            {props.onlyAdded && props.query.trim() === "" ? t.providers.noneAdded : t.providers.noProvidersMatch}
          </div>
        )}
        {groups.map(({ group, cards }) => (
          <section key={group} className="pv-wall-group">
            <span className="section-label">{t.providers.catalogGroups[group]}</span>
            <div className={`pv-cards ${props.size}`}>
              {cards.map((card) => (
                <ProviderGridCard
                  key={card.known.id}
                  card={card}
                  size={props.size}
                  onOpen={() => props.onOpen(card.known.id)}
                  onAddAnother={() => props.onAddAnother(card.known.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * 一张厂商卡。大卡：logo、名字、说明、底行（没加过写预填地址，加过写实例名）；小卡一行只留
 * logo、名字与角标。加过的卡右上角「已添加」（多于一个带数字），悬停浮出「+」再加一个。
 * 卡片本身是 div + role="button"：里面还套着「+」按钮，button 不能嵌 button。
 */
function ProviderGridCard(props: {
  card: ProviderCard;
  size: ProviderCardSize;
  onOpen: () => void;
  onAddAnother: () => void;
}) {
  const t = useT();
  const { known, instances } = props.card;
  const label = t.providers.knownLabel(known.id, known.label);
  const added = instances.length > 0;
  const custom = known.baseUrl === "";
  const badge = added ? (
    <span className="pv-added-badge">
      <Icon name="circle-check" size={12} strokeWidth={1.8} />
      {props.size === "large" && <span>{t.providers.added}</span>}
      {instances.length > 1 && <span className="pv-mono">{instances.length}</span>}
    </span>
  ) : null;
  const more = added ? (
    <button
      type="button"
      className="pv-card-more"
      aria-label={t.providers.addAnotherTip(label)}
      title={t.providers.addAnotherTip(label)}
      onClick={(e) => {
        e.stopPropagation();
        props.onAddAnother();
      }}
    >
      <Icon name="plus" size={13} />
    </button>
  ) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      className={`pv-vcard${custom && !added ? " blank" : ""}`}
      onClick={props.onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          props.onOpen();
        }
      }}
    >
      {props.size === "large" ? (
        <>
          <span className="pv-vcard-top">
            <span className="pv-logo-tile">
              <VendorLogo kindId={known.id} label={known.label} size={22} />
            </span>
            {badge}
          </span>
          <span className="pv-vcard-text">
            <span className="pv-vcard-name">{label}</span>
            <span className="pv-vcard-note">{t.providers.knownNote(known.id, known.note)}</span>
          </span>
          <span className="pv-vcard-foot">
            {added ? instances.map((provider) => provider.displayName).join(" · ") : custom ? t.providers.customUrl : hostOf(known.baseUrl)}
          </span>
          {more}
        </>
      ) : (
        <>
          <span className="pv-logo-tile sm">
            <VendorLogo kindId={known.id} label={known.label} size={16} />
          </span>
          <span className="pv-vcard-name">{label}</span>
          {badge}
          {more}
        </>
      )}
    </div>
  );
}

/** Fetch 多选清单：搜索过滤、已启用项标 Added 并锁住、勾选批量启用 */
function FetchPanel(props: {
  discovered: { ids: string[] };
  existing: readonly string[];
  onApply: (picked: string[]) => void;
  onCancel: () => void;
}) {
  const t = useT();
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
    <div className="pv-block pv-fetch">
      <div className="pv-fetch-search">
        <Icon name="search" size={14} />
        <input
          placeholder={t.providers.filterModels}
          aria-label={t.providers.filterModels}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="pv-fetch-list">
        {ids.length === 0 ? (
          <div className="pv-fetch-none">{t.providers.noModelsMatch}</div>
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
                    <Icon name="check" size={11} /> {t.providers.added}
                  </span>
                )}
              </label>
            );
          })
        )}
      </div>
      <div className="pv-fetch-foot">
        <span className="pv-fetch-count">
          {t.providers.selectedFound(picked.size, d.ids.length)}
        </span>
        <button type="button" className="pv-btn sm" onClick={props.onCancel}>
          {t.common.cancel}
        </button>
        <button
          type="button"
          className="pv-btn sm accent"
          disabled={picked.size === 0}
          onClick={() => props.onApply([...picked])}
        >
          {t.providers.addSelected(picked.size)}
        </button>
      </div>
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
  const t = useT();
  const isNew = props.decl === undefined;
  // 与模型行同一条推断（按 id 跨目录）：行上显示 1M、弹窗却写 Inherit (128000) 是说两句话
  const defaultsOf = (id: string): ModelDefaults =>
    resolveModelDefaults(props.catalog, id, {
      catalogId: props.known.catalogId,
      api: props.known.api,
    });
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

  // 新增：id 命中目录时，placeholder 处的继承值跟着换（不填输入框——填了就成了覆盖声明）
  const activeDefaults = defaultsOf(isNew ? idValue.trim().toLowerCase() : (props.decl?.id ?? ""));
  /**
   * 单价的继承占位只在**目录条目**上成立：白名单只补窗口 / 输出，兜底的零单价
   * 不是报价而是「不知道」——写成 $0 就是把不知道说成免费，所以占位留一道横线。
   */
  const inheritedCost =
    activeDefaults.source === "catalog" || activeDefaults.source === "catalog-family";
  // 三档里的 Inherit 到底继承了什么：图标 + 悬停写出来，不然用户只能靠猜
  const inheritImage = activeDefaults.input.includes("image");
  // 模型弹窗头上的来源徽标：原来弹窗底部那句「Source: …」收成一枚徽标，整句进悬停
  const source = t.providers.sourceBadges[activeDefaults.source];
  const sourceTip = useSettingTip<HTMLSpanElement>(
    props.plan ? t.providers.planBillingTip(source.tip) : source.tip,
  );
  const lockedTip = useSettingTip<HTMLSpanElement>(t.providers.idImmutableTip);

  const apply = () => {
    const finalId = isNew ? idValue.trim().toLowerCase() : (props.decl?.id ?? "");
    if (isNew) {
      const shapeIssue = modelIdIssue(finalId, t);
      if (shapeIssue !== null) {
        setIdIssue(shapeIssue);
        return;
      }
      if (props.existingIds.includes(finalId)) {
        setIdIssue(t.providers.idAlreadyEnabled(finalId));
        return;
      }
    }
    const ctx = parseTokenInput(ctxText);
    const out = parseTokenInput(outText);
    const cin = parseRateInput(cinText);
    const cout = parseRateInput(coutText);
    if (ctx === "invalid" || out === "invalid" || cin === "invalid" || cout === "invalid") {
      setFieldIssue(t.providers.fieldsMustBeNumbers);
      return;
    }
    const decl: ModelDecl = { id: finalId };
    const trimmedName = name.trim();
    if (trimmedName !== "") decl.name = trimmedName;
    if (ctx !== undefined) decl.contextWindow = ctx;
    if (out !== undefined) decl.maxTokens = out;
    const cost = mergeModelCost(props.decl?.cost, inheritedCost ? activeDefaults : undefined, {
      input: cin,
      output: cout,
    });
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
      <div className="pv-modal" role="dialog" aria-modal="true" aria-label={isNew ? t.providers.addModel : t.providers.editModelTitle}>
        <div className="pv-modal-head">
          <strong>{isNew ? t.providers.addModel : t.providers.editModelTitle}</strong>
          <span className="pv-badge pv-badge-plain" tabIndex={0} {...sourceTip.anchor}>
            <Icon
              name={activeDefaults.source === "fallback" ? "triangle-alert" : "book-open"}
              size={11}
              strokeWidth={1.8}
            />
            {source.label}
          </span>
          {sourceTip.layer}
          <span className="pv-spacer" />
          <button type="button" className="pv-btn icon" aria-label={t.common.close} title={t.common.close} onClick={props.onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>
        <div className="pv-modal-body">
          <div className="pv-fld wide">
            <span className="pv-lab">
              <label htmlFor="pv-model-id">{t.providers.modelId}</label>
              {isNew && (
                <InfoTip label={t.providers.aboutModelId}>{t.providers.modelIdInfo}</InfoTip>
              )}
            </span>
            {isNew ? (
              <span className="pv-fld-stack">
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
                  aria-invalid={idIssue !== null}
                />
                {idIssue !== null && <span className="pv-issue">{idIssue}</span>}
              </span>
            ) : (
              <>
                <span className="pv-locked" tabIndex={0} {...lockedTip.anchor}>
                  <Icon name="lock" size={13} strokeWidth={1.8} />
                  {props.decl?.id}
                </span>
                {lockedTip.layer}
              </>
            )}
          </div>
          <div className="pv-fld wide">
            <label htmlFor="pv-model-name">{t.providers.displayName}</label>
            <input
              id="pv-model-name"
              className="pv-input"
              value={name}
              placeholder={t.providers.optional}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="pv-fld wide">
            <span className="pv-lab">{t.providers.imageInput}</span>
            <div role="group" aria-label={t.providers.imageInput} className="pv-inline tight">
              <Chip
                icon={inheritImage ? "image" : undefined}
                active={vision === "inherit"}
                title={
                  inheritImage
                    ? t.providers.inheritImageTip
                    : t.providers.inheritTextTip
                }
                onClick={() => setVision("inherit")}
              >
                {t.providers.inherit}
              </Chip>
              <Chip active={vision === "on"} onClick={() => setVision("on")}>
                {t.common.on}
              </Chip>
              <Chip active={vision === "off"} onClick={() => setVision("off")}>
                {t.common.off}
              </Chip>
            </div>
          </div>
          <div className="pv-grid2">
            <UnitField
              id="pv-model-ctx"
              label={t.providers.contextWindow}
              value={ctxText}
              placeholder={compactTokens(activeDefaults.contextWindow)}
              post={t.providers.unitTokens}
              onChange={setCtxText}
            />
            <UnitField
              id="pv-model-out"
              label={t.providers.maxOutput}
              value={outText}
              placeholder={compactTokens(activeDefaults.maxTokens)}
              post={t.providers.unitTokens}
              onChange={setOutText}
            />
            <UnitField
              id="pv-model-cin"
              label={t.providers.inputCost}
              value={cinText}
              placeholder={inheritedCost ? String(activeDefaults.cost.input) : "—"}
              pre="$"
              post="/ 1M"
              onChange={setCinText}
            />
            <UnitField
              id="pv-model-cout"
              label={t.providers.outputCost}
              value={coutText}
              placeholder={inheritedCost ? String(activeDefaults.cost.output) : "—"}
              pre="$"
              post="/ 1M"
              onChange={setCoutText}
            />
          </div>
          {fieldIssue !== null && <span className="pv-issue">{fieldIssue}</span>}
        </div>
        <div className="pv-modal-foot">
          <button
            type="button"
            className="pv-btn"
            title={t.providers.resetTip}
            onClick={() => {
              setCtxText("");
              setOutText("");
              setCinText("");
              setCoutText("");
              setVision("inherit");
            }}
          >
            <Icon name="rotate-ccw" size={13} strokeWidth={1.8} /> {t.common.reset}
          </button>
          <span className="pv-spacer" />
          <button type="button" className="pv-btn" onClick={props.onClose}>
            {t.common.cancel}
          </button>
          <button type="button" className="pv-btn accent" onClick={apply}>
            {t.common.apply}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 带单位的数值框：单位（tokens、$、/ 1M）写在框里，代替原来每个框下面一行
 * 「tokens — accepts 128000 or 128k / 1M」「$ per 1M tokens」。占位是继承来的值。
 */
function UnitField(props: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  pre?: string;
  post: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="pv-fld stacked">
      <label htmlFor={props.id}>{props.label}</label>
      <span className="pv-unit">
        {props.pre !== undefined && <span className="pv-unit-mark pre">{props.pre}</span>}
        <input
          id={props.id}
          value={props.value}
          placeholder={props.placeholder}
          spellCheck={false}
          onChange={(e) => props.onChange(e.target.value)}
        />
        <span className="pv-unit-mark">{props.post}</span>
      </span>
    </div>
  );
}

/**
 * key 测试状态行：三态各自的视觉分量不同，不是一行小字换个颜色。
 * ok / busy 仍是单行文字（busy 前可挂转圈，呼应 Test 按钮同一个白名单动效）；
 * bad 升级成 danger-soft 软底块，与模型行的 pv-mreason 同规格——失败原因通常
 * 是一整句服务端错误，需要能换行、能悬停选中复制，一行小字装不下。
 * role 二选一：bad 用 alert（主动打断朗读，错误需要立刻被听到），
 * 其余保留 status（礼貌通知，busy/ok 不该打断用户正在做的事）。
 */
function Line(props: { tone: "ok" | "bad" | "busy"; children: React.ReactNode }) {
  if (props.tone === "bad") {
    return (
      <div className="pv-line bad" role="alert">
        <Icon name="triangle-alert" size={12} />
        <span>{props.children}</span>
      </div>
    );
  }
  return (
    <p className={`pv-line ${props.tone}`} role="status">
      {props.tone === "busy" && <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />}
      {props.tone === "ok" && <Icon name="check" size={13} strokeWidth={1.8} />}
      {props.children}
    </p>
  );
}

function emptyDraft() {
  return { kind: "", id: "", displayName: "", baseUrl: "", models: [] as ModelDecl[], apiKey: "" };
}
