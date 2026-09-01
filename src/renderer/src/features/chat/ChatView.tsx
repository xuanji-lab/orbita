import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { SessionStats } from "@earendil-works/pi-coding-agent";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { ApprovalBar } from "./ApprovalBar";
import { QueueStrip } from "./QueueStrip";
import { compactionBoundaryText, mergeCompactions } from "./session-states";
import { isAtBottom } from "./scroll";
import {
  editDiffText,
  fileViewFor,
  flattenRenderUnits,
  groupToolUnits,
  indexToolResults,
  liveTailLines,
  parseEditDiff,
  editDiffEntries,
  parseGrepLine,
  splitPathTail,
  streamingThinkingKey,
  summarizeToolResult,
  editDiffStats,
  editGroupFileCount,
  thinkingDurationText,
  thinkingPreview,
  toolCallSummary,
  toolDurationText,
  toolExpandable,
  toolGroupStatus,
  toolResultText,
  writeLineCount,
  type IntraToken,
  type RenderEntry,
  type ToolGroupUnit,
  type ToolResultIndex,
} from "./tool-results";
import { highlighterReady, highlightLines, langFromPath, type TokenSpan } from "./highlight";
import { Composer } from "../../shell/Composer";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { InlineName } from "../../shell/InlineName";
import { IconButton } from "../../shell/IconButton";
import { Icon, type IconName } from "../../shell/Icon";
import { MarkdownBlock } from "./MarkdownBlock";
import { contextText, contextTone, costText, statsTitleText } from "./stats-text";
import { retryCauseText, retryLineText } from "./retry-text";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS } from "@shared/permission";
import { deriveSessionTitle, type CompactedRecord } from "@shared/session";
import type { RetryStatus } from "@shared/agent-ipc";
import type { ChatSession } from "./useChatSession";

/**
 * 展开体的贴底跟随：chat 级滚动（上方 ChatView）同款语义的缩小版——内容增长
 * 钉住底部，用户上滚脱离即停跟，滚回底部自动恢复。`enabled` 只在活体上开
 * （流式思考、跑着的 shell）；静态内容没有「跟随」可言，展开从顶部开始读，
 * 用户滚到哪就停在哪。跟 chat 级一样用 ref 不用 state：滚动是高频事件，
 * 不值得为它重渲染。
 */
function useFollowScroll(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el !== null) {
      followRef.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    }
  };
  // 无依赖数组：不挑触发源，每次 commit 都尝试钉底（scrollTop 赋值廉价），绘制前同步执行
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && enabled && followRef.current) el.scrollTop = el.scrollHeight;
  });
  return { ref, onScroll };
}

/**
 * 中卡的内容：首页与聊天页。
 *
 * 两页共用同一个 `Composer`，宽度都是 `min(100%, var(--content-max-width))`——
 * 这就是 R8-01 ②「输入框宽度跨页面保持一致」：两页的差别只有 slogan 消失、
 * 输入框从居中落到底部，别的都不动。
 */
export function ChatView(props: { session: ChatSession }) {
  const { session } = props;

  // 跟随态（pi 的 followingEnd 语义）：贴底时内容增长钉住底部；用户上滚脱离，滚回底部恢复。
  // 用 ref 不用 state——没有 UI 依赖它，不值得为每次滚动触发重渲染。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);

  /** 用户滚动（滚轮/键盘/滚动条都一样）后重判是否在底部；程序化钉底触发的事件判真，不打架 */
  const handleScroll = () => {
    const el = scrollRef.current;
    if (el !== null) {
      followRef.current = isAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight);
    }
  };

  // 每次 commit 后钉底：不挑触发源——流式输出、忙碌指示出现、折叠展开全兜住；scrollTop 赋值廉价。
  // 绘制前同步执行，用户看不到先长高再滚下去的闪动。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
  });

  /** 这一屏是哪条会话：活着的优先，否则是打开的那条 */
  const openId = session.sessionId ?? session.opened?.id ?? "";

  // 打开/切换会话无条件跳到底并恢复跟随：后台会话的事件一直进自己的槽，切回时转录已是最新
  useLayoutEffect(() => {
    followRef.current = true;
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [openId]);

  const composer = (
    <Composer
      value={session.draft}
      onChange={session.setDraft}
      // 发送即恢复跟随：翻着历史发消息，新对话永远长在底部
      onSubmit={() => {
        followRef.current = true;
        session.send();
      }}
      onStop={session.stop}
      placeholder={
        session.sessionId === null ? "Ask anything, or start a task" : "Reply, or steer the agent"
      }
      disabled={session.usable.length === 0 || session.readOnly}
      running={session.phase !== "idle"}
      bottomSlot={<ComposerBar session={session} />}
    />
  );

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

  // 工具结果不单独占一行——先建索引，渲染工具调用那一行时挂上去（见 tool-results.ts）
  const toolResults = indexToolResults(session.transcript);
  // 界碑按发生位置插回往来流：压缩摘要收进「已压缩」折叠行，历史一条不少
  const records = mergeCompactions(session.compactions, session.transcript);
  // 摊平 → 相邻同类合并：渲染从「按条」改成「按单元」，连续同类工具收成一行组
  const entries = groupToolUnits(flattenRenderUnits(records));
  // 流式中的思考块（行首呼吸的判定）：本轮未结束且它是流式 assistant 消息的最后一块
  const activeThinkingKey = streamingThinkingKey(records, session.phase === "turn");
  // 组行的展开是时间态：活跃轮里铺开，整轮落定一次性收纳（见 ToolGroupLine）
  const turnActive = session.phase === "turn";

  return (
    <Pane
      title={session.opened?.title || (sessionTitle(session.transcript) ?? "New task")}
      badge={openId.slice(0, 6)}
      badgeTitle={openId}
      scrollRef={scrollRef}
      onScroll={handleScroll}
      // 只要这条会话已经落盘就能改名——刚发完第一句正是最想改名的时候
      onRename={openId === "" ? undefined : (title) => session.renameSession(openId, title)}
      footer={
        <>
          {notices}
          {session.approvals[0] && (
            <ApprovalBar approval={session.approvals[0]} onAnswer={session.answerApproval} />
          )}
          {/* 排队卡片：比 composer 高一层（等待发出的事），比审批低一层（审批要求回答才继续） */}
          <QueueStrip
            view={session.queueView}
            phase={session.phase}
            onPromote={session.promoteQueued}
            onCancel={session.cancelQueued}
            onEdit={session.editQueued}
            onCancelPending={session.cancelPendingSend}
            onEditPending={session.editPendingSend}
            onRunPendingNow={session.runPendingNow}
          />
          {composer}
        </>
      }
    >
      {entries.map((entry) => (
        <EntryView
          key={entry.key}
          entry={entry}
          toolResults={toolResults}
          activeThinkingKey={activeThinkingKey}
          turnActive={turnActive}
        />
      ))}
      {session.phase === "turn" &&
        (session.retry !== null ? <Retrying status={session.retry} /> : <Responding />)}
      {session.phase === "compaction" && (
        <>
          <Compacting />
          {session.retry !== null && (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Retrying status={session.retry} />
            </div>
          )}
        </>
      )}
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
  /** 消息列的滚动容器：跟随/跳底逻辑在 ChatView，骨架只交出节点 */
  scrollRef?: React.Ref<HTMLDivElement>;
  onScroll?: (() => void) | undefined;
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

      <div
        ref={props.scrollRef}
        onScroll={props.onScroll}
        className="scroll"
        style={{ minHeight: 0, padding: "var(--space-6) var(--space-5)" }}
      >
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
      <StatsLine stats={session.stats} />
    </>
  );
}

/**
 * 用量行：底栏最右侧的安静注脚——上下文余量 + 累计花费，hover（原生 title）看
 * token 分项。上下文段 >70% 染 warning、>90% 染 danger（颜色第二信号）；刚压缩完
 * 显示 `? / 200k`（诚实未知）。花费 ≤0 不显示——自建网关定价未知，$0.000 会误读为免费。
 *
 * 布局：外层撑满剩余空间、内容右贴——不能用 marginInlineStart:auto，发送键已经
 * 用了一个，两个 auto 会平分剩余空间把用量行推到中间去。
 */
function StatsLine(props: { stats: SessionStats | null }) {
  const { stats } = props;
  if (stats === null) return null;
  const cost = costText(stats.cost);
  const usage = stats.contextUsage;
  if (usage === undefined && cost === null) return null;
  const tone = contextTone(usage?.percent ?? null);
  const toneColor =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warning"
        ? "var(--color-warning)"
        : undefined;
  return (
    <span
      style={{
        flex: "1 1 auto",
        minWidth: 0,
        display: "flex",
        justifyContent: "flex-end",
      }}
    >
      <span
        title={statsTitleText(stats)}
        style={{ ...SLOT.status, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {usage !== undefined && (
          <span style={toneColor === undefined ? undefined : { color: toneColor }}>
            {contextText(usage)}
          </span>
        )}
        {cost !== null && (usage !== undefined ? ` · ${cost}` : cost)}
      </span>
    </span>
  );
}

/**
 * 一个渲染单元：摊平后每单元独立占一行——用户气泡、正文、思考行、工具行/组、界碑行。
 * 单元间距由外层内容列统一（16px）——设计系统：chat 内卡片之间由 16px 空白分隔。
 */
function EntryView(props: {
  entry: RenderEntry;
  toolResults: ToolResultIndex;
  activeThinkingKey: string | null;
  turnActive: boolean;
}) {
  const { entry } = props;
  if (entry.kind === "compacted") return <CompactedLine record={entry.record} />;
  if (entry.kind === "user") return <UserBubble item={entry.item} />;
  if (entry.kind === "text") return <MarkdownBlock text={entry.text} />;
  if (entry.kind === "thinking") {
    return (
      <ThinkingLine text={entry.text} active={entry.key === props.activeThinkingKey} blockKey={entry.key} />
    );
  }
  if (entry.kind === "toolCall") {
    return (
      <ToolLine
        toolCallId={entry.toolCallId}
        toolName={entry.toolName}
        input={entry.input}
        result={props.toolResults.get(entry.toolCallId)}
      />
    );
  }
  return <ToolGroupLine group={entry} toolResults={props.toolResults} turnActive={props.turnActive} />;
}

/** 用户消息：右对齐的独立气泡；只有 text 块进气泡。 */
function UserBubble(props: { item: Extract<TranscriptItem, { role: "user" }> }) {
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

/**
 * 折叠行共用骨架（设计系统 ToolCard / ThinkingCard）：满宽热区、hover 淡底、
 * 圆角裁边。行首（图标+label）是「状态」本体，副标是注脚（tertiary mono），
 * 状态词是机器事实（micro mono 等宽数字）。
 */
function CollapseRow(props: {
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const interactive = props.disabled !== true;
  return (
    <div style={{ minWidth: 0, borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
      <button
        type="button"
        aria-expanded={interactive ? props.open : undefined}
        disabled={!interactive}
        onClick={props.onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          width: "100%",
          minHeight: 32,
          padding: "6px 10px",
          border: "none",
          background: hover && interactive
            ? "color-mix(in srgb, var(--color-bg-hover) 50%, transparent)"
            : "transparent",
          transition: "var(--transition-hover)",
          color: "var(--color-text-secondary)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-control)",
          lineHeight: "var(--line-height-control)",
          textAlign: "left",
          cursor: interactive ? "pointer" : "default",
        }}
      >
        {props.children}
      </button>
    </div>
  );
}

const SLOT = {
  /** 副标不占满整行（flex 0 1 auto）：状态词紧跟其后，行不被拉长 */
  sub: {
    flex: "0 1 auto",
    minWidth: 0,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    color: "var(--color-text-tertiary)",
    fontFamily: "var(--font-family-mono)",
    fontSize: "var(--font-size-caption)",
  },
  status: {
    flex: "0 0 auto",
    color: "var(--color-text-tertiary)",
    fontFamily: "var(--font-family-business)",
    fontSize: "var(--font-size-micro)",
    fontVariantNumeric: "tabular-nums",
  },
} satisfies Record<string, React.CSSProperties>;

/**
 * 行首 label 的亮度是**时间态**：进行中 secondary 半粗（比正文暗一档，全场唯一在动），
 * 状态落定整行退到 tertiary——完成的都是过去时，行与行不再争层次。
 * 失败红是语义色，不参与档位，由调用方另行覆盖。
 */
function headLabel(active: boolean): React.CSSProperties {
  return {
    flex: "0 0 auto",
    fontWeight: "var(--weight-strong)",
    fontSize: "var(--font-size-body)",
    color: active ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
  };
}

/** 行首图标同 label 的时间态；思考的 brain 进行中保持 info 蓝（全转写唯一蓝记号）。 */
function headIconColor(active: boolean): string {
  return active ? "var(--color-text-secondary)" : "var(--color-text-tertiary)";
}

/** 呼吸只包行首（图标+label）——副标和状态词不跟着呼吸，它们不是状态。 */
const HEAD_WRAP = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: "0 0 auto",
} satisfies React.CSSProperties;

/** 展开体共用形态：细分隔线接在折叠行下、无底色、mono caption——chat 内卡片无框无填充。 */
const EXPANDED_BODY = {
  margin: 0,
  padding: "var(--space-2)",
  maxHeight: 320,
  overflow: "auto",
  borderTop: "1px solid var(--color-border-subtle)",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-caption)",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} satisfies React.CSSProperties;

/** 工具的类型图标：图标只说「哪一类事」，具体哪个工具由旁边的名字说。 */
function toolIcon(toolName: string): IconName {
  switch (toolName) {
    case "bash":
    case "powershell":
      return "terminal";
    case "read":
      return "file-text";
    case "write":
    case "edit":
      return "pencil-line";
    case "grep":
    case "find":
      return "search";
    case "ls":
      return "folder";
    default:
      return "wrench";
  }
}

/** 组行的动词标签：一行里 N 件同类事，说类别不说工具名；不认识的用回工具名。 */
function toolGroupLabel(toolName: string): string {
  switch (toolName) {
    case "bash":
    case "powershell":
      return "执行";
    case "read":
      return "读取";
    case "grep":
    case "find":
      return "搜索";
    case "write":
      return "写入";
    case "edit":
      return "修改";
    case "ls":
      return "浏览";
    default:
      return toolName;
  }
}

/** 组头折叠态的量词——跟着动词说量级：「读取 3 个文件 / 执行 3 条命令」。 */
function toolGroupCountLabel(toolName: string, count: number): string {
  switch (toolName) {
    case "read":
    case "write":
      return `${count} 个文件`;
    case "bash":
    case "powershell":
      return `${count} 条命令`;
    case "edit":
      return `${count} 处`;
    case "ls":
      return `${count} 个目录`;
    default:
      return `${count} 次`;
  }
}

/**
 * 工具调用行：折叠时一行（行首 + 参数摘要 + 状态词），点开看结果——edit 展开是
 * 带行号的 diff，其余是原文。**进行中：行首（图标+工具名）secondary + 呼吸**——
 * 呼吸即状态，不转圈；跑着的 shell 可展开看实时输出（贴底跟随），其余工具
 * 跑完才能展开。状态落定呼吸与高亮一起消失，整行退到 tertiary。
 * 失败是语义色不参与档位：`triangle-alert` + "failed" 染 danger（AGENTS.md：
 * 状态优先图标与文字，颜色是第二信号）。
 */
function ToolLine(props: {
  toolCallId: string;
  toolName: string;
  input: unknown;
  result: ToolTranscriptItem | undefined;
}) {
  const [open, setOpen] = useState(false);
  const { result } = props;
  const failed = result?.status === "error";
  const active = result === undefined || result.status === "running";
  const summary = summarizeToolResult(result);
  const callSummary = toolCallSummary(props.toolName, props.input);
  // 跑着的 shell 有实时增量可展，其余工具跑完才有完整结果（见 toolExpandable）
  const expandable = toolExpandable(result, props.toolName);
  const live = expandable && active;
  const finished = result !== undefined && result.status !== "running";
  const diff = finished ? editDiffText(result) : null;
  const stats = finished ? editDiffStats(result) : null;
  const rawBody = result !== undefined ? toolResultText(result) : "";
  // 跑着时只渲染尾部：partial 是累积快照、每帧整条重渲染，万行输出会拖垮 DOM
  const body = live ? liveTailLines(rawBody) : rawBody;
  // write 的正文在入参不在结果（pi 同款：结果只有一行统计），展开走文件内容视图
  const fileView = finished ? fileViewFor(props.toolName, props.input, result) : null;
  const fileLang =
    fileView !== null ? langFromPath(toolCallSummary(props.toolName, props.input) ?? "") : null;
  const writeLines =
    !open && props.toolName === "write" && fileView !== null ? writeLineCount(props.input) : null;
  // 只有 shell 类值得看耗时（read/edit 毫秒级是噪音）；旧会话没见过 running 帧，量不到就没有
  const shellDuration =
    (props.toolName === "bash" || props.toolName === "powershell") && !active
      ? toolDurationText(props.toolCallId)
      : null;

  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} disabled={!expandable} onToggle={() => setOpen((value) => !value)}>
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span style={{ color: failed ? "var(--color-danger)" : headIconColor(active) }}>
            <Icon
              name={failed ? "triangle-alert" : toolIcon(props.toolName)}
              size={14}
              strokeWidth={1.8}
            />
          </span>
          <span style={headLabel(active)}>{props.toolName}</span>
        </span>
        {callSummary !== null && <span style={SLOT.sub}>{callSummary}</span>}
        {/* 增删统计紧跟文件名（git stat 读法）；与展开后 DiffView 头重复，展开时藏起 */}
        {!open && stats !== null && (
          <span style={SLOT.status}>
            <span style={{ color: "var(--color-success)" }}>+{stats.added}</span>{" "}
            <span style={{ color: "var(--color-danger)" }}>-{stats.removed}</span>
          </span>
        )}
        {/* write 的量词是行数（无增删语义，不染色）；有了它「N chars」是统计句的长度，让位 */}
        {!open && stats === null && writeLines !== null && (
          <span style={SLOT.status}>{writeLines} 行</span>
        )}
        {/* 有统计时「N lines」是同一量级的第二遍，让位 */}
        {summary !== null && !active && stats === null && writeLines === null && (
          <span
            style={failed ? { ...SLOT.status, color: "var(--color-danger)" } : SLOT.status}
          >
            {summary}
          </span>
        )}
        {/* shell 类的执行耗时——慢命令（install / typecheck）不展开也讲清楚花在哪 */}
        {shellDuration !== null && <span style={SLOT.status}>{shellDuration}</span>}
      </CollapseRow>
      {open && expandable && diff !== null && <DiffView diff={diff} />}
      {open && expandable && diff === null && fileView !== null && (
        <FileContentView text={fileView.text} startLine={fileView.startLine} lang={fileLang} />
      )}
      {open && expandable && diff === null && fileView === null && (
        <PlainToolBody toolName={props.toolName} text={body} failed={failed} live={live} />
      )}
    </div>
  );
}

/**
 * 同类工具的组：agent 连续做同类事（连读 N 个文件）时，组头「读取」声明在做什么。
 * **展开是时间态**：活跃期间成员常驻铺开（用户正看着的东西不能在眼前消失）；
 * 整轮落定**一次性收纳全部组**——无记忆（Q17b），手动展开的也折，用户可再点开。
 * 折叠态组头带 `× N`（成员可见时不显示）；组内有失败时组头换红色 triangle-alert
 * ——折了也不能让失败无声消失。组头亮暗呼吸跟随成员：任一还在跑 → 行首
 * secondary + 呼吸；**全部落定**才退到 tertiary。
 */
function ToolGroupLine(props: {
  group: ToolGroupUnit;
  toolResults: ToolResultIndex;
  turnActive: boolean;
}) {
  const { group } = props;
  // 挂载时的相态决定初始展开：活跃轮里长出来的组铺开，idle 会话（旧历史）收着
  const [open, setOpen] = useState(props.turnActive);
  useEffect(() => {
    if (!props.turnActive) setOpen(false);
  }, [props.turnActive]);

  const status = toolGroupStatus(group.calls, props.toolResults);
  const active = status.running > 0;
  const failed = status.failed > 0;
  const fileCount = group.toolName === "edit" ? editGroupFileCount(group.calls, props.toolResults) : null;
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span style={{ color: failed ? "var(--color-danger)" : headIconColor(active) }}>
            <Icon
              name={failed ? "triangle-alert" : toolIcon(group.toolName)}
              size={14}
              strokeWidth={1.8}
            />
          </span>
          <span style={headLabel(active)}>{toolGroupLabel(group.toolName)}</span>
        </span>
        {!open && <span style={SLOT.status}>{toolGroupCountLabel(group.toolName, status.total)}</span>}
        {!open && group.toolName === "edit" && fileCount !== null && (
          <span style={SLOT.status}>{fileCount} 个文件</span>
        )}
        {!open && failed && (
          <span style={{ ...SLOT.status, color: "var(--color-danger)" }}>{status.failed} 失败</span>
        )}
      </CollapseRow>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-1)", paddingLeft: "var(--space-2)" }}>
          {group.calls.map((call) => (
            <ToolLine
              key={call.key}
              toolCallId={call.toolCallId}
              toolName={call.toolName}
              input={call.input}
              result={props.toolResults.get(call.toolCallId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * edit 的展开体：pi 的 details.diff 显示格式（VSCode 式两列：行号 | 正文）。
 * 增/上下文行带**新文档（当前文档）行号**、删行带旧文档行号；没有文件头、@@ 头
 * 与 `\ No newline` 噪音（文件名折叠行已经在说），长文件跳段是「...」行。
 * 增删的信号是**整行底色**（-soft token），没有 +/- 标记列——底色说了的事不重复说；
 * 相邻的「1 删 + 1 增」是单行修改，词级对比后真正变动的片段加实底色块
 * （pi TUI 的 inverse 在 DOM 里的等价物）。
 */
function DiffView(props: { diff: string }) {
  const entries = editDiffEntries(parseEditDiff(props.diff));
  return (
    <div
      className="scroll"
      style={{
        maxHeight: 320,
        overflow: "auto",
        borderTop: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-caption)",
        lineHeight: 1.6,
      }}
    >
      {entries.map((entry, index) =>
        entry.kind === "pair" ? (
          <Fragment key={index}>
            <DiffRow kind="del" lineNum={entry.removed.lineNum}>
              {intraSpans(entry.tokens.removed, "del")}
            </DiffRow>
            <DiffRow kind="add" lineNum={entry.added.lineNum}>
              {intraSpans(entry.tokens.added, "add")}
            </DiffRow>
          </Fragment>
        ) : (
          <DiffRow key={index} kind={entry.row.kind} lineNum={entry.row.lineNum}>
            {entry.row.text === "" ? " " : entry.row.text}
          </DiffRow>
        ),
      )}
    </div>
  );
}

/** 行号列（DiffView 与 FileContentView 共用）：右对齐等宽数字、细分隔线、褪色——只作定位不作内容 */
const LINE_NUM_COLUMN = {
  textAlign: "right",
  padding: "0 var(--space-2) 0 var(--space-1)",
  borderRight: "1px solid var(--color-border-subtle)",
  color: "var(--color-text-tertiary)",
  opacity: 0.7,
  fontVariantNumeric: "tabular-nums",
} satisfies React.CSSProperties;

/** diff 行两列 grid：行号（gutter——细分隔线 + 最低调的褪色，只作定位不作内容）| 正文。
 * 深浅三级：改动行正文 primary（第一眼）> 上下文正文 secondary > 行号（tertiary 再降
 * 不透明度）；增删整行淡底色 */
function DiffRow(props: { kind: "add" | "del" | "ctx"; lineNum: string; children: ReactNode }) {
  const { kind } = props;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "4ch 1fr",
        background:
          kind === "add"
            ? "var(--color-success-soft)"
            : kind === "del"
              ? "var(--color-danger-soft)"
              : undefined,
      }}
    >
      <span style={LINE_NUM_COLUMN}>{props.lineNum}</span>
      <span
        style={{
          padding: "0 var(--space-2) 0 var(--space-2)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: kind === "ctx" ? "var(--color-text-secondary)" : "var(--color-text-primary)",
        }}
      >
        {props.children}
      </span>
    </div>
  );
}

/** 词级对比 token → span；changed 片段按角色加底（pi inverse 的 DOM 等价物） */
function intraSpans(tokens: readonly IntraToken[], kind: "del" | "add") {
  return tokens.map((token, index) =>
    token.changed ? (
      <span
        key={index}
        style={{
          backgroundColor: kind === "add" ? "var(--color-success)" : "var(--color-danger)",
          color: "var(--color-bg-panel)",
          borderRadius: 2,
        }}
      >
        {token.text}
      </span>
    ) : (
      <span key={index}>{token.text}</span>
    ),
  );
}

/**
 * 文件内容视图（write 写入的正文）：行号列 + shiki 高亮正文，视觉语言与 DiffView
 * 同源（行号列右对齐褪色、正文列 pre-wrap）。语言推断不出或引擎未就绪时正文退纯色，
 * 行号列照常有——行号是定位工具不依赖语法。pi 的 write 也是调用阶段渲染正文，
 * 只是它无行号；成功后那行英文统计句两边都不再显示。
 */
function FileContentView(props: { text: string; startLine: number; lang: string | null }) {
  // shiki 就绪触发一次重渲（FenceBlock 同款）；之后缓存命中同步返回
  const [, setWarm] = useState(false);
  useEffect(() => {
    void highlighterReady.then(() => setWarm(true));
  }, []);
  const lines = props.lang !== null ? highlightLines(props.text, props.lang) : null;
  const rows: readonly (string | readonly TokenSpan[])[] = lines ?? props.text.split("\n");
  const lastLine = props.startLine + rows.length - 1;
  // 行号列宽随位数长（read/write 不设上限），最小 3ch 保持与 diff 4ch 相近的观感
  const gutter = `${Math.max(3, String(lastLine).length)}ch`;
  return (
    <div
      className="scroll"
      style={{
        display: "grid",
        gridTemplateColumns: `${gutter} 1fr`,
        maxHeight: 320,
        overflow: "auto",
        borderTop: "1px solid var(--color-border-subtle)",
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-caption)",
        lineHeight: 1.6,
      }}
    >
      {rows.flatMap((row, index) => [
        <span key={`${index}n`} style={LINE_NUM_COLUMN}>
          {props.startLine + index}
        </span>,
        <span
          key={`${index}b`}
          style={{
            padding: "0 var(--space-2)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            color: "var(--color-text-secondary)",
          }}
        >
          {typeof row === "string" ? row === "" ? " " : row : tokenSpans(row)}
        </span>,
      ])}
    </div>
  );
}

/** 高亮行 → token span 序列；shiki-tok 类挂暗主题切换（styles.css 的 --shiki-dark 翻色） */
function tokenSpans(line: readonly TokenSpan[]) {
  if (line.length === 0) return " ";
  return line.map((token, index) =>
    token.style === undefined ? (
      <span key={index}>{token.text}</span>
    ) : (
      <span key={index} className="shiki-tok" style={token.style as React.CSSProperties}>
        {token.text}
      </span>
    ),
  );
}

/**
 * 其余工具的展开体：逐行渲染的文本底座 + 工具级轻结构化——grep 的
 * 「path:行号: 正文」按匹配/上下文分两档（匹配正文 primary、上下文 secondary，
 * 前缀退成注脚），find / ls 的清单行把文件名亮出来（目录前缀退灰）。
 * 解析不出的行原样渲染，宁可不解析也不猜错。
 * **失败时整块退回原样行并染 danger**（折叠行的红 triangle 在这里续上），
 * 结构化只对成功结果做——错误文本长得不像清单，硬解析是猜。
 * `live` 是跑着的 shell：输出增长贴底跟随（用户上滚脱离、回底恢复），
 * 还没吐出第一个字时显示「等待输出」。
 */
function PlainToolBody(props: {
  toolName: string;
  text: string;
  failed: boolean;
  live?: boolean;
}) {
  const follow = useFollowScroll(props.live === true);
  if (props.text === "") {
    return (
      <div
        className="scroll"
        style={{ ...PLAIN_BODY, color: "var(--color-text-secondary)", padding: "0 var(--space-2)" }}
      >
        {props.live === true ? "（等待输出…）" : "（无输出）"}
      </div>
    );
  }
  if (props.failed) {
    return (
      <div ref={follow.ref} onScroll={follow.onScroll} className="scroll" style={PLAIN_BODY}>
        {props.text.split("\n").map((line, index) => (
          <div key={index} style={{ ...BODY_LINE, color: "var(--color-danger)" }}>
            {line === "" ? " " : line}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div ref={follow.ref} onScroll={follow.onScroll} className="scroll" style={PLAIN_BODY}>
      {props.text.split("\n").map((line, index) => toolBodyLine(props.toolName, line, index))}
    </div>
  );
}

/** 展开体滚动容器的共用形态（DiffView / FileContentView 同款，无内边距——行自带） */
const PLAIN_BODY = {
  maxHeight: 320,
  overflow: "auto",
  borderTop: "1px solid var(--color-border-subtle)",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-caption)",
  lineHeight: 1.6,
} satisfies React.CSSProperties;

const BODY_LINE = {
  padding: "0 var(--space-2)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} satisfies React.CSSProperties;

/** 单行按工具着色；工具没有专门形态的走 secondary 原样行（无结构正文的内容基线） */
function toolBodyLine(toolName: string, line: string, key: number): ReactNode {
  if (toolName === "grep") {
    const parsed = parseGrepLine(line);
    if (parsed !== null) {
      const separator = parsed.kind === "match" ? ":" : "-";
      return (
        <div key={key} style={BODY_LINE}>
          <span style={{ color: "var(--color-text-tertiary)" }}>
            {parsed.path}
            {separator}
            {parsed.lineNum}
            {separator}{" "}
          </span>
          <span
            style={{
              color:
                parsed.kind === "match"
                  ? "var(--color-text-primary)"
                  : "var(--color-text-secondary)",
            }}
          >
            {parsed.text === "" ? " " : parsed.text}
          </span>
        </div>
      );
    }
  }
  if (toolName === "find" || toolName === "ls") {
    const { dir, name } = splitPathTail(line);
    return (
      <div key={key} style={BODY_LINE}>
        {dir !== "" && <span style={{ color: "var(--color-text-secondary)" }}>{dir}</span>}
        <span style={{ color: "var(--color-text-primary)" }}>{name === "" ? " " : name}</span>
      </div>
    );
  }
  return (
    <div key={key} style={{ ...BODY_LINE, color: "var(--color-text-secondary)" }}>
      {line === "" ? " " : line}
    </div>
  );
}

/**
 * 思考行：brain 图标（进行中保持 info 蓝——全转写里唯一的蓝记号）+「思考」
 * label + 副标。副标是时间态：**流式中**是活尾预览（新的一行顶替上一行）；
 * **落定**换成「持续了 N 秒」（现场计时，重开的旧会话量不到就什么都不显示）。
 * 行首呼吸同其它过程行：进行中 secondary + 呼吸，写完呼吸与高亮一起消失。
 * 要看全文点开，展开体 160px 封顶滚动；**流式中展开会贴底跟随**（上滚脱离、
 * 回底恢复），落定后内容定格，跟随停止。
 */
function ThinkingLine(props: { text: string; active: boolean; blockKey: string }) {
  const [open, setOpen] = useState(false);
  const { active } = props;
  const body = props.text.trim();
  const follow = useFollowScroll(active);
  const duration = thinkingDurationText(props.blockKey, active);
  const preview = active ? thinkingPreview(body) : "";
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        <span className={active ? "orbita-breath" : undefined} style={HEAD_WRAP}>
          <span style={{ color: active ? "var(--color-info)" : headIconColor(active) }}>
            <Icon name="brain" size={14} strokeWidth={1.8} />
          </span>
          <span style={headLabel(active)}>思考</span>
        </span>
        {/* 展开时预览让位——正文已经是更全的信息，同一行不必再放一遍尾巴 */}
        {active && !open && preview !== "" && <span style={SLOT.sub}>{preview}</span>}
        {!active && duration !== null && <span style={SLOT.sub}>{duration}</span>}
      </CollapseRow>
      {open && body !== "" && (
        <div
          ref={follow.ref}
          onScroll={follow.onScroll}
          className="scroll"
          style={{
            ...EXPANDED_BODY,
            color: "var(--color-text-tertiary)",
            maxHeight: 160,
          }}
        >
          {body}
        </div>
      )}
    </div>
  );
}

/**
 * 压缩界碑行：折叠时一行（已压缩 + token 数变化），点开看摘要全文。
 * 与 ThinkingLine 同一份折叠契约，展开体 320px 封顶（摘要值得读，但也不许顶走输入卡）。
 * 摘要是 markdown——它走 MarkdownBlock，与 agent 回复同一套渲染。
 * 不放图标：archive 与侧栏「归档」撞车，文字本身已足够指认。
 * 上方一条 hairline + 多留一倍间距：界碑是「分段」，不是上一轮回复的一部分。
 */
function CompactedLine(props: { record: CompactedRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-1)",
        minWidth: 0,
        marginTop: "var(--space-4)",
        borderTop: "1px solid var(--color-border-subtle)",
        paddingTop: "var(--space-3)",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          width: "fit-content",
          maxWidth: "100%",
          minWidth: 0,
          padding: 0,
          border: "none",
          background: "none",
          color: "var(--color-text-secondary)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-control)",
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {compactionBoundaryText(props.record)}
        </span>
      </button>
      {open && (
        <div
          className="scroll"
          style={{
            maxHeight: 320,
            overflow: "auto",
            padding: "var(--space-2) var(--space-3)",
            background: "var(--color-bg-muted)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <MarkdownBlock text={props.record.summary} />
        </div>
      )}
    </div>
  );
}

function Responding() {
  return (
    <p
      className="orbita-breath"
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

/**
 * 压缩进行态：转录末尾、内容列内居中的一行，整体呼吸（styles.css 的 orbita-breath）。
 * 图标旋转表示「在干活」，整行呼吸表示「后台维护中，别急」——两层信号叠在一起
 * （旋转与呼吸都是设计系统 Motion 段认可的持续动效）。完成后本行卸载，界碑按时间落进流里。
 */
function Compacting() {
  return (
    <p
      className="orbita-breath"
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: 0,
        color: "var(--color-text-secondary)",
        fontSize: "var(--font-size-control)",
      }}
    >
      <span style={{ display: "inline-flex", color: "var(--color-warning)" }}>
        <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
      </span>
      正在压缩上下文…
    </p>
  );
}

/**
 * 自动重试进行态：转录末尾一行（重试等待中替换 Responding），或压缩行下的居中补充行
 * （摘要调用的重试）。倒数是活的——挂载期间每秒重算，锚点在 agent 进程盖的 startedAt
 * 上，切走再切回不重启。视觉语法与 Responding / Compacting 同一套（呼吸 + 旋转 +
 * warning 图标），失败原因是最淡一档的注脚、悬停看全文——断网还是限流一眼可辨。
 */
function Retrying(props: { status: RetryStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const cause = retryCauseText(props.status.errorMessage);
  return (
    <p
      className="orbita-breath"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "fit-content",
        maxWidth: "100%",
        margin: 0,
        color: "var(--color-text-secondary)",
        fontSize: "var(--font-size-control)",
      }}
    >
      <span style={{ display: "inline-flex", color: "var(--color-warning)" }}>
        <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
      </span>
      {retryLineText(props.status, now)}
      {cause !== null && (
        <span
          title={props.status.errorMessage}
          style={{
            color: "var(--color-text-tertiary)",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {cause}
        </span>
      )}
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
