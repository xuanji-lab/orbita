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
  workspace: string | null;
  /** 至少声明了一个模型的 provider——没有它就发不出消息 */
  usable: ProviderDto[];
  send: () => void;
  /** 打断当前这一轮。pi 的 abort 走的是与工具审批不同的一条路，不需要等审批答复 */
  stop: () => void;
  chooseWorkspace: () => void;
  newTask: () => void;
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
  const [workspace, setWorkspace] = useState<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    void api.workspace
      .current()
      .then(setWorkspace)
      .catch(() => setWorkspace(null));
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
        else setPhase(event.phase === "idle" ? "idle" : "turn");
      }),
    [],
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
        if (workspace === null) throw new Error("Choose a workspace folder first");
        id = await api.agent.create({
          cwd: workspace,
          providerId: provider.id,
          modelId: provider.models.declared[0]?.id ?? "",
          mode,
        });
        setSessionId(id);
        sessionRef.current = id;
      }
      setDraft("");
      setPhase("turn");
      await api.agent.submit(id, text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("idle");
    }
  }, [draft, sessionId, usable, mode, workspace]);

  const stop = useCallback(() => {
    if (sessionRef.current === null) return;
    void api.agent.abort(sessionRef.current);
  }, []);

  /** 回到首页开新会话：会话在首条消息提交时才真正创建（R8-01 ①）。 */
  const newTask = useCallback(() => {
    setSessionId(null);
    sessionRef.current = null;
    setState(createTranscriptState(seedSnapshot()));
    setApprovals([]);
    setPhase("idle");
    setError(null);
  }, []);

  /** 换工作区：当前会话的 cwd 已经固定，只能开新会话——UI 上说清楚，不让用户以为切了目录对话还跟着走。 */
  const chooseWorkspace = useCallback(async () => {
    const picked = await api.workspace.choose();
    if (picked === null) return;
    setWorkspace(picked);
    if (sessionRef.current !== null) newTask();
  }, [newTask]);

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
    workspace,
    usable,
    send: () => void send(),
    stop,
    chooseWorkspace: () => void chooseWorkspace(),
    newTask,
    answerApproval,
  };
}

/** 本地起点快照：会话由 pi 持有，renderer 只需要一个空壳来启动归约器。 */
function seedSnapshot(): SessionSnapshot {
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
    transcript: [],
    queuedSteer: [],
    queuedSteerCount: 0,
  };
}
