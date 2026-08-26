import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyTranscriptProgress,
  createTranscriptState,
  selectTranscript,
  type TranscriptState,
} from "@earendil-works/pi-coding-agent/client";
import type { SessionSnapshot, TranscriptItem } from "@earendil-works/pi-protocol";
import { api } from "../../api";
import type { PendingApproval } from "./ApprovalBar";
import type { PermissionAnswer, PermissionMode } from "@shared/permission";
import type { ProviderDto } from "@shared/provider";
import type { SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";

/**
 * 会话状态。**逻辑原样自 ChatView 上提**，一行未改语义——上提的唯一理由是
 * app shell 里左栏（会话列表 / 工作区）与中卡（聊天面）需要读同一份状态，
 * 而它们在 DOM 上是兄弟，状态没法再留在中卡里。
 *
 * transcript 由 **pi 自带的归约器**维护，我们不写第二份归约逻辑（guideline §三）。
 */
export interface ChatSession {
  sessionId: string | null;
  transcript: readonly TranscriptItem[];
  /** turn = 这一轮还在跑；idle = 可以发下一句 */
  phase: "idle" | "turn";
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
  const [state, setState] = useState<TranscriptState>(() => createTranscriptState(seedSnapshot()));
  const [phase, setPhase] = useState<"idle" | "turn">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 三档权限模式。默认 plan——**默认最保守**，开工具要用户自己往下调。 */
  const [mode, setMode] = useState<PermissionMode>("plan");
  /** 排队中的工具审批。同一时刻可能有多个（并行工具调用），逐个应答。 */
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  /** agent 能看到的文件夹。**session 的 cwd 在创建时固定**，所以换工作区 = 换会话。 */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [opened, setOpened] = useState<SessionMeta | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState<string>("");
  const sessionRef = useRef<string | null>(null);

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
          setPhase("idle");
          return;
        }
        // ready / created 不带会话内容；其余按 sessionId 过滤，一个进程托管多个 session
        if (event.type === "permission") {
          if (event.sessionId !== sessionRef.current) return;
          setApprovals((prev) => [
            ...prev,
            { requestId: event.requestId, toolName: event.toolName, input: event.input },
          ]);
          return;
        }
        if (event.type !== "progress" && event.type !== "phase") return;
        if (event.sessionId !== sessionRef.current) return;
        if (event.type === "progress")
          setState((prev) => applyTranscriptProgress(prev, event.progress));
        else {
          setPhase(event.phase === "idle" ? "idle" : "turn");
          // 一轮跑完标题与 updatedAt 都变了，刷一次侧栏
          if (event.phase === "idle") refreshSessions();
        }
      }),
    [refreshSessions],
  );

  const usable = useMemo(
    () => providers.filter((p) => p.models.declared.length > 0),
    [providers],
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text === "") return;
    setError(null);
    try {
      let id = sessionId;
      if (id === null) {
        const provider = usable[0];
        if (!provider) throw new Error("Add a provider with at least one model first");
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
          providerId: provider.id,
          modelId: provider.models.declared[0]?.id ?? "",
          mode,
        });
        setSessionId(id);
        sessionRef.current = id;
        refreshSessions();
      }
      setDraft("");
      setPhase("turn");
      await api.agent.submit(id, text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("idle");
    }
  }, [draft, sessionId, usable, mode, cwd, workspaceId, defaultCwd, opened, refreshSessions]);

  const stop = useCallback(() => {
    if (sessionRef.current === null) return;
    void api.agent.abort(sessionRef.current);
  }, []);

  /** 回到首页。会话在首条消息提交时才真正创建（R8-01 ①）。 */
  const reset = useCallback(() => {
    setSessionId(null);
    sessionRef.current = null;
    setState(createTranscriptState(seedSnapshot()));
    setApprovals([]);
    setPhase("idle");
    setError(null);
    setOpened(null);
  }, []);

  /**
   * 打开一条会话：**把它的 transcript 种进 transcript 状态**，并把 cwd / 归属 / 权限档
   * 一起恢复成它当时的样子。点的就是当前这条活着的会话时什么都不用做。
   *
   * 这里不建 agent——**续跑推迟到用户真的说话时**（send 里带 resume）。
   * 打开一条会话就起一个进程内的 session 太贵了，翻记录是最常见的动作。
   */
  const openSession = useCallback((id: string) => {
    if (id === sessionRef.current) return;
    setError(null);
    void api.session
      .load(id)
      .then((detail) => {
        if (detail === null) return;
        setSessionId(null);
        sessionRef.current = null;
        setApprovals([]);
        setPhase("idle");
        setState(createTranscriptState(seedSnapshot(detail.transcript)));
        setOpened(detail.meta);
        setCwd(detail.meta.cwd);
        setWorkspaceId(detail.meta.workspaceId);
        setMode(detail.meta.mode);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, []);

  const removeSession = useCallback(
    (id: string) => {
      void api.session.remove(id).then(() => {
        setOpened((current) => (current?.id === id ? null : current));
        // 删掉的正是当前活着的那条：回到首页，别让界面停在一条已经没有记录的会话上
        if (id === sessionRef.current) reset();
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
    setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    void api.agent.answerPermission(requestId, answer);
  }, []);

  return {
    sessionId,
    transcript: selectTranscript(state),
    phase,
    error,
    draft,
    setDraft,
    mode,
    changeMode,
    approvals,
    workspaces,
    addWorkspace,
    renameWorkspace,
    removeWorkspace,
    cwd,
    workspaceId,
    defaultCwd,
    usable,
    sessions,
    opened,
    // 打开的是一条没有 pi 本子的旧会话，且还没开新的——只能读
    readOnly: opened !== null && opened.piSessionFile === null && sessionId === null,
    openSession,
    removeSession,
    send: () => void send(),
    stop,
    newTask,
    newTaskIn,
    answerApproval,
  };
}

/**
 * 归约器的起点快照。打开旧会话时**把落盘的 transcript 种进去**，
 * 之后的 progress 直接往下追加——所以实时与历史是同一条渲染路径，不是两条。
 */
function seedSnapshot(transcript: readonly TranscriptItem[] = []): SessionSnapshot {
  const now = Date.now();
  return {
    id: "local",
    cwd: ".",
    createdAt: now,
    updatedAt: now,
    phase: "idle",
    model: { provider: "pending", id: "pending" },
    thinkingLevel: "off",
    attached: true,
    locked: false,
    revision: 0,
    transcript: [...transcript],
    queuedSteer: [],
    queuedSteerCount: 0,
  };
}
