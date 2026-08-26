import { useState } from "react";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { ApprovalBar } from "./ApprovalBar";
import { Composer } from "../../shell/Composer";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { InlineName } from "../../shell/InlineName";
import { IconButton } from "../../shell/IconButton";
import { Icon } from "../../shell/Icon";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from "@shared/permission";
import { deriveSessionTitle } from "@shared/session";
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
      disabled={session.usable.length === 0 || session.readOnly}
      running={session.phase === "turn"}
      bottomSlot={<ComposerBar session={session} />}
    />
  );

  /** 这一屏是哪条会话：活着的优先，否则是打开的那条 */
  const openId = session.sessionId ?? session.opened?.id ?? "";

  const notices = (
    <>
      {session.usable.length === 0 && (
        <Notice>Add a provider with at least one model in Settings, then send a message.</Notice>
      )}
      {session.error !== null && <Notice tone="bad">{session.error}</Notice>}
      {/*
        只能读不能续：pi 没有这条会话的本子。**说清楚，别让输入框看起来能打字**
        （guideline §四把这条代价写明了）。
      */}
      {session.readOnly && (
        <Notice>
          This task was recorded before tasks could be resumed, so it can be read but not
          continued. Start a new task to keep working.
        </Notice>
      )}
    </>
  );

  // 首页 = 既没有活着的会话，也没有打开任何一条旧会话
  if (session.sessionId === null && session.opened === null) {
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
    <Pane
      title={session.opened?.title || (sessionTitle(session.transcript) ?? "New task")}
      badge={openId.slice(0, 6)}
      badgeTitle={openId}
      // 只要这条会话已经落盘就能改名——刚发完第一句正是最想改名的时候
      onRename={openId === "" ? undefined : (title) => session.renameSession(openId, title)}
      footer={
        <>
          {notices}
          {session.approvals[0] && (
            <ApprovalBar approval={session.approvals[0]} onAnswer={session.answerApproval} />
          )}
          {composer}
        </>
      }
    >
      {session.transcript.map((item) => (
        <Item key={item.id} item={item} />
      ))}
      {session.phase === "turn" && <Responding />}
    </Pane>
  );
}

/**
 * 聊天面的骨架：页头 / 可滚动的内容列 / 底部。实时会话与历史会话共用它——
 * 两者只有底部不同（一个是输入卡，一个是「这条不能继续」的说明）。
 */
function Pane(props: {
  title: string;
  badge: string;
  badgeTitle: string;
  /** 有值才出现铅笔——首条消息还没发的会话还没有记录可改 */
  onRename?: ((title: string) => void) | undefined;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
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
        <InlineName
          editing={editing}
          value={props.title}
          onCommit={(value) => {
            setEditing(false);
            props.onRename?.(value);
          }}
          onCancel={() => setEditing(false)}
          style={{
            fontSize: "var(--font-size-title)",
            fontWeight: "var(--weight-bold)",
            height: 30,
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
            {props.title}
          </strong>
        </InlineName>
        {/* 铅笔夹在名字与 id 之间：它属于名字，不属于这条会话的其它动作 */}
        {props.onRename !== undefined && !editing && (
          <IconButton label="Rename task" size={24} onClick={() => setEditing(true)}>
            <Icon name="pencil-line" size={13} />
          </IconButton>
        )}
        <span
          title={props.badgeTitle}
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
          {props.badge}
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
          {props.children}
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
          {props.footer}
        </div>
      </div>
    </div>
  );
}

/**
 * 输入卡底栏：作用域 / 权限档 / 模型——都是「这一句会以什么身份发出去」的事实。
 *
 * 三个都是菜单而不是并排的芯片：权限档摊开是三个、模型摊开是所有 provider 的所有模型，
 * 288px 之外的这条底栏放不下，摊开也把「当前是什么」淹没在选项里。
 * 菜单里当前项用 check 标出来——**状态优先图标与文字**。
 */
function ComposerBar(props: { session: ChatSession }) {
  const { session } = props;
  const workspace = session.workspaces.find((w) => w.id === session.workspaceId);
  const scope = workspace?.name ?? (session.cwd === null ? "Home" : basename(session.cwd));

  const scopeItems: MenuItem[] = [
    {
      id: "home",
      label: "Home",
      icon: "folder",
      hint: session.defaultCwd,
      checked: session.workspaceId === null && session.cwd === null,
      onSelect: session.newTask,
    },
    ...session.workspaces.map((item) => ({
      id: item.id,
      label: item.name,
      icon: "folder" as const,
      checked: session.workspaceId === item.id,
      onSelect: () => session.newTaskIn(item),
    })),
    { id: "add", label: "Add a folder…", icon: "folder-plus", onSelect: session.addWorkspace },
  ];

  const modeItems: MenuItem[] = PERMISSION_MODES.map((value) => ({
    id: value,
    label: PERMISSION_MODE_LABELS[value].label,
    hint: PERMISSION_MODE_LABELS[value].hint,
    checked: session.mode === value,
    onSelect: () => session.changeMode(value),
  }));

  // 所有 provider 的所有已启用模型摊平；provider 名字放在右边当说明
  const modelItems: MenuItem[] = session.usable.flatMap((provider) =>
    provider.models.declared.map((declared) => ({
      id: `${provider.id}:${declared.id}`,
      label: declared.id,
      hint: provider.displayName,
      checked:
        session.model?.providerId === provider.id && session.model.modelId === declared.id,
      onSelect: () => session.chooseModel(provider.id, declared.id),
    })),
  );

  return (
    <>
      <Menu
        items={scopeItems}
        trigger={({ open, toggle }) => (
          <Chip
            icon="folder"
            active={open}
            title={`${session.cwd ?? session.defaultCwd} · switching starts a new task`}
            onClick={toggle}
            chevron
          >
            {scope}
          </Chip>
        )}
      />
      <Menu
        items={modeItems}
        trigger={({ open, toggle }) => (
          <Chip
            icon="shield-check"
            active={open}
            title={PERMISSION_MODE_LABELS[session.mode].hint}
            onClick={toggle}
            chevron
          >
            {PERMISSION_MODE_LABELS[session.mode].label}
          </Chip>
        )}
      />
      {modelItems.length > 0 && (
        <Menu
          items={modelItems}
          trigger={({ open, toggle }) => (
            <Chip
              active={open}
              title="Model · switching starts a new task"
              onClick={toggle}
              chevron
              italic
            >
              {session.model?.modelId ?? "No model"}
            </Chip>
          )}
        />
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

/**
 * 还没落盘那条会话的标题：第一条用户消息的第一行。落盘之后以 `meta.title` 为准。
 * **截断规则走 shared 的 `deriveSessionTitle`**——主进程落盘时用的是同一条，
 * 两边不一致的话同一条会话会在侧栏和标题栏显示两个名字。
 */
function sessionTitle(transcript: readonly TranscriptItem[]): string | null {
  for (const item of transcript) {
    if (item.role !== "user") continue;
    for (const block of item.content) {
      if (block.type !== "text") continue;
      const title = deriveSessionTitle(block.text);
      if (title !== "") return title;
    }
  }
  return null;
}

function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}
