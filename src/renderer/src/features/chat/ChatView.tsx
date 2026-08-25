import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { ApprovalBar } from "./ApprovalBar";
import { Composer, Chip } from "../../shell/Composer";
import { Icon } from "../../shell/Icon";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from "@shared/permission";
import type { ChatSession } from "./useChatSession";

/**
 * 中卡的内容：首页与聊天页。
 *
 * 两页共用同一个 `Composer`，宽度都是 `min(100%, var(--content-max-width))`——
 * 这就是 R8-01 ②「输入框宽度跨页面保持一致」：两页的差别只有 slogan 消失、
 * 输入框从居中落到底部，别的都不动。
 */
export function ChatView(props: { session: ChatSession }) {
  const { session } = props;
  const composer = (
    <Composer
      value={session.draft}
      onChange={session.setDraft}
      onSubmit={session.send}
      onStop={session.stop}
      placeholder={
        session.sessionId === null ? "Ask anything, or start a task" : "Reply, or steer the agent"
      }
      disabled={session.usable.length === 0}
      running={session.phase === "turn"}
      bottomSlot={<ComposerBar session={session} />}
    />
  );

  const notices = (
    <>
      {session.usable.length === 0 && (
        <Notice>Add a provider with at least one model in Settings, then send a message.</Notice>
      )}
      {session.error !== null && <Notice tone="bad">{session.error}</Notice>}
    </>
  );

  if (session.sessionId === null) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-5)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: "min(100%, var(--content-max-width))",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--space-5)",
          }}
        >
          {/* 全产品唯一一句抒情的话，也是唯一保持中文的界面文案 */}
          <h1
            style={{
              margin: "0 0 var(--space-1)",
              fontFamily: "var(--font-family-brand)",
              fontSize: "var(--font-size-logo)",
              fontWeight: 600,
              letterSpacing: "var(--tracking-slogan)",
              textAlign: "center",
            }}
          >
            璇玑运转，诸事得序
          </h1>
          <div style={{ width: "100%", display: "grid", gap: "var(--space-2)" }}>
            {notices}
            {composer}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        minHeight: 0,
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr) auto",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          height: 30,
          padding: "12px 18px",
          boxSizing: "content-box",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <strong
          style={{
            minWidth: 0,
            fontSize: "var(--font-size-title)",
            fontWeight: "var(--weight-bold)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {sessionTitle(session.transcript) ?? "New task"}
        </strong>
        <span
          title={session.sessionId}
          style={{
            flex: "0 0 auto",
            padding: "2px 8px",
            borderRadius: "var(--radius-md)",
            background: "var(--color-bg-muted)",
            color: "var(--color-text-secondary)",
            fontFamily: "var(--font-family-business)",
            fontSize: "var(--font-size-micro)",
            fontWeight: "var(--weight-semibold)",
          }}
        >
          {session.sessionId.slice(0, 6)}
        </span>
      </header>

      <div className="scroll" style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
        <div
          style={{
            width: "min(100%, var(--content-max-width))",
            margin: "0 auto",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          {session.transcript.map((item) => (
            <Item key={item.id} item={item} />
          ))}
          {session.phase === "turn" && <Responding />}
        </div>
      </div>

      <div style={{ padding: "var(--space-1) var(--space-5) 10px" }}>
        <div
          style={{
            width: "min(100%, var(--content-max-width))",
            margin: "0 auto",
            display: "grid",
            gap: "var(--space-2)",
          }}
        >
          {notices}
          {session.approvals[0] && (
            <ApprovalBar approval={session.approvals[0]} onAnswer={session.answerApproval} />
          )}
          {composer}
        </div>
      </div>
    </div>
  );
}

/** composer 底栏：作用域 / 权限 / 模型——都是「这一句会以什么身份发出去」的事实 */
function ComposerBar(props: { session: ChatSession }) {
  const { session } = props;
  const model = session.usable[0]?.models.declared[0]?.id;
  return (
    <>
      <Chip
        icon="folder"
        title={session.workspace ?? "Choose a workspace folder"}
        onClick={session.chooseWorkspace}
      >
        {session.workspace === null ? "Choose folder" : basename(session.workspace)}
      </Chip>
      <span
        title="Tool permission"
        style={{ display: "inline-flex", color: "var(--color-text-tertiary)", marginInlineStart: 2 }}
      >
        <Icon name="shield-check" size={12} />
      </span>
      {PERMISSION_MODES.map((value) => (
        <Chip
          key={value}
          active={session.mode === value}
          title={PERMISSION_MODE_LABELS[value].hint}
          onClick={() => session.changeMode(value)}
        >
          {PERMISSION_MODE_LABELS[value].label}
        </Chip>
      ))}
      {model !== undefined && (
        <span
          style={{
            marginInlineStart: "var(--space-2)",
            fontStyle: "italic",
            fontSize: "var(--font-size-control)",
            letterSpacing: "var(--tracking-model)",
            color: "var(--color-text-secondary)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {model}
        </span>
      )}
    </>
  );
}

/**
 * 一条 transcript item。content 是块数组——按块渲染，不压扁（这正是换协议的目的）。
 * 用户指令走独立气泡、agent 输出走全宽文档式（R4-05 hybrid）。
 */
function Item(props: { item: TranscriptItem }) {
  if (props.item.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", width: "100%" }}>
        <div
          style={{
            width: "fit-content",
            maxWidth: "var(--bubble-max-width)",
            minWidth: 0,
            padding: "9px 13px",
            background: "var(--color-chat-card-bg)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-bubble)",
            fontSize: "var(--font-size-chat)",
            lineHeight: "var(--line-height-bubble)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {props.item.content.map((block, index) =>
            block.type === "text" ? <span key={index}>{block.text}</span> : null,
          )}
        </div>
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: "var(--space-2)", width: "100%", minWidth: 0 }}>
      {props.item.content.map((block, index) => {
        if (block.type === "text") {
          return (
            <p
              key={index}
              style={{
                margin: 0,
                fontSize: "var(--font-size-chat)",
                lineHeight: "var(--line-height-chat)",
                whiteSpace: "pre-wrap",
                textWrap: "pretty",
              }}
            >
              {block.text}
            </p>
          );
        }
        // 思考与工具都是「过程」，默认只占一行——简洁为默认，细节可展开是下一刀
        if (block.type === "thinking") {
          return (
            <ProcessLine key={index} icon="brain" tone="var(--color-info)">
              {block.thinking.trim().split("\n")[0] ?? "Thinking"}
            </ProcessLine>
          );
        }
        if (block.type === "toolCall") {
          return (
            <ProcessLine key={index} icon="wrench" tone="var(--color-text-tertiary)" mono>
              {block.toolName}
            </ProcessLine>
          );
        }
        return null;
      })}
    </div>
  );
}

/** 过程行：图标 + 一行文字，坐在聊天面上，无填充无描边（设计系统 *Cards*） */
function ProcessLine(props: {
  icon: "brain" | "wrench";
  tone: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <p
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: 0,
        minWidth: 0,
        color: "var(--color-text-secondary)",
        fontFamily: props.mono === true ? "var(--font-family-business)" : "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
      }}
    >
      <span style={{ display: "inline-flex", flex: "0 0 auto", color: props.tone }}>
        <Icon name={props.icon} size={13} strokeWidth={1.8} />
      </span>
      <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {props.children}
      </span>
    </p>
  );
}

function Responding() {
  return (
    <p
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "fit-content",
        margin: 0,
        color: "var(--color-text-secondary)",
        fontSize: "var(--font-size-control)",
      }}
    >
      <span style={{ display: "inline-flex", color: "var(--color-warning)" }}>
        <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
      </span>
      Responding
    </p>
  );
}

/** 提示行：文字是主信号，颜色是第二信号 */
function Notice(props: { tone?: "bad"; children: React.ReactNode }) {
  return (
    <p
      role={props.tone === "bad" ? "alert" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: 0,
        padding: "0 var(--space-2)",
        color: props.tone === "bad" ? "var(--color-danger)" : "var(--color-text-secondary)",
        fontSize: "var(--font-size-control)",
      }}
    >
      {props.tone === "bad" && (
        <span style={{ display: "inline-flex", flex: "0 0 auto" }}>
          <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
        </span>
      )}
      {props.children}
    </p>
  );
}

/** 会话标题：第一条用户消息的第一行。会话存储落地后由 auto-titler 接管。 */
export function sessionTitle(transcript: readonly TranscriptItem[]): string | null {
  for (const item of transcript) {
    if (item.role !== "user") continue;
    for (const block of item.content) {
      if (block.type !== "text") continue;
      const line = block.text.trim().split("\n")[0]?.trim();
      if (line !== undefined && line !== "") return line.length > 60 ? `${line.slice(0, 60)}…` : line;
    }
  }
  return null;
}

/** 复制整条对话（右图标条的动作）。按块拼，保留块级顺序。 */
export function transcriptToText(transcript: readonly TranscriptItem[]): string {
  return transcript
    .map((item) => {
      const body = item.content
        .map((block) => {
          if (block.type === "text") return block.text;
          if (block.type === "thinking") return `[thinking] ${block.thinking}`;
          if (block.type === "toolCall") return `[tool] ${block.toolName}`;
          return "";
        })
        .filter((part) => part !== "")
        .join("\n");
      return `${item.role}:\n${body}`;
    })
    .join("\n\n");
}

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}
