import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { api } from "../../api";
import {
  EMPTY_ENTRY,
  applyAgentEvent,
  createSessionStates,
  parseCompactCommand,
  removeApproval,
  removeSessionEntry,
  seedFromDisk,
  setEntryPhase,
  type PendingApproval,
  type SessionEntry,
  type SessionStates,
} from "./session-states.ts";
import type { PermissionAnswer, PermissionMode } from "@shared/permission";
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
  /**
   * 最近一次用量快照（token / 花费 / 上下文余量），每轮落定时由 runtime 推来。
   * null = 还没有：纯浏览的旧会话不起 runtime session，等说话唤醒后才有数字。
   */
  stats: SessionStats | null;
  /**
   * 按 id 查某条会话的运行态（槽里有真相）。侧栏每行要显示**它自己**的转圈/完成，
   * 与「当前看哪条」无关——后台在跑的会话切走了也照样转圈。
   */
  phaseOf: (id: string) => SessionEntry["phase"];
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
  /** 下一条任务用哪个模型。**改它会开新任务**——pi 的 session 在创建时定下模型 */
  model: { providerId: string; modelId: string } | null;
  chooseModel: (providerId: string, modelId: string) => void;
  /** 落盘的会话列表，新的在前。侧栏 TASKS 节点列的就是它。 */
  sessions: SessionMeta[];
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
  /** 导出成 Markdown；取消时什么都不做 */
  exportSession: (id: string) => void;
  removeSession: (id: string) => void;
  send: () => void;
  /** 打断当前这一轮。pi 的 abort 走的是与工具审批不同的一条路，不需要等审批答复 */
  stop: () => void;
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
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 三档权限模式。默认 plan——**默认最保守**，开工具要用户自己往下调。 */
  const [mode, setMode] = useState<PermissionMode>("plan");
  /** agent 能看到的文件夹。**session 的 cwd 在创建时固定**，所以换工作区 = 换会话。 */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
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

  const refreshSessions = useCallback(() => {
    void api.session
      .list()
      .then(setSessions)
      .catch(() => setSessions([]));
  }, []);

  useEffect(refreshSessions, [refreshSessions]);

  const refreshWorkspaces = useCallback(() => {
    void api.workspace
      .list()
      .then(setWorkspaces)
      .catch(() => setWorkspaces([]));
  }, []);

  useEffect(refreshWorkspaces, [refreshWorkspaces]);

  useEffect(() => {
    void api.workspace
      .default()
      .then(setDefaultCwd)
      .catch(() => setDefaultCwd(""));
  }, []);

  useEffect(
    () =>
      api.agent.onEvent((event) => {
        if (event.type === "failed") {
          setError(event.message);
          // runtime 整个没了：live 账本清零，全部槽归位（归约在 applyAgentEvent 里）
          if (event.sessionId === null) liveRef.current.clear();
        }
        // 一轮跑完标题与 updatedAt 都变了，刷一次侧栏——**哪条会话跑完都刷**，
        // 后台完成的会话侧栏也该亮起来
        if (event.type === "phase" && event.phase === "idle") refreshSessions();
        // **不按「正看着谁」过滤**：每个事件进自己会话的槽（本刀的根）
        setStates((prev) => applyAgentEvent(prev, event));
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

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === "") return;
    setError(null);
    // 手动压缩指令在本地拦下，**不发给模型**——发出去模型会角色扮演一段
    // 「摘要」贴进对话，而什么都没压缩（真实发生过的事故）。
    const compact = parseCompactCommand(text);
    if (compact !== null) {
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
        refreshSessions();
      }
      setDraft("");
      // 乐观置 turn：不等第一帧事件回来，输入框立刻进入「跑着」的样子。
      // 钉进 const：回调与 catch 里 TS 不保留 try 内的窄化
      const active: string = id;
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
    void api.session
      .load(id)
      .then((detail) => {
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
        setStates((prev) => seedFromDisk(prev, id, detail.transcript));
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  const renameSession = useCallback((id: string, title: string) => {
    void api.session
      .rename(id, title)
      .then(() => api.session.list())
      .then((list) => {
        setSessions(list);
        // **不做乐观更新**：改成空名字时后端会退回推导，猜不出来。
        // 正开着的就是这条时，标题栏也要跟着变，所以从刷新回来的真值里取。
        setOpened((current) => {
          if (current === null) return current;
          const fresh = list.find((meta) => meta.id === current.id);
          return fresh ?? current;
        });
      });
  }, []);

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
    void api.workspace.add().then((added) => {
      if (added === null) return;
      refreshWorkspaces();
      reset();
      setCwd(added.path);
      setWorkspaceId(added.id);
    });
  }, [reset, refreshWorkspaces]);

  /**
   * 换模型。**开新任务**——pi 的 session 在创建时定下模型，
   * 中途换会让界面上写的和实际在跑的对不上。作用域同理。
   */
  const chooseModel = useCallback(
    (providerId: string, modelId: string) => {
      reset();
      setModel({ providerId, modelId });
    },
    [reset],
  );

  const renameWorkspace = useCallback(
    (id: string, name: string) => {
      void api.workspace.rename(id, name).then(refreshWorkspaces);
    },
    [refreshWorkspaces],
  );

  /** 移出列表。**不动磁盘上的文件夹，也不删它的会话**——那些会话落回 TASKS 下 */
  const removeWorkspace = useCallback(
    (id: string) => {
      void api.workspace.remove(id).then(() => {
        refreshWorkspaces();
        // 正在往这个工作区里开新任务的话，退回「不属于任何工作区」
        setWorkspaceId((current) => (current === id ? null : current));
        setCwd((current) => (workspaceId === id ? null : current));
      });
    },
    [refreshWorkspaces, workspaceId],
  );

  const changeMode = useCallback((next: PermissionMode) => {
    setMode(next);
    if (sessionRef.current !== null) void api.agent.setMode(sessionRef.current, next);
  }, []);

  const answerApproval = useCallback((requestId: string, answer: PermissionAnswer) => {
    setStates((prev) => removeApproval(prev, requestId));
    void api.agent.answerPermission(requestId, answer);
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
    stats: entry.stats,
    phaseOf: (id: string): SessionEntry["phase"] => states.get(id)?.phase ?? "idle",
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
    sessions,
    opened,
    // 打开的是一条没有 pi 本子的旧会话，且还没开新的——只能读
    readOnly: opened !== null && opened.piSessionFile === null && sessionId === null,
    openSession,
    renameSession,
    pinSession,
    archiveSession,
    moveSession,
    exportSession,
    removeSession,
    send: () => void send(),
    stop,
    newTask,
    newTaskIn,
    answerApproval,
  };
}
