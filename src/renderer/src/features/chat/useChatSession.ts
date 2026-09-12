import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { api } from "../../api";
import {
  EMPTY_ENTRY,
  dequeue,
  applyAgentEvent,
  enqueue,
  createSessionStates,
  moveQueued as moveQueuedIn,
  parseCompactCommand,
  removeApproval,
  nextDeliverable,
  removeSessionEntry,
  seedFromDisk,
  setEntryPhase,
  type PendingApproval,
  type QueuedMessage,
  type SessionEntry,
  type SessionStates,
} from "./session-states.ts";
import { LOADING, READY, failed, type LoadState } from "./load-state.ts";
import { createProgressCoalescer } from "./progress-coalescer.ts";
import { recordToolFrame } from "./tool-results.ts";
import { appendWithdrawn } from "./withdraw-draft.ts";
import { recordAssistantStart } from "./stats-format.ts";
import type { PermissionAnswer, PermissionMode } from "@shared/permission";
import type { AgentEvent, AgentStats, RetryStatus, SubmitAgentInput } from "@shared/agent-ipc";
import type { ProviderDto } from "@shared/provider";
import type { CompactedRecord, SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";

/**
 * 会话状态。**逻辑原样自 ChatView 上提**，一行未改语义——上提的唯一理由是
 * app shell 里左栏（会话列表 / 工作区）与中卡（聊天面）需要读同一份状态，
 * 而它们在 DOM 上是兄弟，状态没法再留在中卡里。
 *
 * transcript / phase / 审批**按会话分槽**（session-states.ts）：事件无条件进自己的槽，
 * 切走正在跑的会话不再丢更新——「看哪条」只是显示问题，不再决定「记不记」。
 * transcript 归约仍是 **pi 自带的归约器**，我们不写第二份归约逻辑（guideline §三）。
 */
export interface ChatSession {
  sessionId: string | null;
  transcript: readonly TranscriptItem[];
  /** 压缩界碑（与 transcript 分开记账）；显示时由 applyCompactionBoundary 合成 */
  compactions: readonly CompactedRecord[];
  /** turn = 这一轮还在跑；compaction = 上下文压缩中；idle = 可以发下一句 */
  phase: "idle" | "turn" | "compaction";
  /** 自动重试等待态：非 null 时重试行替换 Responding（或补在压缩行下） */
  retry: RetryStatus | null;
  /**
   * 回合级失败标注（重试耗尽）：渲染在转录末尾——这轮没送出去的那条用户消息下面。
   * 新一轮开跑自动清除。操作级失败（建会话 / 压缩 / 分支被拒）仍在 error 上。
   */
  turnError: string | null;
  /**
   * 最近一次用量快照（token / 花费 / 上下文余量），每轮落定时由 runtime 推来。
   * null = 还没有：纯浏览的旧会话不起 runtime session，等说话唤醒后才有数字。
   */
  stats: AgentStats | null;
  /**
   * 按 id 查某条会话的运行态（槽里有真相）。侧栏每行要显示**它自己**的转圈/完成，
   * 与「当前看哪条」无关——后台在跑的会话切走了也照样转圈。
   */
  phaseOf: (id: string) => SessionEntry["phase"];
  /** 按 id 查回合失败标注（槽里有真相）——侧栏失败图标用，与「当前看哪条」无关 */
  turnErrorOf: (id: string) => string | null;
  error: string | null;
  /** 当前查看会话的输入框草稿——**按会话隔离**，切换 / 新开会话互不带走 */
  draft: string;
  /** 写当前查看会话的草稿 */
  setDraft: (value: string) => void;
  mode: PermissionMode;
  changeMode: (next: PermissionMode) => void;
  approvals: PendingApproval[];
  /** 侧栏列的工作区（落盘、跨会话）。 */
  workspaces: Workspace[];
  addWorkspace: () => void;
  renameWorkspace: (id: string, name: string) => void;
  removeWorkspace: (id: string) => void;
  /**
   * 这个任务实际跑在哪儿。**null = 没选，落在 `defaultCwd`**——
   * 工作区与「这一单用哪个目录」是两件事：New task 建的是不属于任何工作区的任务，
   * 点工作区的 + 建的才是这个工作区里的任务。
   */
  cwd: string | null;
  /** 这个任务属于哪个工作区；与 cwd 永远同进同出 */
  workspaceId: string | null;
  /** 没选工作区时的兜底（今天是 home）。UI 必须如实显示它，不能让它是个隐形默认。 */
  defaultCwd: string;
  /** 至少声明了一个模型且**配置好**（有密钥，能真正发起请求）的 provider——没有它就发不出消息 */
  usable: ProviderDto[];
  /**
   * 当前模型的意图：新任务的默认，也是会话内切换（C-4）的目标。
   * 活会话切换成功后由 `model` 事件回环对齐——不乐观，失败时 chip 不动。
   */
  model: { providerId: string; modelId: string } | null;
  chooseModel: (providerId: string, modelId: string) => void;
  /** 立刻压一次上下文（用量菜单里那一项）。只在 phase 为 idle 时可用 */
  compact: () => void;
  /** 落盘的会话列表，新的在前。侧栏 TASKS 节点列的就是它。 */
  sessions: SessionMeta[];
  /**
   * 两份列表各自读到哪一步了。**读失败不等于空**（D-3）：
   * 失败时 `sessions` / `workspaces` 保留上一份，错误由这里带出去，侧栏原地显示并给重试。
   */
  loads: { sessions: LoadState; workspaces: LoadState };
  reloadSessions: () => void;
  reloadWorkspaces: () => void;
  /** 会话列表的第一读是否已落定（首页会话卡的骨架态只在这一读期间显示） */
  sessionsLoaded: boolean;
  /** 正在从磁盘恢复某条会话的历史（openSession 的 load 在途） */
  loadingHistory: boolean;
  /**
   * 正在看/正在续的那条会话（从磁盘打开的）。
   * **打开就把它的 transcript 种进状态**，所以聊天面不需要第二条渲染路径——
   * 续上之后新消息接着往下追加，自然衔接。
   */
  opened: SessionMeta | null;
  /**
   * 这条会话只能读不能续：pi 没有它的本子（本功能之前存的，或那份被删了）。
   * 界面要如实说出来，不能让输入框看起来能打字（guideline §四写明的代价）。
   */
  readOnly: boolean;
  openSession: (id: string) => void;
  /** 改名。空名字会退回从第一条用户消息推导——侧栏不留看不见的行 */
  renameSession: (id: string, title: string) => void;
  pinSession: (id: string, pinned: boolean) => void;
  /** 归档：从主列表移走，**不是删除** */
  archiveSession: (id: string, archived: boolean) => void;
  moveSession: (id: string, workspaceId: string | null) => void;
  /**
   * 从某条 agent 回答另起一支（C-2）：新会话 = 该回答及之前的全部，原会话不动
   * （在跑的话照跑，槽里继续涨）。成功后切过去；两本账对不上时主进程以错误拒绝，
   * 报到 error 上——宁可不分支，不切错位置。
   */
  branchFrom: (anchorItemId: string) => void;
  /** 导出成 Markdown；取消时什么都不做 */
  exportSession: (id: string) => void;
  removeSession: (id: string) => void;
  send: () => void;
  /** 打断当前这一轮。pi 的 abort 走的是与工具审批不同的一条路，不需要等审批答复 */
  stop: () => void;
  /** 排队队列（当前槽），按显示顺序。唯一真源，操作一律按 id */
  queued: readonly QueuedMessage[];
  /** 立即发送：停下当前这一轮，把这条作为新一轮发出去 */
  sendQueuedNow: (id: string) => void;
  /** 撤回：移出队列，文字落回 composer 草稿 */
  withdrawQueued: (id: string) => void;
  /** 拖拽排序：把 sourceId 放到 targetId 的前 / 后 */
  moveQueuedTo: (sourceId: string, targetId: string, placement: "before" | "after") => void;
  /** 不属于任何工作区的新任务：落在 defaultCwd */
  newTask: () => void;
  /** 这个工作区里的新任务：cwd 与 workspaceId 一起按它填好 */
  newTaskIn: (workspace: Workspace) => void;
  answerApproval: (requestId: string, answer: PermissionAnswer) => void;
}

export function useChatSession(providers: ProviderDto[]): ChatSession {
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** 全部会话的槽；「当前看哪条」由 sessionId ?? opened?.id 推出，不另设状态 */
  const [states, setStates] = useState<SessionStates>(createSessionStates);
  /**
   * states 的同步镜像。事件回调（自动重发缓冲、send 查压缩态）要在 setStates 之外
   * 读最新值——闭包里的 states 是渲染时的旧值。在 setStates 的 updater 里同步：
   * 幂等（重复赋同一个 next），换掉effect 方案是因为 effect 晚一拍，连发两个
   * phase 事件时第二个会拿旧值重发已被清空的缓冲。
   */
  const statesRef = useRef<SessionStates>(states);
  const [error, setError] = useState<string | null>(null);
  /**
   * 输入框草稿**按会话隔离**（含首页）：key = 当前查看的会话 id，首页用 "home"。
   * 以前是全局单份，切换 / 新开会话草稿跟着走（2026-09-10 用户裁决：新会话就是
   * 新的，旧会话的草稿留在原地等他回来）。纯内存，不落盘——与旧行为一致。
   */
  const [drafts, setDrafts] = useState<ReadonlyMap<string, string>>(new Map());
  const writeDraft = useCallback((key: string, value: string) => {
    setDrafts((prev) => (prev.get(key) === value ? prev : new Map(prev).set(key, value)));
  }, []);
  /** 三档权限模式。默认 plan——**默认最保守**，开工具要用户自己往下调。 */
  const [mode, setMode] = useState<PermissionMode>("plan");
  /** agent 能看到的文件夹。**session 的 cwd 在创建时固定**，所以换工作区 = 换会话。 */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [loads, setLoads] = useState<{ sessions: LoadState; workspaces: LoadState }>({
    sessions: LOADING,
    workspaces: LOADING,
  });
  /** 会话列表第一读是否已落定：从 loads 派生（首页骨架态用）。 */
  const sessionsLoaded = loads.sessions.kind !== "loading";
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [opened, setOpened] = useState<SessionMeta | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [model, setModel] = useState<{ providerId: string; modelId: string } | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string>("");
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // ref 兜底同步：所有写入都应走 applyStates（它已即时写 ref），这里只是保险丝。
  // **不得再新增裸 `setStates((prev) => …)`**：applyStates 写的是平译值，
  // React 的更新队列遇到平译值会**丢掉先前排队的 updater**，不是合并。
  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  /**
   * **同步读-改-写**：先算 next、同步落 ref、再 setStates。不用
   * `setStates((prev) => { ...; statesRef.current = next; return next; })`——
   * updater 要到渲染阶段才跑，紧接着的同步读（deliverNext / 连发两个事件时
   * 第二个的入队判定）拿到的是上一拍，排队卡「停止后不投递 / 两条一起飞」
   * 就是这个滞后（B4 修）。所有需要紧跟同步读的写入都走这里。
   */
  const applyStates = useCallback((f: (prev: SessionStates) => SessionStates): void => {
    const next = f(statesRef.current);
    statesRef.current = next;
    setStates(next);
  }, []);

  /**
   * 会话 meta 真值的 ref 镜像（refreshSessions 灌入）。无状态 submit 每轮都要
   * 带 cwd / 归属 / pi 本子——它们是**会话固定**的，以 meta 为准而不是当前的
   * 工作区选择（用户切了工作区再对旧会话发消息，工具目录不能跟着变）。
   * 事件路径（deliverNext 等 useCallback([]) 的回调）闭包里读不到 state，走 ref。
   */
  const sessionsRef = useRef<SessionMeta[]>([]);

  /**
   * 无状态开工的「当前意图」：显示值即注入值——每轮 submit 显式带上 model / mode，
   * 轮内改的只是显示，下一轮自然生效（一轮一模的保证在轮开始时的快照里）。
   * 同上，事件路径闭包读不到 state，走 ref。
   */
  const intentRef = useRef<{
    model: { providerId: string; modelId: string } | null;
    mode: PermissionMode;
    cwd: string | null;
    workspaceId: string | null;
    defaultCwd: string;
  }>({ model: null, mode: "plan", cwd: null, workspaceId: null, defaultCwd: "" });
  useEffect(() => {
    intentRef.current = { model, mode, cwd, workspaceId, defaultCwd };
  }, [model, mode, cwd, workspaceId, defaultCwd]);

  /**
   * **会话级意图**：用户在哪条会话上改的档位 / 模型，就记在哪条名下。
   *
   * 上面的 `intentRef` 是**单份全局**的，而它跟着「你正在看哪条会话」走
   * （`openSession` 会把 mode / model 改成被查看会话的值）；而 `deliverNext` 是
   * **不按「正看着谁」过滤**的，后台会话的队首照样会投递。两者合起来就是串台：
   * A（plan）跑着且队列非空 → 切去看 B（skip）→ A 的轮结束 → A 的排队卡拿着
   * **B 的权限档与 B 的模型**跑出去。档位决定 bash 能不能跑，这是安全边界上的串台。
   *
   * 所以意图必须按会话记账：你在 A 上选的就只给 A。它不需要清——这就是「用户对
   * 这条会话的最新选择」，永远至少和 meta 一样新（闲着时两边会自行收敛）。
   */
  const sessionIntentRef = useRef<
    Map<string, { mode?: PermissionMode; model?: { providerId: string; modelId: string } }>
  >(new Map());
  const rememberSessionIntent = useCallback(
    (id: string, patch: { mode?: PermissionMode; model?: { providerId: string; modelId: string } }) => {
      const map = sessionIntentRef.current;
      map.set(id, { ...map.get(id), ...patch });
    },
    [],
  );

  /**
   * 组装无状态开工上下文（AgentTurnContext 的主体）：meta 真值（cwd / 归属 /
   * pi 本子）+ 当前意图（模型 / 档位）。新会话（meta 还没落盘）用当前选择。
   * 拿不出可用上下文时把错误写进红字并返回 null——调用方直接放弃这一跳。
   */
  const buildTurn = useCallback(
    (id: string): Omit<SubmitAgentInput, "sessionId" | "text"> | null => {
      const intent = intentRef.current;
      if (intent.model === null) {
        setError("Add a provider with at least one model first");
        return null;
      }
      const meta = sessionsRef.current.find((entry) => entry.id === id) ?? null;
      const cwdTarget = meta?.cwd ?? intent.cwd ?? intent.defaultCwd;
      if (cwdTarget === "") {
        setError("Choose a workspace folder first");
        return null;
      }
      /**
       * 档位与模型按**这条会话自己**的账算，不能拿全局意图（= 正看着的那条）：
       *
       *   会话级意图  → 用户在这条会话上改过但还没落进 meta（跑着时改的）
       *   meta      → 落盘的真值
       *   全局意图  → 全新会话（meta 还不存在），那时 UI 上的选择就是意图
       *
       * cwd / 归属 / pi 本子不走这套——它们是会话固定事实，meta 就是真值。
       */
      const own = sessionIntentRef.current.get(id);
      const model = own?.model ?? (meta === null ? intent.model : { providerId: meta.providerId, modelId: meta.modelId });
      return {
        cwd: cwdTarget,
        workspaceId: meta?.workspaceId ?? intent.workspaceId ?? null,
        resume: meta?.piSessionFile != null ? { piSessionFile: meta.piSessionFile } : null,
        providerId: model.providerId,
        modelId: model.modelId,
        mode: own?.mode ?? meta?.mode ?? intent.mode,
      };
    },
    [],
  );


  /**
   * **读失败不清空。** 以前这里会 `.catch(() => setSessions([]))`，磁盘权限坏了就显示成
   * 「你的会话全没了」。现在失败只记到 `loads` 里，手里那份原样保留。
   */
  const refreshSessions = useCallback(() => {
    void api.session.list().then((list) => {
      setSessions(list);
      sessionsRef.current = list;
      setLoads((prev) => ({ ...prev, sessions: READY }));
      // **正看着的会话的 meta 必须从这里拿真值**——活会话（首页直接开的那条）
      // opened 一路是 null，不种上的话顶栏永远读 transcript 推导的旧标题，
      // 改名与模型标题都换不掉它（真实事故：改名后侧栏变了顶栏不变）。
      // 与 viewedId 同一条规则：盘上打开的优先，否则看活着的。
      setOpened((current) => {
        const id = current?.id ?? sessionRef.current ?? null;
        if (id === null) return null;
        return list.find((meta) => meta.id === id) ?? current;
      });
    }).catch((cause: unknown) => setLoads((prev) => ({ ...prev, sessions: failed(cause) })));
  }, []);

  useEffect(refreshSessions, [refreshSessions]);

  const refreshWorkspaces = useCallback(() => {
    void api.workspace
      .list()
      .then((list) => {
        setWorkspaces(list);
        setLoads((prev) => ({ ...prev, workspaces: READY }));
      })
      .catch((cause: unknown) => setLoads((prev) => ({ ...prev, workspaces: failed(cause) })));
  }, []);

  /**
   * 工作区的**写**操作失败也走列表那行错误。add / rename / remove 都要先把
   * 列表读一遍，所以读不出来时它们一定失败；失败原因跟列表是同一个（权限 / IO），
   * 没必要再开一块新的报错位。
   */
  const workspaceFailed = useCallback(
    (cause: unknown) => setLoads((prev) => ({ ...prev, workspaces: failed(cause) })),
    [],
  );

  /** 用户点了重试：先回到加载态让那一行有反应，再真的去读 */
  const reloadSessions = useCallback(() => {
    setLoads((prev) => ({ ...prev, sessions: LOADING }));
    refreshSessions();
  }, [refreshSessions]);

  const reloadWorkspaces = useCallback(() => {
    setLoads((prev) => ({ ...prev, workspaces: LOADING }));
    refreshWorkspaces();
  }, [refreshWorkspaces]);

  useEffect(refreshWorkspaces, [refreshWorkspaces]);

  useEffect(() => {
    void api.workspace
      .default()
      .then(setDefaultCwd)
      // 兜底目录读不到就不能静默落成 ""——那会让 send 报「先选工作区」，
      // 而真正的原因（磁盘 / 配置坏了）用户永远看不到
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  useEffect(() => {
    // 流式帧合帧：progress 的归约是纯函数（廉价），贵的是每次应用触发的渲染。
    // 回答期间 delta 可密到十几毫秒一帧，渲染把主线程挤满，点击与打字只能排在
    // 流式渲染后面——排队卡片点铅笔「时快时慢」的可感延迟根源（2026-09-10）。
    // 按 ~50ms 节拍攒批整批应用，渲染频率封顶，主线程留出空档；
    // phase / queue / permission 等低频且对延迟敏感的事件照旧即时应用。
    const coalescer = createProgressCoalescer<AgentEvent>((batch) => {
      applyStates((prev) => batch.reduce((acc, event) => applyAgentEvent(acc, event), prev));
    }, 50);
    const off = api.agent.onEvent((event) => {
        if (event.type === "failed") {
          // 回合级失败（重试耗尽）进槽、标注在对话里（applyAgentEvent 收）；
          // 操作级失败仍走全局红字（输入框上方）
          if (event.turn !== true) setError(event.message);
          // runtime 整个没了：全部槽归位（归约在 applyAgentEvent 里）。
          // 无状态后没有「活会话集合」要清——在不在跑由 runtime 的 running 表
          // 按真值回答，进程没了它自然空。
        }
        // 新一轮真的跑起来了（重试成功 / 用户重发 / 压缩开始）：上一次的失败已成
        // 过去，红字不再挂着——只有最后状态是失败时才该看到失败提示
        if (event.type === "phase" && event.phase !== "idle") setError(null);
        // 一轮跑完标题与 updatedAt 都变了，刷一次侧栏——**哪条会话跑完都刷**，
        // 后台完成的会话侧栏也该亮起来
        if (event.type === "phase" && event.phase === "idle") refreshSessions();
        // 模型标题到了（C-3，主进程已落 meta）：可能早于整轮结束，不等 phase idle
        if (event.type === "title") refreshSessions();
        // 会话内模型切换成功（C-4，主进程已落 meta）：对齐这份意图——
        // 它既是新任务默认也是会话切换的目标，只认正看着的那条会话的回执
        if (event.type === "model") {
          if (event.sessionId === sessionRef.current) {
            setModel({ providerId: event.providerId, modelId: event.modelId });
          }
          refreshSessions();
        }
        // 工具耗时在这里记账（事件必经之路）：组折叠时成员行不渲染，渲染驱动会漏
        if (
          event.type === "progress" &&
          (event.progress.type === "item_started" ||
            event.progress.type === "item_updated" ||
            event.progress.type === "item_finished")
        ) {
          recordToolFrame(event.progress.item);
          // 流式起点在这里记账（stats-format）：Responding 行的估算分母要它，
          // 而归约器只留最后一帧的时间戳。真值不需要——真值在终态帧的 speed 上
          recordAssistantStart(event.progress.item);
        }
        // **不按「正看着谁」过滤**：每个事件进自己会话的槽（本刀的根）
        // 流式帧进合帧器按节拍整批应用（见 effect 开头）；其余事件即时
        if (event.type === "progress") {
          coalescer.push(event);
          return;
        }
        applyStates((prev) => applyAgentEvent(prev, event));
        // **投递节奏归我们**：phase 一变就看队首该不该发，一次只发一条。
        // 交给 pi 的 post-run 自动 drain 会把好几条一起吹出去——用户一条条点、
        // 最后两条自己一起飞，就是那么来的（2026-09-06 事故）。
        if (event.type === "phase") deliverNext(event.sessionId);
      });
    return () => {
      off();
      coalescer.dispose();
    };
  }, [refreshSessions]);

  /**
   * 「配置好」= 设置里绿点的标准：api_key 已入库，或 env 档（密钥来自环境）。
   * 没填 key 的厂商与复制出来的副本不该出现在模型芯片里——选了也发不出去。
   */
  const usable = useMemo(
    () =>
      providers.filter(
        (p) =>
          ((p.auth.scheme === "api_key" && p.auth.hasSecret) || p.auth.scheme === "env") &&
          p.models.declared.length > 0,
      ),
    [providers],
  );

  // provider 到位后先落一个默认模型：第一个 provider 的第一个模型。
  // 用户没选过时界面上也该显示出到底会用哪个，而不是一片空白
  useEffect(() => {
    if (model !== null) return;
    const first = usable[0];
    const firstModel = first?.models.declared[0];
    if (first === undefined || firstModel === undefined) return;
    setModel({ providerId: first.id, modelId: firstModel.id });
  }, [usable, model]);

  // 会话 meta 里存的模型可能已随 provider 被删而失效——失效就清空，让上面的
  // 默认播种兜住。真实事故（2026-09-04）：旧会话存着已删除的 openai-compatible，
  // 打开后直接发送，主进程炸 unknown provider。providers 未加载完（usable 空）不判。
  useEffect(() => {
    if (model === null || usable.length === 0) return;
    if (!usable.some((p) => p.id === model.providerId)) setModel(null);
  }, [usable, model]);

  // 草稿键 = 当前查看的会话；send 与收回都写自己的键，互不串
  const draftKey = sessionId ?? opened?.id ?? "home";
  const draft = drafts.get(draftKey) ?? "";
  const setDraft = (value: string) => writeDraft(draftKey, value);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === "") return;
    setError(null);
    // 手动压缩指令在本地拦下，**不发给模型**——发出去模型会角色扮演一段
    // 「摘要」贴进对话，而什么都没压缩（真实发生过的事故）。
    const compact = parseCompactCommand(text);
    if (compact !== null) {
      const busyId = sessionRef.current;
      const busyPhase = busyId !== null ? statesRef.current.get(busyId)?.phase : undefined;
      // 跑着或压缩中：/compact 也排队——不打断正在跑的轮，等完全空闲
      // （前面排着的消息也发完）再压，压的才是完整对话。
      if (busyId !== null && busyPhase !== undefined && busyPhase !== "idle") {
        applyStates((prev) =>
          enqueue(prev, busyId, {
            id: crypto.randomUUID(),
            kind: "compact",
            ...(compact.instructions !== undefined ? { instructions: compact.instructions } : {}),
          }),
        );
        writeDraft(draftKey, "");
        return;
      }
      // 压缩要有可续的会话；**绝不为压缩新建会话**——对一条空会话压缩没有意义。
      // 无状态：压缩也是一次开机（resume 带上 pi 本子），不需要先「唤醒」。
      const active =
        sessionId ?? (opened !== null && opened.piSessionFile !== null ? opened.id : null);
      if (active === null) {
        setError("No running task to compact");
        return;
      }
      if (model === null) {
        setError("Add a provider with at least one model first");
        return;
      }
      // 压缩轮开起来的那一刻起它也是「当前活会话」——压缩期间按 stop 才能找到它
      if (sessionRef.current !== active) {
        setSessionId(active);
        sessionRef.current = active;
      }
      writeDraft(draftKey, "");
      // 乐观置 turn：压缩是一次真实的 LLM 调用，输入框立刻进入忙碌
      applyStates((prev) => setEntryPhase(prev, active, "turn"));
      void api.agent.compact({
        sessionId: active,
        cwd: opened?.cwd ?? cwd ?? defaultCwd,
        workspaceId: opened?.workspaceId ?? workspaceId ?? null,
        resume: opened?.piSessionFile != null ? { piSessionFile: opened.piSessionFile } : null,
        providerId: model.providerId,
        modelId: model.modelId,
        mode,
        ...(compact.instructions !== undefined ? { instructions: compact.instructions } : {}),
      });
      return;
    }
    // 「当前看哪条」：挂着的活会话，或从盘上打开的那条；首页两者皆无 → 开新的
    let id: string | null = sessionId ?? opened?.id ?? null;
    // **忙就排队，闲才直发**：这是队列归我们之后的核心分流。不再把消息推进 pi 的
    // steering/followUp——那边只有裸字符串、没有 id，正是一整晚竞态的来源。
    const busy = id !== null && statesRef.current.get(id)?.phase !== "idle";
    if (id !== null && busy) {
      const queuedId = crypto.randomUUID();
      applyStates((prev) => enqueue(prev, id as string, { id: queuedId, kind: "text", text }));
      setDraft("");
      return;
    }
    try {
      if (model === null) throw new Error("Add a provider with at least one model first");
      // 已有会话的 cwd / 归属 / 本子以 meta 真值为准（会话固定——用户切了工作区
      // 再对旧会话发消息，工具目录不能跟着变）；新会话用当前选择。
      const meta = id !== null ? sessions.find((entry) => entry.id === id) ?? null : null;
      const resume = meta?.piSessionFile != null ? { piSessionFile: meta.piSessionFile } : null;
      // 没选就落兜底——输入卡上写着「Home」，不是一个用户看不见的默认
      const target = meta?.cwd ?? cwd ?? defaultCwd;
      if (target === "") throw new Error("Choose a workspace folder first");
      const workspace = meta?.workspaceId ?? workspaceId ?? null;
      if (id === null) id = crypto.randomUUID();
      // 无论新建还是从盘上重开：发出去的那一刻起它就是「当前活会话」——排队 /
      // 停止 / 撤回都靠 sessionRef 找它，不设就全部静默 no-op（2026-09-11 B 验收复现）
      if (sessionRef.current !== id) {
        setSessionId(id);
        sessionRef.current = id;
      }
      writeDraft(draftKey, "");
      // 乐观置 turn：不等第一帧事件回来，输入框立刻进入「跑着」的样子。
      // 钉进 const：回调与 catch 里 TS 不保留 try 内的窄化
      const active: string = id;
      applyStates((prev) => setEntryPhase(prev, active, "turn"));
      // submit 自带全套开工上下文：换过的模型 / 权限档随本轮显式生效，
      // 轮内改显示、下一轮才注入的老冲账路径退场。
      await api.agent.submit({
        sessionId: active,
        text,
        cwd: target,
        workspaceId: workspace,
        resume,
        providerId: model.providerId,
        modelId: model.modelId,
        mode,
      });
      // 新本子的首轮：submit 的开机确认（等 created → 建 meta）返回后侧栏才看得见它
      if (resume === null) refreshSessions();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // 提交没送出去本轮就没跑起来；真跑起来的失败由 failed 事件归位
      if (id !== null) {
        const failed: string = id;
        applyStates((prev) => setEntryPhase(prev, failed, "idle"));
      }
    }
  }, [draft, sessionId, model, mode, cwd, workspaceId, defaultCwd, opened, sessions, refreshSessions]);

  const stop = useCallback(() => {
    // 只停当前轮。排队不动：pi 队列滞留给下次发送自动带上；压缩缓冲在压缩结束
    // （含被停止的压缩）的 phase 事件里自动发出——停止不替用户放弃任何已说的话
    if (sessionRef.current === null) return;
    void api.agent.abort(sessionRef.current);
  }, []);

  /** 回到首页。会话在首条消息提交时才真正创建（R8-01 ①）。 */
  const reset = useCallback(() => {
    setSessionId(null);
    sessionRef.current = null;
    setError(null);
    setOpened(null);
    // **槽不动**：回首页不等于后台会话停了，它们在各自的槽里继续涨
  }, []);

  /**
   * 打开一条会话：cwd / 归属 / 权限档一起恢复成它当时的样子。点的就是当前这条
   * 活着的会话时什么都不用做。**还在 runtime 里跑的会话直接重连活槽**——
   * 切回来就是最新画面，事件继续实时进。
   *
   * 没在跑的才从盘上把 transcript 种进槽；**续跑推迟到用户真的说话时**
   * （send 里带 resume）——打开一条会话就起一个进程内的 session 太贵了，
   * 翻记录是最常见的动作。
   */
  const openSession = useCallback((id: string) => {
    if (id === sessionRef.current) return;
    setError(null);
    setLoadingHistory(true);
    void api.session
      .load(id)
      .then((detail) => {
        setLoadingHistory(false);
        if (detail === null) return;
        // meta（cwd / 归属 / 权限档 / 模型）两条路都要恢复
        setOpened(detail.meta);
        setCwd(detail.meta.cwd);
        setWorkspaceId(detail.meta.workspaceId);
        // 会话级意图优先于 meta：这条会话跑着时改的档位 / 模型落不进 meta，
        // 切走再切回时若拿 meta 重置 chip，chip 就会说 plan 而下一轮实际跑 skip
        const own = sessionIntentRef.current.get(id);
        setMode(own?.mode ?? detail.meta.mode);
        setModel(own?.model ?? { providerId: detail.meta.providerId, modelId: detail.meta.modelId });
        // 无状态：没有「活会话集合」要重连——正在跑的会话它的槽本来就在 states
        // 里（事件一直实时进），不种盘上的快照（种盘等于把画面倒回去）；
        // 没在跑的才从盘上种，readOnly 与「说话时才续跑」（send 带 resume）语义照旧。
        //
        // **正在跑的会话要把控制面一起绑过来**（不变量 5）：sessionRef 是停止 /
        // 立即发送 / 撤回 / 拖拽找会话的**唯一入口**，置空就等于把这整排按钮
        // 变成静默 no-op（守卫都是 `sessionRef.current === null 就 return`，无报错）。
        // 实测：发完消息后只要点过侧栏任一条会话（包括点回正在跑的这条），停止就
        // 彻底失效，直到下一次发送——用户看到的是「打断时灵时不灵」。
        // fc3e958 修过 send / compact 两条路径，漏了导航这一条。
        //
        // 空闲会话仍然置空：`readOnly` 用 `sessionId === null` 判「没 pi 本子且还没
        // 唤醒」，绑上去会把只读的旧会话误判成可写。
        const live = (statesRef.current.get(id)?.phase ?? "idle") !== "idle";
        setSessionId(live ? id : null);
        sessionRef.current = live ? id : null;
        if (!statesRef.current.has(id)) {
          applyStates((prev) => seedFromDisk(prev, id, detail.transcript, detail.meta.stats));
        }
      })
      .catch((cause: unknown) => {
        setLoadingHistory(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, []);

  const renameSession = useCallback(
    (id: string, title: string) => {
      // **不做乐观更新**：改成空名字时后端会退回推导，猜不出来。
      // refreshSessions 会把列表与正开着的顶栏一起从真值同步。
      void api.session.rename(id, title).then(refreshSessions);
    },
    [refreshSessions],
  );

  const pinSession = useCallback(
    (id: string, pinned: boolean) => {
      void api.session.pin(id, pinned).then(refreshSessions);
    },
    [refreshSessions],
  );

  const archiveSession = useCallback(
    (id: string, archived: boolean) => {
      void api.session.archive(id, archived).then(refreshSessions);
    },
    [refreshSessions],
  );

  const moveSession = useCallback(
    (id: string, targetWorkspaceId: string | null) => {
      void api.session.move(id, targetWorkspaceId).then(() => {
        refreshSessions();
        // 正开着的就是这条：底栏那个作用域芯片也要跟着变
        setOpened((current) =>
          current?.id === id ? { ...current, workspaceId: targetWorkspaceId } : current,
        );
        if (id === sessionRef.current) setWorkspaceId(targetWorkspaceId);
      });
    },
    [refreshSessions],
  );

  const exportSession = useCallback((id: string) => {
    void api.session.exportMarkdown(id);
  }, []);

  // 分支的源是「活着的或正打开的那条」——按钮就长在它的转录里
  const branchFrom = useCallback(
    (anchorItemId: string) => {
      const id = sessionRef.current ?? opened?.id ?? null;
      if (id === null) return;
      void api.session
        .branch(id, anchorItemId)
        .then((newId) => {
          refreshSessions();
          openSession(newId);
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    },
    [opened, openSession, refreshSessions],
  );

  const removeSession = useCallback(
    (id: string) => {
      void api.session.remove(id).then(() => {
        setOpened((current) => (current?.id === id ? null : current));
        // 删掉的正是当前活着的那条：回到首页，别让界面停在一条已经没有记录的会话上
        if (id === sessionRef.current) reset();
        // 槽一并丢——runtime 那头由主进程删文件时同步释放（刀 0-4）
        setStates((current) => removeSessionEntry(current, id));
        refreshSessions();
      });
    },
    [reset, refreshSessions],
  );

  /** 不属于任何工作区的新任务：清掉归属与 cwd，落在兜底 */
  const newTask = useCallback(() => {
    reset();
    setCwd(null);
    setWorkspaceId(null);
  }, [reset]);

  /** 这个工作区里的新任务：路径与归属一起填好，用户不用再点一次 */
  const newTaskIn = useCallback(
    (workspace: Workspace) => {
      reset();
      setCwd(workspace.path);
      setWorkspaceId(workspace.id);
    },
    [reset],
  );

  /** 换工作区：当前会话的 cwd 已经固定，只能开新会话——UI 上说清楚，不让用户以为切了目录对话还跟着走。 */
  /** 加一个工作区，并把下一条任务直接落在它里面——加完就想用，别让人再点一次 */
  const addWorkspace = useCallback(() => {
    void api.workspace
      .add()
      .then((added) => {
        if (added === null) return;
        refreshWorkspaces();
        reset();
        setCwd(added.path);
        setWorkspaceId(added.id);
      })
      .catch(workspaceFailed);
  }, [reset, refreshWorkspaces, workspaceFailed]);

  /**
   * 换模型（C-4）。**有活会话就地切**：命令发过去，成功经 `model` 事件回环对齐
   * model state（不乐观——切换会失败：无 key、未知模型；失败红字说明，chip 不动）；
   * 没活的（首页 / 盘上打开未唤醒）只改意图，下一条消息 create 时生效——
   * 换了却不发言就切走，会被 openSession 的 meta 播种冲掉，等于没换过（已裁决接受）。
   * pi 的切换对正在跑的轮无效、下一轮生效——正在跑的轮照旧，写的和跑的不会再对不上。
   */
  /**
   * 立刻压一次上下文（A-1 用量菜单里那一项；A2-Q1 裁决：菜单项与 `/compact` 都要）。
   *
   * **只在闲着时给**——调用方（菜单项）已按 `phase !== "idle"` 禁用。
   * pi 的 `compact()` 会先打断当前这一轮，跑着时点它等于把回答砍了。
   *
   * 从盘上打开、还没唤醒的会话先按 resume 唤醒再压；**绝不为压缩新建会话**
   * ——对一条空会话压缩没有意义。进度不用单独回包：`compaction_start` /
   * `compaction` 事件那条链已经通了。
   */
  const compact = useCallback((): void => {
    setError(null);
    // 压缩要有可续的会话；无状态下压缩也是一次开机（resume 带 pi 本子），
    // 不需要先「唤醒」，更绝不为压缩新建会话。
    const active = sessionId ?? (opened !== null && opened.piSessionFile !== null ? opened.id : null);
    if (active === null) {
      setError("没有正在运行的任务可压缩");
      return;
    }
    const turn = buildTurn(active);
    if (turn === null) return;
    // 压缩轮开起来的那一刻起它也是「当前活会话」——压缩期间按 stop 才能找到它
    if (sessionRef.current !== active) {
      setSessionId(active);
      sessionRef.current = active;
    }
    // 乐观置 turn：压缩是一次真实的 LLM 调用，输入框立刻进入忙碌
    applyStates((prev) => setEntryPhase(prev, active, "turn"));
    void api.agent.compact({ sessionId: active, ...turn });
  }, [sessionId, opened, buildTurn, applyStates]);

  /**
   * 当前正在看的这条会话的相位。没有活会话（首页 / 盘上打开未唤醒）算 idle——
   * 那时根本没有「一轮」在跑，不该拦。
   */
  const currentPhase = useCallback((): SessionEntry["phase"] => {
    const id = sessionRef.current;
    return id === null ? "idle" : (statesRef.current.get(id)?.phase ?? "idle");
  }, []);

  const chooseModel = useCallback(
    (providerId: string, modelId: string) => {
      /**
       * **UI 即时、注入延迟**（D0 修订，wafo 2026-09-03 晚间裁决）。
       *
       * 第一版是「跑着就锁死 chip」——与 D-4 要做的「悬浮告诉用户这是 model」
       * 冲突（disabled 的语义先被占了），且拦的是用户而不是问题本身。
       *
       * 真正要防的是：pi 的 `setModel` 原地改 `agent.state.model`，重试循环的
       * 下一次尝试（`_prepareRetry` 后的 `agent.continue()`）读的就是它——
       * **一轮里既有失败记录又有成功回答**。所以只要保证注入不发生在轮内，
       * chip 永远可以点、选了就换显示：
       *
       *   闲着 → 立即注入（原有路径，成功后 model 事件回环对齐）
       *   跑着 → 只改本地显示，真正 IPC 挪到下一条消息发送前（见 send 里的
       *         flushPendingInjection）
       */
      setModel({ providerId, modelId });
      const id = sessionRef.current;
      if (id === null) return; // 首页开新任务：全局意图就是意图
      // 理由同 changeMode：模型也是「选给哪条会话」的，不能让后台会话的排队卡
      // 拿到你刚才给别的会话选的模型
      rememberSessionIntent(id, { model: { providerId, modelId } });
      if (currentPhase() === "idle") {
        // 闲着就注入（校验 + 落 meta + model 事件回环）；跑着只改显示——
        // 无状态下注入就是下一轮 submit 带上的新值，不需要欠账冲账
        void api.agent
          .setModel(id, providerId, modelId)
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
      }
    },
    [rememberSessionIntent],
  );

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      void api.workspace.rename(id, name).then(refreshWorkspaces).catch(workspaceFailed);
    },
    [refreshWorkspaces, workspaceFailed],
  );

  /** 移出列表。**不动磁盘上的文件夹，也不删它的会话**——那些会话落回 TASKS 下 */
  const removeWorkspace = useCallback(
    (id: string) => {
      void api.workspace
        .remove(id)
        .then(() => {
          refreshWorkspaces();
          // 正在往这个工作区里开新任务的话，退回「不属于任何工作区」
          setWorkspaceId((current) => (current === id ? null : current));
          setCwd((current) => (workspaceId === id ? null : current));
        })
        .catch(workspaceFailed);
    },
    [refreshWorkspaces, workspaceId, workspaceFailed],
  );

  const changeMode = useCallback((next: PermissionMode) => {
    // 理由同 chooseModel：权限档决定 bash 能不能跑，轮内改是另一种串台——
    // 所以注入延迟（UI 即时），不是锁 chip；跑着时下一轮 submit 自带新档
    setMode(next);
    const id = sessionRef.current;
    if (id === null) return; // 首页开新任务：还没有会话可记，全局意图就是意图
    // **先记在这条会话名下**：跑着时改不进 meta，而它的排队卡可能在你已经切去
    // 看别的会话之后才投递，那时全局意图已经是别人的了
    rememberSessionIntent(id, { mode: next });
    if (currentPhase() === "idle") {
      void api.agent
        .setMode(id, next)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }
  }, [rememberSessionIntent]);

  const answerApproval = useCallback((requestId: string, answer: PermissionAnswer) => {
    applyStates((prev) => removeApproval(prev, requestId));
    void api.agent.answerPermission(requestId, answer);
  }, [applyStates]);

  /** 排队项的文字退回草稿（拼接规则在 withdraw-draft.ts，那里有测试）。
   *  目标是**当前会话**的草稿——草稿已按会话隔离，不再是一份全局 string。 */
  const restoreToDraft = useCallback(
    (text: string) => {
      setDrafts((prev) =>
        new Map(prev).set(draftKey, appendWithdrawn(prev.get(draftKey) ?? "", text)),
      );
    },
    [draftKey],
  );

  /**
   * 投递队首的一条。**一次只发一条**——发完这一轮结束会再来一次 phase 事件，
   * 那时再取下一条。先出队再发：出队是同步的，避免同一拍被投递两次。
   */
  const deliverNext = useCallback((id: string) => {
    const entry = statesRef.current.get(id);
    if (entry === undefined) return;
    const head = nextDeliverable(entry);
    if (head === null) return;
    applyStates((prev) => dequeue(prev, id, head.id));
    const fail = (cause: unknown): void =>
      setError(cause instanceof Error ? cause.message : String(cause));
    if (head.kind === "compact") {
      const turn = buildTurn(id);
      if (turn === null) return;
      void api.agent
        .compact({ sessionId: id, ...turn, ...(head.instructions !== undefined ? { instructions: head.instructions } : {}) })
        .catch(fail);
    } else {
      const turn = buildTurn(id);
      if (turn === null) return;
      void api.agent.submit({ sessionId: id, text: head.text, ...turn }).catch(fail);
    }
  }, [applyStates, buildTurn]);

  /** 撤回：移出队列，文字落回草稿。全程本地，没有往返也就没有落空。 */
  const withdrawQueued = useCallback(
    (queuedId: string) => {
      const id = sessionRef.current;
      if (id === null) return;
      const item = statesRef.current.get(id)?.queued.find((entry) => entry.id === queuedId);
      if (item === undefined) return;
      applyStates((prev) => dequeue(prev, id, queuedId));
      // compact 项没有「用户的话」可拿回——本仓没有斜杠命令 UI，把 `/compact`
      // 塞进输入框只会变成一条普通消息。它的撤回就是单纯取消。
      if (item.kind === "text") restoreToDraft(item.text);
    },
    [restoreToDraft],
  );

  /** 拖拽排序：纯本地一次 splice，即时生效。 */
  const moveQueuedTo = useCallback(
    (sourceId: string, targetId: string, placement: "before" | "after") => {
      const id = sessionRef.current;
      if (id === null) return;
      applyStates((prev) => moveQueuedIn(prev, id, sourceId, targetId, placement));
    },
    [applyStates],
  );

  /**
   * 立即发送：停下当前这一轮，把这条作为新一轮发出去。
   *
   * 空闲时没有「当前轮」可停，退化成直接发——对用户是同一件事：别等了，现在就办。
   */
  const sendQueuedNow = useCallback((queuedId: string) => {
    const id = sessionRef.current;
    if (id === null) return;
    const entry = statesRef.current.get(id);
    const item = entry?.queued.find((queued) => queued.id === queuedId);
    if (entry === undefined || item === undefined) return;
    applyStates((prev) => dequeue(prev, id, queuedId));
    const fail = (cause: unknown): void =>
      setError(cause instanceof Error ? cause.message : String(cause));
    // compact 的「立即」是另一回事：不打断，只是不等空闲马上压
    if (item.kind === "compact") {
      const turn = buildTurn(id);
      if (turn === null) return;
      void api.agent
        .compact({ sessionId: id, ...turn, ...(item.instructions !== undefined ? { instructions: item.instructions } : {}) })
        .catch(fail);
      return;
    }
    const turn = buildTurn(id);
    if (turn === null) return;
    if (entry.phase === "idle") {
      void api.agent.submit({ sessionId: id, text: item.text, ...turn }).catch(fail);
    } else {
      void api.agent.interrupt({ sessionId: id, text: item.text, ...turn }).catch(fail);
    }
  }, [applyStates, buildTurn]);



  // 「当前看哪条」：挂着的活会话，或从盘上打开的那条；首页两者皆无 → 空槽兜底。
  // ChatView 本来就用 sessionId ?? opened?.id 推标题里的会话，这里不另设第二份账
  const viewedId = sessionId ?? opened?.id ?? null;
  const entry = (viewedId !== null ? states.get(viewedId) : undefined) ?? EMPTY_ENTRY;

  // selectTranscript 每次调用都造新数组（pi 的实现如此）——在这里按 entry 引用
  // 稳定化，否则 ChatView 的 memo 转录列每次渲染都被新引用击穿，隔离形同虚设
  const transcript = useMemo(() => selectTranscript(entry.transcript), [entry.transcript]);

  return {
    sessionId,
    transcript,
    compactions: entry.compactions,
    phase: entry.phase,
    retry: entry.retry,
    turnError: entry.turnError,
    stats: entry.stats,
    phaseOf: (id: string): SessionEntry["phase"] => states.get(id)?.phase ?? "idle",
    turnErrorOf: (id: string): string | null => states.get(id)?.turnError ?? null,
    error,
    draft,
    setDraft,
    mode,
    changeMode,
    approvals: entry.approvals,
    workspaces,
    addWorkspace,
    renameWorkspace,
    removeWorkspace,
    cwd,
    workspaceId,
    defaultCwd,
    usable,
    model,
    chooseModel,
    compact,
    sessions,
    loads,
    reloadSessions,
    reloadWorkspaces,
    sessionsLoaded,
    loadingHistory,
    opened,
    // 打开的是一条没有 pi 本子的旧会话，且还没开新的——只能读
    readOnly: opened !== null && opened.piSessionFile === null && sessionId === null,
    openSession,
    renameSession,
    pinSession,
    archiveSession,
    moveSession,
    branchFrom,
    exportSession,
    removeSession,
    send: () => void send(),
    stop,
    queued: entry.queued,
    sendQueuedNow,
    withdrawQueued,
    moveQueuedTo,
    newTask,
    newTaskIn,
    answerApproval,
  };
}
