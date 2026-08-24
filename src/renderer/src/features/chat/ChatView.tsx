import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyTranscriptProgress,
  createTranscriptState,
  selectTranscript,
  type TranscriptState,
} from "@earendil-works/pi-coding-agent/client";
import type { SessionSnapshot, TranscriptItem } from "@earendil-works/pi-protocol";
import { api } from "../../api";
import { ApprovalBar, type PendingApproval } from "./ApprovalBar";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS, type PermissionMode } from "@shared/permission";
import type { ProviderDto } from "@shared/provider";

/**
 * 最小对话面：发一句、看到流式回答。
 * transcript 状态由 **pi 自带的归约器**维护，我们不写第二份归约逻辑（guideline §三）。
 * 工具、审批、会话列表分别是后续三刀。
 */
export function ChatView(props: { providers: ProviderDto[] }) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<TranscriptState>(() => createTranscriptState(seedSnapshot()));
  const [phase, setPhase] = useState<"idle" | "turn">("idle");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** 三档权限模式。默认 plan——**默认最保守**，开工具要用户自己往下调。 */
  const [mode, setMode] = useState<PermissionMode>("plan");
  /** 排队中的工具审批。同一时刻可能有多个（并行工具调用），逐个应答。 */
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const sessionRef = useRef<string | null>(null);

  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

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
        if (event.type === "progress") setState((prev) => applyTranscriptProgress(prev, event.progress));
        else setPhase(event.phase === "idle" ? "idle" : "turn");
      }),
    [],
  );

  const usable = useMemo(
    () => props.providers.filter((p) => p.models.declared.length > 0),
    [props.providers],
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
        id = await api.agent.create({
          cwd: ".",
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
  }, [draft, sessionId, usable, mode]);

  const changeMode = (next: PermissionMode) => {
    setMode(next);
    if (sessionId !== null) void api.agent.setMode(sessionId, next);
  };

  const answerApproval = (requestId: string, answer: Parameters<typeof api.agent.answerPermission>[1]) => {
    setApprovals((prev) => prev.filter((a) => a.requestId !== requestId));
    void api.agent.answerPermission(requestId, answer);
  };

  const transcript = selectTranscript(state);

  return (
    <section style={{ display: "grid", gap: "var(--space-5)", width: "100%", maxWidth: 640 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-3)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--font-size-heading)", fontWeight: 600 }}>Chat</h2>
        <span style={{ marginInlineStart: "auto", display: "flex", gap: "var(--space-1)" }}>
          {PERMISSION_MODES.map((value) => {
            const active = mode === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => changeMode(value)}
                title={PERMISSION_MODE_LABELS[value].hint}
                style={{
                  height: "var(--control-height-sm)",
                  padding: "0 var(--space-3)",
                  // 模式选中用 mode-active token（设计系统：模式选择与主操作共用 accent 色相）
                  background: active ? "var(--color-mode-active-bg)" : "transparent",
                  color: active ? "var(--color-mode-active-fg)" : "var(--color-text-secondary)",
                  border: `1px solid ${active ? "var(--color-mode-active-fg)" : "var(--color-border-default)"}`,
                  borderRadius: "var(--radius-md)",
                  font: "inherit",
                  fontSize: "var(--font-size-caption)",
                  cursor: "pointer",
                  transition: "var(--transition-hover)",
                }}
              >
                {PERMISSION_MODE_LABELS[value].label}
              </button>
            );
          })}
        </span>
      </div>

      {usable.length === 0 && (
        <p style={{ margin: 0, fontSize: "var(--font-size-control)", color: "var(--color-text-tertiary)" }}>
          Add a provider with at least one model below, then send a message.
        </p>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "var(--font-size-control)", color: "var(--color-danger)" }}>
          {error}
        </p>
      )}

      <div style={{ display: "grid", gap: "var(--space-3)" }}>
        {transcript.map((item) => (
          <Item key={item.id} item={item} />
        ))}
        {phase === "turn" && transcript.at(-1)?.role !== "assistant" && (
          <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
            Thinking…
          </span>
        )}
      </div>

      {approvals[0] && <ApprovalBar approval={approvals[0]} onAnswer={answerApproval} />}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
        style={{ display: "flex", gap: "var(--space-2)" }}
      >
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Ask anything"
          disabled={usable.length === 0}
          style={{
            flex: 1,
            height: "var(--control-height-lg)",
            padding: "0 var(--space-4)",
            background: "var(--color-bg-panel)",
            color: "var(--color-text-primary)",
            border: "1px solid var(--color-border-default)",
            borderRadius: "var(--radius-composer)",
            font: "inherit",
            fontSize: "var(--font-size-input)",
          }}
        />
        <button
          type="submit"
          disabled={usable.length === 0 || draft.trim() === ""}
          style={{
            height: "var(--control-height-lg)",
            padding: "0 var(--space-5)",
            background: "var(--color-accent)",
            color: "var(--color-accent-fg)",
            border: "1px solid var(--color-accent)",
            borderRadius: "var(--radius-md)",
            font: "inherit",
            fontSize: "var(--font-size-control)",
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </form>
    </section>
  );
}

/** 一条 transcript item。content 是块数组——按块渲染，不压扁（这正是换协议的目的）。 */
function Item(props: { item: TranscriptItem }) {
  const isUser = props.item.role === "user";
  return (
    <article
      style={{
        display: "grid",
        gap: "var(--space-1)",
        padding: "var(--space-3) var(--space-4)",
        background: isUser ? "var(--color-bg-muted)" : "var(--color-bg-panel)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-bubble)",
        justifySelf: isUser ? "end" : "stretch",
        maxWidth: isUser ? "min(82%, 64ch)" : undefined,
      }}
    >
      {props.item.content.map((block, index) => {
        if (block.type === "text") {
          return (
            <p key={index} style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: "var(--line-height-chat)" }}>
              {block.text}
            </p>
          );
        }
        if (block.type === "thinking") {
          return (
            <p
              key={index}
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                fontSize: "var(--font-size-caption)",
                color: "var(--color-text-tertiary)",
              }}
            >
              {block.thinking}
            </p>
          );
        }
        if (block.type === "toolCall") {
          return (
            <code
              key={index}
              style={{ fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-micro)" }}
            >
              {block.toolName}
            </code>
          );
        }
        return null;
      })}
    </article>
  );
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
