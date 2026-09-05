import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { api } from "../../api";
import {
  EMPTY_ENTRY,
  addPendingSend,
  applyAgentEvent,
  consumePendingSends,
  consumePendingTexts,
  createSessionStates,
  editPendingSend,
  mergeQueueView,
  parseCompactCommand,
  removeApproval,
  removePendingSend,
  removeSessionEntry,
  replaceQueueOrderKey,
  seedFromDisk,
  setEntryPhase,
  type PendingApproval,
  type PendingSend,
  type QueueViewEntry,
  type SessionEntry,
  type SessionStates,
} from "./session-states.ts";
import { LOADING, READY, failed, type LoadState } from "./load-state.ts";
import { recordToolFrame } from "./tool-results.ts";
import type { PermissionAnswer, PermissionMode } from "@shared/permission";
import type { AgentStats, RetryStatus } from "@shared/agent-ipc";
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
  draft: string;
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
  /** 至少声明了一个模型的 provider——没有它就发不出消息 */
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
  /** pi 排队快照（当前槽）：steering = 插队中，followUp = 等本轮结束 */
  queue: SessionEntry["queue"];
  /** 本地待办（当前槽）：压缩期间的消息 + 排队的手动 /compact */
  pendingSends: readonly PendingSend[];
  /** 排队卡片视图：pi 队列项与本地待办按输入顺序交错 */
  queueView: readonly QueueViewEntry[];
  /** 排队项转插队（下一个工具边界注入当前轮）。index 指 [...steering, ...followUp] 拼接视图 */
  /** 立即发送排队中的第 index 条：打断当前轮（含工具调用），它成为新一轮 */
  interruptQueued: (index: number, text: string) => void;
  /** 排队项移出 pi 队列（runtime 侧 clearQueue + 重放实现） */
  cancelQueued: (index: number, text: string) => void;
  /** 排队项改文本（保持原属队列与顺位） */
  editQueued: (index: number, text: string, newText: string) => void;
  /** 取消一条本地待办（纯本地状态） */
  cancelPendingSend: (index: number) => void;
  /** 改写一条本地待办的文本（text 改内容，compact 改压缩要求） */
  editPendingSend: (index: number, text: string) => void;
  /** 本地 compact 待办的「立即」：马上压缩，不等空闲 */
  runPendingNow: (index: number) => void;
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
  const [draft, setDraft] = useState("");
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
  /** 还在 runtime 里活着的会话。send 创建时加入，runtime 崩溃时清空；
   *  openSession 命中它就重连活槽，而不是从盘上种一份旧的。 */
  const liveRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  // ref 兜底同步：onEvent 的 updater 已即时写 ref，这里接住其余 setStates 路径
  // （seed / removeApproval / 乐观 phase……）——只晚一拍，这些路径没有重发竞态。
  useEffect(() => {
    statesRef.current = states;
  }, [states]);

  /**
   * **读失败不清空。** 以前这里会 `.catch(() => setSessions([]))`，磁盘权限坏了就显示成
   * 「你的会话全没了」。现在失败只记到 `loads` 里，手里那份原样保留。
   */
  const refreshSessions = useCallback(() => {
    void api.session.list().then((list) => {
      setSessions(list);
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

  useEffect(
    () =>
      api.agent.onEvent((event) => {
        if (event.type === "failed") {
          // 回合级失败（重试耗尽）进槽、标注在对话里（applyAgentEvent 收）；
          // 操作级失败仍走全局红字（输入框上方）
          if (event.turn !== true) setError(event.message);
          // runtime 整个没了：live 账本清零，全部槽归位（归约在 applyAgentEvent 里）
          if (event.sessionId === null) liveRef.current.clear();
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
        }
        // **不按「正看着谁」过滤**：每个事件进自己会话的槽（本刀的根）
        // 本地待办的执行时机（读 ref 而不是闭包 states：同拍可能已有事件更新过它）：
        //  - phase 到 idle：先发前面的 text，碰到第一个 compact 就执行它并停——
        //    同时压两个会互相踩，剩余项留给压缩结束的下一拍
        //  - phase 离开 compaction 但又跑起来（压缩后有排队消息在跑）：text 全放
        //    （runtime 侧自动分流进 pi 队列），compact 必须等完全 idle
        if (event.type === "phase" && event.phase !== "compaction") {
          const id = event.sessionId;
          const pending = statesRef.current.get(id)?.pendingSends ?? [];
          if (pending.length > 0) {
            if (event.phase === "idle") {
              let executed = 0;
              for (const item of pending) {
                executed++;
                if (item.kind === "compact") {
                  void api.agent.compact(id, item.instructions).catch((cause: unknown) =>
                    setError(cause instanceof Error ? cause.message : String(cause)),
                  );
                  break;
                }
                void api.agent.submit(id, item.text).catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                );
              }
              setStates((prev) => consumePendingSends(prev, id, executed));
            } else {
              for (const item of pending) {
                if (item.kind !== "text") continue;
                void api.agent.submit(id, item.text).catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                );
              }
              setStates((prev) => consumePendingTexts(prev, id));
            }
          }
        }
        setStates((prev) => {
          const next = applyAgentEvent(prev, event);
          statesRef.current = next;
          return next;
        });
      }),
    [refreshSessions],
  );

  const usable = useMemo(
    () => providers.filter((p) => p.models.declared.length > 0),
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
      // 跑着或压缩中：/compact 也排队——不打断正在跑的轮，等完全空闲（pi 队列里的
      // 排队消息也处理完）再压。压缩指令进不了 pi 队列（那里只存消息文本），只能本地等。
      if (busyId !== null && busyPhase !== undefined && busyPhase !== "idle") {
        setStates((prev) =>
          addPendingSend(prev, busyId, { kind: "compact", instructions: compact.instructions }),
        );
        setDraft("");
        return;
      }
      // 压缩要有可续的会话：活着的直接压；从盘上打开还没唤醒的先按 resume
      // 唤醒再压。**绝不为压缩新建会话**——对一条空会话压缩没有意义。
      let active = sessionRef.current;
      try {
        if (active === null && opened !== null && opened.piSessionFile !== null) {
          if (model === null) throw new Error("Add a provider with at least one model first");
          active = await api.agent.create({
            cwd: opened.cwd,
            workspaceId: opened.workspaceId,
            resume: { sessionId: opened.id, piSessionFile: opened.piSessionFile },
            providerId: model.providerId,
            modelId: model.modelId,
            mode,
          });
          setSessionId(active);
          sessionRef.current = active;
          liveRef.current.add(active);
          refreshSessions();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return;
      }
      if (active === null) {
        setError("没有正在运行的任务可压缩");
        return;
      }
      setDraft("");
      const id: string = active;
      // 乐观置 turn：压缩是一次真实的 LLM 调用，输入框立刻进入忙碌
      setStates((prev) => setEntryPhase(prev, id, "turn"));
      void api.agent.compact(id, compact.instructions);
      return;
    }
    let id: string | null = sessionId;
    // 压缩中 pi 连入队入口都关着（prompt 直接抛）：消息进本地待办，压缩结束自动发
    if (id !== null && statesRef.current.get(id)?.phase === "compaction") {
      setStates((prev) => addPendingSend(prev, id as string, { kind: "text", text }));
      setDraft("");
      return;
    }
    try {
      if (id === null) {
        if (model === null) throw new Error("Add a provider with at least one model first");
        // 没选就落兜底——输入卡上写着「Home」，不是一个用户看不见的默认
        const target = cwd ?? defaultCwd;
        if (target === "") throw new Error("Choose a workspace folder first");
        // 打开的是一条能续的旧会话：沿用它的 id 与 pi 的本子，新消息接着写进同一份记录
        const resume =
          opened !== null && opened.piSessionFile !== null
            ? { sessionId: opened.id, piSessionFile: opened.piSessionFile }
            : null;
        id = await api.agent.create({
          cwd: target,
          workspaceId,
          resume,
          providerId: model.providerId,
          modelId: model.modelId,
          mode,
        });
        setSessionId(id);
        sessionRef.current = id;
        liveRef.current.add(id);
        // 建会话就是把当前的 model / mode 注进去了——台账对齐，send 尾部不用再冲
        injectedModelRef.current = { providerId: model.providerId, modelId: model.modelId };
        injectedModeRef.current = mode;
        refreshSessions();
      }
      setDraft("");
      // 乐观置 turn：不等第一帧事件回来，输入框立刻进入「跑着」的样子。
      // 钉进 const：回调与 catch 里 TS 不保留 try 内的窄化
      const active: string = id;
      /**
       * **冲欠账**：跑着的轮里换的模型 / 权限档只动了显示（见 chooseModel），
       * 这里才是它们真正注入的时刻——**新的一轮开始之前**。
       * pi 的 setModel 原地改 agent.state.model，轮内注入会让重试的下一次尝试
       * 换模型成功（一轮两模）；挪到这里，注入永远发生在轮与轮的间隙。
       */
      if (model !== null && injectedModelRef.current !== null && model !== injectedModelRef.current) {
        await api.agent.setModel(active, model.providerId, model.modelId);
        injectedModelRef.current = { providerId: model.providerId, modelId: model.modelId };
      }
      if (injectedModeRef.current !== null && mode !== injectedModeRef.current) {
        await api.agent.setMode(active, mode);
        injectedModeRef.current = mode;
      }
      setStates((prev) => setEntryPhase(prev, active, "turn"));
      await api.agent.submit(active, text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // 提交没送出去本轮就没跑起来；真跑起来的失败由 failed 事件归位
      if (id !== null) {
        const failed: string = id;
        setStates((prev) => setEntryPhase(prev, failed, "idle"));
      }
    }
  }, [draft, sessionId, model, mode, cwd, workspaceId, defaultCwd, opened, refreshSessions]);

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
        setMode(detail.meta.mode);
        setModel({ providerId: detail.meta.providerId, modelId: detail.meta.modelId });
        if (liveRef.current.has(id)) {
          // **还在跑：重连活槽**。sessionId 接上，事件继续实时进；
          // 不种盘上的快照——槽里的累积比盘新，种盘等于把画面倒回去
          setSessionId(id);
          sessionRef.current = id;
          return;
        }
        // 没在跑：从盘上种槽，readOnly 与「说话时才续跑」语义照旧
        setSessionId(null);
        sessionRef.current = null;
        // 打开的是盘上的死会话：agent 那边什么都没注入，台账清零；
        // 唤醒（下一条消息）时 create 会带着当前显示值重新记账
        injectedModelRef.current = null;
        injectedModeRef.current = null;
        setStates((prev) => seedFromDisk(prev, id, detail.transcript, detail.meta.stats));
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
        // 槽与 live 账本一并丢——runtime 那头由主进程删文件时同步释放（刀 0-4）
        setStates((current) => removeSessionEntry(current, id));
        liveRef.current.delete(id);
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
  const compact = useCallback(async (): Promise<void> => {
    setError(null);
    let active = sessionRef.current;
    try {
      if (active === null && opened !== null && opened.piSessionFile !== null) {
        if (model === null) throw new Error("Add a provider with at least one model first");
        active = await api.agent.create({
          cwd: opened.cwd,
          workspaceId: opened.workspaceId,
          resume: { sessionId: opened.id, piSessionFile: opened.piSessionFile },
          providerId: model.providerId,
          modelId: model.modelId,
          mode,
        });
        setSessionId(active);
        sessionRef.current = active;
        liveRef.current.add(active);
        refreshSessions();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (active === null) {
      setError("没有正在运行的任务可压缩");
      return;
    }
    const id: string = active;
    // 乐观置 turn：压缩是一次真实的 LLM 调用，输入框立刻进入忙碌
    setStates((prev) => setEntryPhase(prev, id, "turn"));
    void api.agent.compact(id, undefined);
  }, [opened, model, mode, refreshSessions]);

  /**
   * **已注入 agent 的模型 / 权限档**。与显示值（`model` / `mode`）分离——
   * 跑着的轮里改的只是显示，注入被推迟，这里记的是 agent 那边真正的状态。
   * 不追它就不知道 send 时有没有欠账要冲。
   */
  /** 显示值不读它们（读 model / mode），所以 ref 就够，不必是 state */
  const injectedModelRef = useRef<{ providerId: string; modelId: string } | null>(null);
  const injectedModeRef = useRef<PermissionMode | null>(null);

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
      if (id !== null && currentPhase() === "idle") {
        void api.agent
          .setModel(id, providerId, modelId)
          .then(() => {
            injectedModelRef.current = { providerId, modelId };
          })
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
      }
    },
    [],
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
    // 所以注入延迟（UI 即时），不是锁 chip
    setMode(next);
    const id = sessionRef.current;
    if (id !== null && currentPhase() === "idle") {
      void api.agent
        .setMode(id, next)
        .then(() => {
          injectedModeRef.current = next;
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    }
  }, []);

  const answerApproval = useCallback((requestId: string, answer: PermissionAnswer) => {
    setStates((prev) => removeApproval(prev, requestId));
    void api.agent.answerPermission(requestId, answer);
  }, []);

  // 排队编辑只对「当前活着的会话」有意义——排队的消息本来就来自这里的输入框
  const queueEdit = useCallback(
    (op: "cancel" | "edit", index: number, text: string, newText?: string) => {
      const id = sessionRef.current;
      if (id === null) return;
      // edit 先把顺序账本里的键换掉：queue_update 带新文本回来时对账能保住原位
      if (op === "edit" && newText !== undefined) {
        setStates((prev) => replaceQueueOrderKey(prev, id, `pi\0${text}`, `pi\0${newText}`));
      }
      void api.agent
        .queueEdit(id, op, index, text, newText)
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    },
    [],
  );

  const editPending = useCallback((index: number, text: string) => {
    const id = sessionRef.current;
    if (id === null) return;
    setStates((prev) => editPendingSend(prev, id, index, text));
  }, []);

  const cancelPendingSend = useCallback((index: number) => {
    const id = sessionRef.current;
    if (id === null) return;
    setStates((prev) => removePendingSend(prev, id, index));
  }, []);

  /** 本地待办的「立即」：只对 compact 有意义——不等空闲，马上压（pi 会先停当前轮） */
  const runPendingNow = useCallback((index: number) => {
    const id = sessionRef.current;
    if (id === null) return;
    const item = statesRef.current.get(id)?.pendingSends[index];
    if (item === undefined || item.kind !== "compact") return;
    setStates((prev) => removePendingSend(prev, id, index));
    void api.agent
      .compact(id, item.instructions)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  // 「当前看哪条」：挂着的活会话，或从盘上打开的那条；首页两者皆无 → 空槽兜底。
  // ChatView 本来就用 sessionId ?? opened?.id 推标题里的会话，这里不另设第二份账
  const viewedId = sessionId ?? opened?.id ?? null;
  const entry = (viewedId !== null ? states.get(viewedId) : undefined) ?? EMPTY_ENTRY;

  return {
    sessionId,
    transcript: selectTranscript(entry.transcript),
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
    queue: entry.queue,
    pendingSends: entry.pendingSends,
    /** 卡片渲染视图：pi 队列 + 本地待办按输入序交错（见 mergeQueueView） */
    queueView: mergeQueueView(entry),
    interruptQueued: (index: number, text: string) => {
      const id = sessionRef.current;
      if (id === null) return;
      void api.agent.interrupt(id, index, text).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    cancelQueued: (index: number, text: string) => queueEdit("cancel", index, text),
    editQueued: (index: number, text: string, newText: string) =>
      queueEdit("edit", index, text, newText),
    cancelPendingSend,
    editPendingSend: editPending,
    runPendingNow,
    newTask,
    newTaskIn,
    answerApproval,
  };
}
