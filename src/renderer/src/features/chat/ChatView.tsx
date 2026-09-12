import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { ApprovalBar } from "./ApprovalBar";
import { QueueStrip } from "./QueueStrip";
import { compactionBoundaryStatus, mergeCompactions } from "./session-states";
import { isAtBottom } from "./scroll";
import {
  branchAnchorEntries,
  branchAnchorIds,
  answerText,
  editDiffText,
  failedFoldKey,
  fileViewFor,
  flattenRenderUnits,
  formatToolDuration,
  formatThinkingDuration,
  groupToolUnits,
  groupTurns,
  indexToolResults,
  mcpFailureLead,
  mcpInputSummary,
  summarizeMcpResult,
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
  turnAssistantRecords,
  turnStats,
  writeLineCount,
  type IntraToken,
  type RenderEntry,
  type ToolGroupUnit,
  type ToolResultIndex,
  type TurnGroupUnit,
} from "./tool-results";
import { highlighterReady, highlightLines, langFromPath, type TokenSpan } from "./highlight";
import { Composer } from "../../shell/Composer";
import { MathText } from "../../shell/MathText";
import { SessionCard } from "../../shell/SessionCard";
import { Chip } from "../../shell/Chip";
import { Menu, type MenuItem } from "../../shell/Menu";
import { InlineName } from "../../shell/InlineName";
import { IconButton } from "../../shell/IconButton";
import { Icon, type IconName } from "../../shell/Icon";
import { MarkdownBlock } from "./MarkdownBlock";
import { contextRing, formatSpeed, replySpeed, streamingStart, usageBreakdown, type ContextRing } from "./stats-format";
import { isPlanBilling, KNOWN_PROVIDERS, knownModelParams } from "@shared/known-providers";
import type { BuiltinModel, BuiltinProvider } from "@shared/agent-ipc";
import { api } from "../../api";
import { kindOf, modelContextText } from "../settings/providers-view-model.ts";
import { estimateStreamingTokens, messageSpeed } from "@shared/message-speed";
import { parseQualifiedToolName } from "@shared/mcp";
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
export function ChatView(props: { session: ChatSession; providersError?: string | null }) {
  const { session, providersError } = props;

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

  // —— R5-05 首发过渡：slogan 与会话卡 220ms 向上淡出，composer 240ms 滑向窗口底部。
  // leaving 由事件处理器（发送 / 点会话卡）同步置位，首页保持挂载走完动画再让位；
  // 目的地没就绪（create / load 慢于动画）就宁可不动画，硬切也不闪回。
  const [travel, setTravel] = useState<"none" | "leaving" | "prep" | "entering">("none");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const leaveTimer = useRef<number | undefined>(undefined);
  const chattedRef = useRef(false);
  const homeActive = session.sessionId === null && session.opened === null;

  /** 滑落距离：composer 现位到窗口底部（聊天页 footer 的大致位置）。外层量——prep 拍里它自己带着 transform。 */
  const measureTravel = () => {
    const el = stageRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--travel-dy", `${Math.max(0, window.innerHeight - rect.bottom - 32)}px`);
  };

  const startLeave = () => {
    if (travel === "leaving" || travel === "prep") return;
    measureTravel();
    setTravel("leaving");
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setTravel("none"), 260);
  };

  // 回场（New task / 发送失败回家）：反方向走一遍。**首启不算「回来」**，不做动画
  useEffect(() => {
    if (!homeActive) {
      chattedRef.current = true;
      return;
    }
    if (!chattedRef.current) return;
    setTravel("prep");
    const raf = requestAnimationFrame(() => {
      measureTravel();
      requestAnimationFrame(() => setTravel("entering"));
    });
    const timer = window.setTimeout(() => setTravel("none"), 300);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeActive]);

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
      // 发送即恢复跟随：翻着历史发消息，新对话永远长在底部。
      // 首页发送时同步起离场动画（R8-01 ③：首条消息提交才 createAgent）
      onSubmit={() => {
        followRef.current = true;
        if (homeActive) startLeave();
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
      {providersError != null ? (
        // 加载失败 ≠ 没有 provider：原因说清楚，去设置面重试（打开设置会重新拉取）
        <Notice tone="bad">
          Providers failed to load: {providersError} — open Settings to retry.
        </Notice>
      ) : (
        session.usable.length === 0 && (
          <Notice>Add a provider with at least one model in Settings, then send a message.</Notice>
        )
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

  // 首页 = 既没有活着的会话，也没有打开任何一条旧会话。
  // leaving 期间保持首页挂载（homeActive 已翻 false 也一样），动画走完再让位给聊天页
  if (homeActive || travel === "leaving") {
    // 会话卡数据：全局最近活跃的前 3 条（list 已按 sortSessions 排序），
    // 排除已归档与从未发过消息的——后者连标题都没有，卡片无物可显
    const recents = session.sessions.filter((m) => !m.archived && m.title !== "").slice(0, 3);
    return (
      <div
        className="home-stage"
        data-leaving={travel === "leaving" ? "true" : undefined}
        data-travel={travel === "prep" || travel === "entering" ? travel : undefined}
        style={{
          position: "relative",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-5)",
          overflow: "hidden",
        }}
      >
        {/*
          首页没有页头，但顶部这一条同样要能拖窗口 / 双击缩放——不给的话用户从会话页
          回到首页就会发现「刚才能拖的地方现在不能拖了」。高度与 Pane 页头对齐（30 + 12×2）。
          压在内容下面（zIndex 0）：窗口矮到内容顶上来时，会话卡的点击优先，不被拖拽区吞掉。
        */}
        <div
          className="titlebar"
          style={{ position: "absolute", insetInlineStart: 0, insetInlineEnd: 0, top: 0, height: 54, zIndex: 0 }}
        />
        <div
          ref={stageRef}
          style={{
            position: "relative",
            zIndex: 1,
            width: "min(100%, var(--content-max-width))",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "var(--space-5)",
          }}
        >
          {/* 淡出组：slogan 与会话卡一起向上走（--transition-layer，220ms） */}
          <div
            className="home-fade"
            style={{
              width: "100%",
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
            {/* 一排最近会话卡（SessionCard 规格：恒三槽、等高、hover 只抬阴影） */}
            {!session.sessionsLoaded ? (
              <div style={{ width: "100%", display: "flex", gap: "var(--space-3)" }}>
                {[0, 1, 2].map((index) => (
                  <SessionCard key={index} name="" loading />
                ))}
              </div>
            ) : (
              recents.length > 0 && (
                <div style={{ width: "100%", display: "flex", gap: "var(--space-3)" }}>
                  {recents.map((meta) => (
                    <SessionCard
                      key={meta.id}
                      name={meta.title}
                      queries={meta.recentQueries}
                      running={session.phaseOf(meta.id) !== "idle"}
                      onClick={() => {
                        startLeave();
                        session.openSession(meta.id);
                      }}
                    />
                  ))}
                </div>
              )
            )}
          </div>
          {/* 滑落组：notices 与 composer 一起滑向窗口底部（--transition-composer-exit，240ms） */}
          <div
            className="home-travel"
            style={{ width: "100%", display: "grid", gap: "var(--space-2)" }}
          >
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
            items={session.queued}
            phase={session.phase}
            onSendNow={session.sendQueuedNow}
            onWithdraw={session.withdrawQueued}
            onMove={session.moveQueuedTo}
          />
          {composer}
        </>
      }
    >
      <TranscriptColumn
        transcript={session.transcript}
        compactions={session.compactions}
        phase={session.phase}
        retry={session.retry}
        turnError={session.turnError}
        loadingHistory={session.loadingHistory}
        onBranch={session.branchFrom}
      />
    </Pane>
  );
}

/**
 * 转录列（memo 隔离）：往来流与它的一切派生（摊平 / 分组 / 折叠 / 分支锚点）只吃
 * 这几个 props。隔离的理由是可感的点击延迟（2026-09-10）：草稿每个字、排队卡每次
 * 乐观更新都会让 useChatSession 重渲染，此前整列几百行单元跟着全部重新对账一遍，
 * 流式期间主线程被逐帧渲染占满，点击反馈排不上队。transcript 引用在 hook 侧
 * 已按 entry 稳定化——闲时（打字 / 排队操作）memo 命中，整列跳过；流式期间它
 * 逐帧变化，列照旧逐帧重渲染，活体的实时性不变。
 */
const TranscriptColumn = memo(function TranscriptColumn(props: {
  transcript: readonly TranscriptItem[];
  compactions: readonly CompactedRecord[];
  phase: "idle" | "turn" | "compaction";
  retry: RetryStatus | null;
  turnError: string | null;
  loadingHistory: boolean;
  onBranch: (anchorItemId: string) => void;
}) {
  const { transcript } = props;
  // 派生链按引用记忆：没变的部分不重复对账（phase / retry / turnError 槽变化时只补差额）
  const toolResults = useMemo(() => indexToolResults(transcript), [transcript]);
  // 界碑按发生位置插回往来流：压缩摘要收进「已压缩」折叠行，历史一条不少
  const records = useMemo(
    () => mergeCompactions(props.compactions, transcript),
    [props.compactions, transcript],
  );
  // 摊平 → 相邻同类合并：渲染从「按条」改成「按单元」，连续同类工具收成一行组
  const units = useMemo(() => flattenRenderUnits(records), [records]);
  const entries = useMemo(() => groupToolUnits(units), [units]);
  // 组行的展开是时间态：活跃轮里铺开，整轮落定一次性收纳（见 ToolGroupLine）
  const turnActive = props.phase === "turn";
  // 大折叠：已落定轮次的思考与工具收成一行统计（活跃轮原样铺开，见 groupTurns）
  const turnView = useMemo(() => groupTurns(entries, turnActive, toolResults), [entries, turnActive, toolResults]);
  // 流式中的思考块（行首呼吸的判定）：本轮未结束且它是流式 assistant 消息的最后一块
  const activeThinkingKey = useMemo(
    () => streamingThinkingKey(records, turnActive),
    [records, turnActive],
  );
  // 分支锚点（C-2）：每轮最终完整输出的最后一个单元后面挂一条分支按钮行；
  // 有工具还在跑时全部禁用——它的结果没齐，此刻切出去的上下文是畸形的。
  // 锚点算在**大折叠视图**上：锚点的正文永远在折叠外面，按钮跟着正文走。
  const branchRows = useMemo(
    () => branchAnchorEntries(branchAnchorIds(records, toolResults), turnView),
    [records, toolResults, turnView],
  );
  const toolsRunning = useMemo(
    () => transcript.some((item) => item.role === "tool" && item.status === "running"),
    [transcript],
  );
  // 回合级失败（网络中断 / 重试耗尽）的红 triangle 只挂**失败那轮**的折叠（见 failedFoldKey）；
  // 那轮没折叠就不挂，红字自带的图标是全部。
  // 工具类失败不配图标（各自的红色 failed 计数已经跟在工具后面）。
  // 局部名叫 failedFold：failedFoldKey 是 turn-rollup 里的函数，不能重名遮蔽。
  const failedFold = props.turnError !== null ? failedFoldKey(turnView) : null;

  return (
    <>
      {/* 历史恢复在途：一行安静的加载指示，正文区不再是一片无解释的空白 */}
      {props.loadingHistory && entries.length === 0 && <StatusLine spin>Loading…</StatusLine>}
      {/* 空会话（没发过消息）：一行 tertiary 交代「这里为什么是空的」 */}
      {entries.length === 0 &&
        !props.loadingHistory &&
        props.phase === "idle" &&
        props.turnError === null && (
          <StatusLine>No messages yet. Send the first one to start.</StatusLine>
        )}
      {turnView.map((entry, index) => {
        const branchAfter = branchRows.get(index);
        // 复制与速度都按锚点所在的**整轮**取：轮内可能有多条 assistant 记录（每次 toolCall 切一条）
        const turnRecords = branchAfter !== undefined ? turnAssistantRecords(records, branchAfter) : [];
        return (
          <Fragment key={entry.key}>
            {entry.kind === "turnGroup" ? (
              <TurnRollupLine
                group={entry}
                toolResults={toolResults}
                turnFailed={entry.key === failedFold}
              />
            ) : (
              <EntryView
                entry={entry}
                toolResults={toolResults}
                activeThinkingKey={activeThinkingKey}
                turnActive={turnActive}
              />
            )}
            {branchAfter !== undefined && (
              <BranchRow
                anchorItemId={branchAfter}
                speed={replySpeed(turnRecords)}
                copyText={answerText(turnRecords)}
                disabled={toolsRunning}
                onBranch={props.onBranch}
              />
            )}
          </Fragment>
        );
      })}
      {props.turnError !== null && (
        /*
         * 回合失败标注（重试耗尽）：跟着失败的归属走——它追在谁后面，就贴着谁的
         * 对齐侧（用户消息居右、agent 消息居左，UserBubble 同款）。常见情形是模型
         * 调用重试耗尽、转录末尾正是那条没送出去的用户消息 → 居右；回答中途断掉
         * （末条是半截 assistant）→ 居左。新一轮开跑自动清除（槽里清）。
         */
        <div
          style={{
            display: "flex",
            width: "100%",
            justifyContent: transcript.at(-1)?.role === "user" ? "flex-end" : "flex-start",
          }}
        >
          <Notice tone="bad">{props.turnError}</Notice>
        </div>
      )}
      {props.phase === "turn" &&
        (props.retry !== null ? <Retrying status={props.retry} /> : <Responding transcript={transcript} />)}
      {props.phase === "compaction" && (
        <>
          <Compacting />
          {props.retry !== null && (
            <div style={{ display: "flex", justifyContent: "center" }}>
              <Retrying status={props.retry} />
            </div>
          )}
        </>
      )}
    </>
  );
});

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
      {/* 页头兼窗口拖拽区：整行可拖可双击缩放，里面的铅笔与输入框由 `.titlebar button/input` 自动豁免 */}
      <header
        className="titlebar"
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
  // 作用域显示**目录名**。老工作区落库的名可能是完整路径（早期创建没截尾），
  // 所以两个分支都要过 basename——显示层截尾，不动落库数据
  const scopeSource = workspace?.name ?? session.cwd;
  const scope = scopeSource === null ? "Home" : basename(scopeSource) || "Home";

  // pi 内建目录：模型项的 ctx 徽标要从这里查官方参数（与设置页同一套口径）。
  // 拉不到就空目录——徽标如实落到 fallback，不挡选模型
  const [catalog, setCatalog] = useState<BuiltinProvider[]>([]);
  useEffect(() => {
    void api.provider
      .builtins()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);

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

  // 按厂商分组：厂商名做组头行，模型行缩进其下只带参数徽标——参数口径与设置页
  // 完全同源（用户覆盖 > pi 目录 > 白名单 > 兜底），两边讲同一个故事
  const modelItems: MenuItem[] = session.usable.flatMap((provider) => {
    const known = KNOWN_PROVIDERS.find((k) => k.id === kindOf(provider));
    const metaOf = (id: string): BuiltinModel | undefined =>
      known?.catalogId === undefined
        ? undefined
        : catalog.find((c) => c.id === known.catalogId)?.models.find((m) => m.id === id);
    const rows: MenuItem[] = [
      { id: `hdr:${provider.id}`, label: provider.displayName, header: true },
    ];
    for (const declared of provider.models.declared) {
      const badge = modelContextText(
        declared,
        metaOf(declared.id),
        knownModelParams(known?.id ?? "", declared.id),
      );
      rows.push({
        id: `${provider.id}:${declared.id}`,
        label: declared.id,
        badge: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
            <span className="pv-badge" title="Context window">
              {badge.text}
            </span>
            {declared.vision === true && (
              <span className="pv-badge" title="Accepts image input — multimodal">
                <Icon name="image" size={11} strokeWidth={1.8} />
              </span>
            )}
          </span>
        ),
        checked:
          session.model?.providerId === provider.id && session.model.modelId === declared.id,
        onSelect: () => session.chooseModel(provider.id, declared.id),
      });
    }
    return rows;
  });

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
          searchable
          trigger={({ open, toggle }) => (
            <Chip
              active={open}
                title="Model · applies from the next message"
              onClick={toggle}
              chevron
            >
              {session.model?.modelId ?? "No model"}
            </Chip>
          )}
        />
      )}
      <UsageRing session={session} />
    </>
  );
}

/**
 * 底栏最右侧的用量环（A-1）。它顶替了 `18.2k / 200k · $0.06` 那行字——
 * 文字每次都要读，环扫一眼就够，省下的宽度留给别的芯片。
 *
 * **悬停即开分项菜单**（`hoverOpen`），不用点；分项走我们自己画的菜单行，
 * **不用原生 `title`**——原生 tooltip 的字体/字号/颜色由系统决定，改不了，
 * 而且它会在悬停约 1 秒后再弹一次，与菜单重复（wafo 2026-09-03 报的两次悬停）。
 *
 * 菜单底下挂「Compact context now」（A2-Q1 裁决：菜单项与 `/compact` 都要）。
 * 压缩只在闲着时给：pi 的 `compact()` 会先打断当前这一轮——跑着时让人点得动，
 * 他以为只是整理一下，实际把回答砍了。**禁用的理由写在 hint 里**，不让它只是变灰。
 */
function UsageRing(props: { session: ChatSession }) {
  const { session } = props;
  const stats = session.stats;
  const ring = contextRing(stats);
  const busy = session.phase !== "idle";
  // 包月制的 provider 不显示花费——那个数字是拿 API 价目表算的估价，不是他的账单。
  // 认不得的 id（自建网关）一律当按量算：藏起真实花费比多一行估价更坏。
  const billing =
    session.model !== null && isPlanBilling(session.model.providerId) ? "plan" : "metered";
  /**
   * 压缩走两段式（与侧栏 Delete 同一副骨架，wafo 2026-09-03 裁决）：
   * 用户意愿优先——不再拿「内容太少」当拒绝理由，改说「价值不大」再让他确认。
   * 第二段的文案按规模分岔：阈值取 pi 的 keepRecentTokens 默认值（20k）——
   * 低于它压缩省不了什么，高于它才值得问一句「确认压吗」。
   */
  const [confirming, setConfirming] = useState(false);
  /**
   * 「值得压」的量不是「当前上下文多大」，而是**还有多少没被压过的内容**。
   *
   * 已压缩过的会话当前 tokens 里大部分是摘要——摘要本身再压一遍没有意义，
   * 有意义的是上次界碑之后又攒了多少新对话。用 `tokensAfter`（上次压缩完的
   * 估算）当基线：新增 = 当前 − 基线。没压过的会话没有基线，全部都算新增。
   * （wafo 2026-09-03 深夜实测撞的坑：压缩到 15k 后判「≤20k 不值得」用的是
   * 总量，把「压完只剩摘要」和「压根没得压」混成了同一句话。）
   *
   * 阈值 20k = pi 的 keepRecentTokens 默认值。
   */
  const usageTokens = stats?.contextUsage?.tokens ?? null;
  const lastCompactedTo = session.compactions.at(-1)?.tokensAfter ?? null;
  const freshTokens =
    usageTokens === null ? null : lastCompactedTo === null ? usageTokens : Math.max(0, usageTokens - lastCompactedTo);
  const worthIt = freshTokens !== null && freshTokens > 20_000;
  const items: MenuItem[] = [
    ...usageBreakdown(stats, billing).map((row) => ({
      id: row.label,
      label: row.label,
      hint: row.value,
      fact: true,
    })),
    ...(confirming
      ? [
          {
            id: "compact-confirm-hint",
            label: worthIt
              ? "Compress the conversation so far into a summary?"
              : "This conversation is still short — compacting now saves little. Compact anyway?",
            fact: true,
          } satisfies MenuItem,
          {
            id: "compact-confirm",
            label: "Compact anyway",
            icon: "fold-vertical" as const,
            onSelect: () => {
              setConfirming(false);
              session.compact();
            },
          },
          {
            id: "compact-cancel",
            label: "Cancel",
            icon: "x" as const,
            keepOpen: false,
            onSelect: () => setConfirming(false),
          } satisfies MenuItem,
        ]
      : [
          {
            id: "compact",
            label: "Compact context now",
            icon: "fold-vertical" as const,
            hint: session.readOnly
              ? "this task can't be continued"
              : busy
                ? "wait for this turn"
                : undefined,
            disabled: session.readOnly || busy,
            keepOpen: true,
            onSelect: () => setConfirming(true),
          } satisfies MenuItem,
        ]),
  ];
  return (
    <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", justifyContent: "flex-end" }}>
      <Menu
        items={items}
        align="end"
        hoverOpen
        onOpenChange={(next) => {
          if (!next) setConfirming(false);
        }}
        trigger={({ open, toggle }) => (
          <Chip active={open} onClick={toggle} aria-label={ring.label}>
            <Ring ring={ring} />
          </Chip>
        )}
      />
    </span>
  );
}

/** 环的几何：直径、线宽——底栏芯片里 12px 的图标位 */
const RING_SIZE = 14;
const RING_STROKE = 2;

/**
 * 上下文占用环。底环一圈中性边框色，弧从 12 点方向顺时针长——和钟一样，不用学。
 * 颜色是第二信号（设计系统）：过七成前继承文字色，之后才用 warning / danger。
 * `fill` 为 null 时只有底环：没数字就不画数字。
 */
function Ring(props: { ring: ContextRing }) {
  const radius = (RING_SIZE - RING_STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const { fill, tone } = props.ring;
  const color =
    tone === "danger"
      ? "var(--color-danger)"
      : tone === "warning"
        ? "var(--color-warning)"
        : "currentColor";
  return (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden
      style={{ display: "block" }}
    >
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={radius}
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth={RING_STROKE}
      />
      {fill !== null && fill > 0 && (
        <circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={`${circumference * fill} ${circumference}`}
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          style={{ transition: "stroke-dasharray var(--duration-hover) var(--ease-standard)" }}
        />
      )}
    </svg>
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

/**
 * 大折叠行（一轮一行）：agent 整轮回答落定后，这轮的思考行与工具行/组收成
 * 一条统计——`Worked 45s · thought 2 · tools 8 · bash 3 · read 5 1 · edit 2`
 * （段与段之间用 · 分隔；失败数是紧跟在工具次数后面的红色数字）。
 * Worked 之后每个段都是「标签 + 数字」同一语法：thought / tools 与工具名
 * 同一套小写词汇，数字一律在后。
 * 工具类别用**真实工具名**而非组行动词（Run/Read…）：统计行是机器事实，
 * Run 会把 bash 与 powershell 混为一谈，且成员行展开后显示的也是同一套名字。
 * 思考排在工具之前——先想后做，时间序。
 * 展开就是成员行原样（小折叠降级为成员，两层折叠契约）；轮耗时是记录时间戳
 * 的跨度（adapter 每帧落 now()，旧会话也准）。
 * 图标裁决（用户）：折叠头**不带图标**——工具类失败靠跟在工具后面的红色数字
 * 说话；只有回合级失败（网络中断、重试耗尽——turnError 的红字就渲染在折叠
 * 后面）才在行首亮红 triangle，图标与那行红字是一对。
 * 成员行与折叠头同左缘（不缩进），与 ToolGroupLine 的成员同一规矩。
 */
function TurnRollupLine(props: { group: TurnGroupUnit; toolResults: ToolResultIndex; turnFailed: boolean }) {
  const [open, setOpen] = useState(false);
  const { group } = props;
  const stats = turnStats(group, props.toolResults);
  // 统计段先收集再渲染：段与段之间插 · 分隔——纯 gap 挨在一起分不清边界；
  // 工具次数与它的失败数字是一个段，中间不插
  const segments: ReactNode[] = [];
  if (stats.durationMs !== null) {
    segments.push(
      <span style={headLabel(false)}>
        {COPY.worked} {formatToolDuration(stats.durationMs)}
      </span>,
    );
  }
  if (stats.thinkingCount > 0) {
    segments.push(
      <span style={SLOT.status}>
        {COPY.thought} {stats.thinkingCount}
      </span>,
    );
  }
  if (stats.calls > 0) {
    segments.push(<span style={SLOT.status}>{COPY.tools(stats.calls)}</span>);
  }  for (const { toolName, count, failed } of stats.byTool) {
    segments.push(
      <span style={SLOT.status}>
        {toolName} {count}
        {/* 失败数不写词，红色数字直接跟在次数后面——红即失败的语义 */}
        {failed > 0 && <span style={{ color: "var(--color-danger)" }}> {failed}</span>}
      </span>,
    );
  }
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0 }}>
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        {props.turnFailed && (
          <span style={{ color: "var(--color-danger)", flex: "0 0 auto" }}>
            <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          </span>
        )}
        {segments.map((segment, index) => (
          <Fragment key={index}>
            {index > 0 && <span style={SEP_DOT}>·</span>}
            {segment}
          </Fragment>
        ))}
      </CollapseRow>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {group.members.map((member) => (
            <EntryView
              key={member.key}
              entry={member}
              toolResults={props.toolResults}
              activeThinkingKey={null}
              turnActive={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 用户消息：右对齐的独立气泡；只有 text 块进气泡。text 走 MathText——
 * 公式就地渲染（行内随文、块级居中），**不解析 markdown**：其余一切按原样，
 * 用户气泡与模型回复（MarkdownBlock）刻意是两套渲染。
 * 气泡下方的复制图标（与回答行同款反馈）：拷输入的原文（只含 text，图片不进）。
 */
function UserBubble(props: { item: Extract<TranscriptItem, { role: "user" }> }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copyText = props.item.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        width: "100%",
        gap: 2,
      }}
    >
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
          block.type === "text" ? <MathText key={index} text={block.text} /> : null,
        )}
      </div>
      <button
        type="button"
        title={copied ? "Copied" : "Copy message"}
        aria-label={copied ? "Copied" : "Copy message"}
        disabled={copyText === ""}
        onClick={() => {
          void navigator.clipboard.writeText(copyText);
          setCopied(true);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: 3,
          border: "none",
          background: "none",
          color: copied ? "var(--color-success)" : "var(--color-text-tertiary)",
          cursor: copyText === "" ? "default" : "pointer",
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={12} strokeWidth={1.8} />
      </button>
    </div>
  );
}

/**
 * 分支按钮行（C-2）：挂在每轮 agent 最终完整输出的下面，回答落定即**常驻显示**
 * （用户裁决：不用 hover 浮现）。图标即按钮——悬停 / 读屏都走「Branch from here」这同一个
 * 名字。点了开出一条新会话（该回答及之前的全部），原会话原封不动，所以**无需确认弹窗**。
 * 工具还在跑时禁用：它的结果没齐，此刻裁出去的上下文是畸形的。
 * 分支旁的复制图标（usage-speed-X 同行）：拷该回答的正文（markdown 原样，只含 text 块），
 * 成功后图标换对勾 1.2s——复制成功用图标换字形，不用颜色（ActionRail 同款）。
 * 再右边是这条回答的生成速度：adapter 挂在终态帧上的真值，随记录落盘、重开即回；
 * 过不了噪音门的回答没有这个字段，也就不显示。
 */
function BranchRow(props: {
  anchorItemId: string;
  speed: number | null;
  copyText: string;
  disabled: boolean;
  onBranch: (anchorItemId: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <div style={{ display: "flex", width: "100%", alignItems: "center", gap: "calc(var(--space-3) / 2)" }}>
      <button
        type="button"
        title={copied ? "Copied" : "Copy answer"}
        aria-label={copied ? "Copied" : "Copy answer"}
        onClick={() => {
          void navigator.clipboard.writeText(props.copyText);
          setCopied(true);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: 4,
          border: "none",
          background: "none",
          color: copied ? "var(--color-success)" : "var(--color-text-tertiary)",
          cursor: "pointer",
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={12} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        disabled={props.disabled}
        onClick={() => props.onBranch(props.anchorItemId)}
        title={COPY.branchFromHere}
        aria-label={COPY.branchFromHere}
        style={{
          display: "inline-flex",
          alignItems: "center",
          padding: 4,
          border: "none",
          background: "none",
          color: "var(--color-text-tertiary)",
          cursor: props.disabled ? "default" : "pointer",
        }}
      >
        <Icon name="git-branch" size={12} strokeWidth={1.8} />
      </button>
      {props.speed !== null && (
        <span
          style={{
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-family-business)",
            fontVariantNumeric: "tabular-nums",
            fontSize: "var(--font-size-micro)",
          }}
        >
          {formatSpeed(props.speed)}
        </span>
      )}
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

/** 大折叠统计段的分隔点：段落边界的标点，最淡一档——它是标点不是内容。 */
const SEP_DOT = {
  flex: "0 0 auto",
  color: "var(--color-text-tertiary)",
  opacity: 0.6,
} satisfies React.CSSProperties;

/**
 * 展开体的纵向导轨：与行首 icon 的**左缘相切**——x = 10px（按钮内边距，即 icon 的
 * 左缘）。展开内容一律不越过导轨左侧：展开体明确属于它上面那一行，不与
 * 别的行抢左缘；多条展开体并排时导轨与 icon 连成一条竖线。
 */
const RAIL_X = 10;
/** 导轨用 border-default 而非 subtle：深色下 subtle 与地面只差几阶（black #1e1e1e 对
 * #0a0a0a），孤立的 1px 竖线会隐形；default（#262626 / #333534）强一档才立得住。
 * 浅色下两者几乎无差，三主题同一 token。 */
const RAIL_LINE = "1px solid var(--color-border-default)";

/**
 * 展开体共用形态：细分隔线接在折叠行下、无底色、mono caption——chat 内卡片无框无填充。
 * 左侧挂导轨（顶线与导轨在左上角相接成直角），正文从导轨右侧起。
 */
const EXPANDED_BODY = {
  margin: 0,
  marginLeft: RAIL_X,
  padding: "var(--space-2)",
  maxHeight: 320,
  overflow: "auto",
  borderTop: "1px solid var(--color-border-subtle)",
  borderLeft: RAIL_LINE,
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-caption)",
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} satisfies React.CSSProperties;

/**
 * markdown 展开体（压缩界碑行用）：EXPANDED_BODY 的骨架（hairline 顶线 + 320 封顶 +
 * 可滚），排版让给 .chat-md——摘要是结构化文档，不套 mono caption / pre-wrap。
 * 导轨照挂：界碑行虽无 icon，竖线仍与其余展开体同一位置（x=10px），内容列全体一致。
 */
const MARKDOWN_EXPANDED_BODY = {
  margin: 0,
  marginLeft: RAIL_X,
  padding: "var(--space-2)",
  maxHeight: 320,
  overflow: "auto",
  borderTop: "1px solid var(--color-border-subtle)",
  borderLeft: RAIL_LINE,
} satisfies React.CSSProperties;

// ── 信息区文案（本模块全部用户可见字符串集中在此；英文先行，中文化等真实需求出现再抽字典） ──
const COPY = {
  thinking: "Thinking",
  compacted: "Compacted",
  compacting: "Compacting context…",
  waitingOutput: "(waiting for output…)",
  noOutput: "(no output)",
  branchFromHere: "Branch from here",
  worked: "Worked",
  thought: "thought",
  lines: (n: number): string => `${n} lines`,
  files: (n: number): string => `${n} files`,
  commands: (n: number): string => `${n} commands`,
  matches: (n: number): string => `${n} matches`,
  directories: (n: number): string => `${n} directories`,
  calls: (n: number): string => `${n} calls`,
  tools: (n: number): string => `tools ${n}`,
  failed: (n: number): string => `${n} failed`,
};

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

/**
 * 组行的标签。bash / powershell 直接用**真实工具名**（用户裁决：不说 Run）——
 * Run 是编造的动词，还把两个不同的工具混为一谈；其余保留动词标签（Read/Search…，
 * 与「N files」量词配套），不认识的工具本就回落真名。
 */
function toolGroupLabel(toolName: string): string {
  switch (toolName) {
    case "read":
      return "Read";
    case "grep":
    case "find":
      return "Search";
    case "write":
      return "Write";
    case "edit":
      return "Edit";
    case "ls":
      return "List";
    default:
      return toolName;
  }
}

/** 组头折叠态的量词——跟着动词说量级：「Read 3 files / Run 3 commands」。 */
function toolGroupCountLabel(toolName: string, count: number): string {
  switch (toolName) {
    case "read":
    case "write":
      return COPY.files(count);
    case "bash":
    case "powershell":
      return COPY.commands(count);
    case "edit":
      return COPY.matches(count);
    case "ls":
      return COPY.directories(count);
    default:
      return COPY.calls(count);
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
  /** MCP 工具（4-5）：行首只说 tool 名，server 进副标；量词与失败分型另有规格 */
  const mcp = parseQualifiedToolName(props.toolName);
  const summary = mcp === null ? summarizeToolResult(result) : summarizeMcpResult(result);
  const callSummary = toolCallSummary(props.toolName, props.input);
  // 路径类工具的摘要只显示文件名——Windows 上模型几乎总传绝对路径，整条 C:\... 是噪音；
  // 完整路径进 tooltip。toolCallSummary 本身保持原始 path 语义（editGroupFileCount 靠它去重）
  const pathTool =
    props.toolName === "read" ||
    props.toolName === "write" ||
    props.toolName === "edit" ||
    props.toolName === "ls";
  const callLabel =
    callSummary !== null && pathTool ? splitPathTail(callSummary).name : callSummary;
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
  const fileLang = fileView !== null ? langFromPath(callSummary ?? "") : null;
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
          <span style={mcp === null ? headLabel(active) : { ...headLabel(active), fontWeight: 650 }}>
            {mcp === null ? props.toolName : mcp.tool}
          </span>
        </span>
        {mcp !== null ? (
          // MCP 副标：{server} · {输入摘要}（mono caption tertiary，规格 §8）。
          // 内建摘要器不认识 MCP 工具，退回 JSON 一行截断。
          (() => {
            const brief = callLabel ?? mcpInputSummary(props.input);
            return (
              <span style={{ ...SLOT.sub, fontFamily: "var(--font-family-mono)" }}>
                {mcp.server}
                {brief !== null ? ` · ${brief}` : ""}
              </span>
            );
          })()
        ) : callLabel !== null && (
          <span
            title={callSummary !== callLabel ? (callSummary ?? undefined) : undefined}
            style={pathTool ? { ...SLOT.sub, color: "var(--color-chat-link)" } : SLOT.sub}
          >
            {callLabel}
          </span>
        )}
        {/* 增删统计紧跟文件名（git stat 读法）；与展开后 DiffView 头重复，展开时藏起 */}
        {!open && stats !== null && (
          <span style={SLOT.status}>
            <span style={{ color: "var(--color-success)" }}>+{stats.added}</span>{" "}
            <span style={{ color: "var(--color-danger)" }}>-{stats.removed}</span>
          </span>
        )}
        {/* write 的量词是行数（无增删语义，不染色）；有了它「N chars」是统计句的长度，让位 */}
        {!open && stats === null && writeLines !== null && (
          <span style={SLOT.status}>{COPY.lines(writeLines)}</span>
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
      {open && expandable && diff === null && fileView === null && mcp !== null && (
        <McpToolBody result={result} />
      )}
      {open && expandable && diff === null && fileView === null && mcp === null && (
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
 * 成员行与组头**同左缘**（不缩进）：折叠行的 icon 上下连成一条线，缩进会把线打断。
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
          <span style={SLOT.status}>{COPY.files(fileCount)}</span>
        )}
        {!open && failed && (
          <span style={{ ...SLOT.status, color: "var(--color-danger)" }}>
            {COPY.failed(status.failed)}
          </span>
        )}
      </CollapseRow>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
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
        marginLeft: RAIL_X,
        paddingLeft: "var(--space-2)",
        borderTop: "1px solid var(--color-border-subtle)",
        borderLeft: RAIL_LINE,
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
        // 轨道要连 LINE_NUM_COLUMN 的横向内边距一起算进去，否则三位数行号顶穿竖线挤进正文
        gridTemplateColumns: "calc(4ch + var(--space-2) + var(--space-1)) 1fr",
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
  // 轨道 = 位数 + 行号格的横向内边距（不算 padding 的话三位数起就顶穿竖线挤进正文）
  const digits = Math.max(3, String(lastLine).length);
  const gutter = `calc(${digits}ch + var(--space-2) + var(--space-1))`;
  return (
    <div
      className="scroll"
      style={{
        display: "grid",
        gridTemplateColumns: `${gutter} 1fr`,
        maxHeight: 320,
        overflow: "auto",
        marginLeft: RAIL_X,
        paddingLeft: "var(--space-2)",
        borderTop: "1px solid var(--color-border-subtle)",
        borderLeft: RAIL_LINE,
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
/**
 * MCP 工具的展开体（4-5，规格 §8）：失败时首行讲清错在哪一层（业务失败是
 * server 报的错，传输失败是我们连不上/等不到）；成功时文本照常、图片内联
 * （max-height 240、--radius-md、发丝边框、mimeType 一行 micro）。
 * 相邻同名照常组折叠（组行不在这里，flatten 阶段已按 toolName 归组）。
 */
function McpToolBody(props: { result: ToolTranscriptItem | undefined }) {
  const { result } = props;
  if (result === undefined) return null;
  const isFailure = result.status === "error";
  const texts = result.content.filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text");
  const images = result.content.filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image");
  return (
    <div
      style={{
        display: "grid",
        gap: "var(--space-2)",
        padding: "var(--space-3)",
        background: "var(--color-bg-panel)",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        minWidth: 0,
      }}
    >
      {isFailure && (
        <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
          {mcpFailureLead(result)}
        </p>
      )}
      {texts.map((block, i) => (
        <pre
          key={i}
          style={{
            margin: 0,
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-caption)",
            lineHeight: 1.6,
            color: isFailure ? "var(--color-danger)" : "var(--color-text-primary)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {block.text}
        </pre>
      ))}
      {images.map((block, i) => (
        <figure key={`img-${i}`} style={{ margin: 0, display: "grid", gap: 2, minWidth: 0 }}>
          <img
            src={`data:${block.mimeType};base64,${block.data}`}
            alt=""
            style={{
              display: "block",
              maxWidth: "100%",
              maxHeight: 240,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--color-border-subtle)",
            }}
          />
          <figcaption
            style={{
              fontSize: "var(--font-size-micro)",
              color: "var(--color-text-tertiary)",
              fontFamily: "var(--font-family-mono)",
            }}
          >
            {block.mimeType}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

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
        {props.live === true ? COPY.waitingOutput : COPY.noOutput}
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

/** 展开体滚动容器的共用形态（无水平内边距——行自带）；左侧挂 RAIL 导轨，同 EXPANDED_BODY。 */
const PLAIN_BODY = {
  maxHeight: 320,
  overflow: "auto",
  marginLeft: RAIL_X,
  borderTop: "1px solid var(--color-border-subtle)",
  borderLeft: RAIL_LINE,
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
        <span style={{ color: "var(--color-chat-link)" }}>{name === "" ? " " : name}</span>
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
 * **落定**换成秒数（`3s`，现场计时，重开的旧会话量不到就什么都不显示）。
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
          <span style={headLabel(active)}>{COPY.thinking}</span>
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
 * 压缩界碑行：折叠时一行（Compacted + token 数变化），点开看摘要全文。
 * 头部与工具/思考行同一份 CollapseRow 契约（32px 热区、hover、三槽）；无图标——
 * archive 与侧栏「归档」撞车，文字本身已足够指认。label 是落定时间态（headLabel(false)），
 * 界碑永远不是「正在进行的事」，没有呼吸。
 * 界碑语义由外层 wrapper 承担：上方一条 hairline + 多留一倍间距——「分段，
 * 不是上一轮回复的一部分」，不随壳统一抹掉。
 * 展开体 320px 封顶（摘要值得读，但也不许顶走输入卡）；摘要是 markdown——
 * 走 MarkdownBlock 与 agent 回复同一套渲染，容器用 MARKDOWN_EXPANDED_BODY。
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
      <CollapseRow open={open} onToggle={() => setOpen((value) => !value)}>
        <span style={HEAD_WRAP}>
          <span style={headLabel(false)}>{COPY.compacted}</span>
        </span>
        <span style={SLOT.status}>{compactionBoundaryStatus(props.record)}</span>
      </CollapseRow>
      {open && (
        <div className="scroll" style={MARKDOWN_EXPANDED_BODY}>
          <MarkdownBlock text={props.record.summary} />
        </div>
      )}
    </div>
  );
}

function Responding(props: { transcript: readonly TranscriptItem[] }) {
  const { transcript } = props;
  // 秒针：Responding 只在回答期间挂载，一秒一跳不白算（Retrying 同款）
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // 耗时：本轮用户发话至今——「agent 回答了多久」是人感知的那段时间
  let userTs: number | null = null;
  for (const item of transcript) {
    if (item.role === "user") userTs = item.timestamp;
  }
  const elapsed = userTs !== null ? formatThinkingDuration(Math.max(0, now - userTs)) : null;
  // 流式速度：in-flight 的字符估算（estimateStreamingTokens，英文校准的粗账——
  // 中文会低估数倍，落定即被回答旁的真值顶替）÷ 本条消息已生成的秒数
  let speedText: string | null = null;
  const streaming = transcript.at(-1);
  if (streaming !== undefined && streaming.role === "assistant" && streaming.status === "streaming") {
    const chars = streaming.content.reduce(
      (sum, block) =>
        sum + (block.type === "text" ? block.text.length : block.type === "thinking" ? block.thinking.length : 0),
      0,
    );
    const start = streamingStart(streaming.id);
    const speed = start !== null ? messageSpeed(now - start, estimateStreamingTokens(chars)) : null;
    if (speed !== null) speedText = formatSpeed(speed);
  }
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
      {elapsed !== null && <span>· {elapsed}</span>}
      {speedText !== null && (
        <span
          style={{
            fontFamily: "var(--font-family-business)",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          · {speedText}
        </span>
      )}
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
      {COPY.compacting}
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
 * 正文区的状态行（空会话提示 / 历史恢复加载）：居中一行 tertiary，
 * 唯一的动效是 loader 的旋转（设计系统：continuous motion 只有 rotation 与 breathing）。
 */
function StatusLine(props: { children: React.ReactNode; spin?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-2)",
        width: "100%",
        padding: "var(--space-4) 0",
        color: "var(--color-text-tertiary)",
        fontSize: "var(--font-size-caption)",
      }}
    >
      {props.spin === true && (
        <span style={{ display: "inline-flex", flex: "0 0 auto" }}>
          <Icon name="loader-circle" size={13} strokeWidth={1.8} spin />
        </span>
      )}
      {props.children}
    </div>
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

/** 取路径尾段。分隔符 `/` 与 `\` 都认——Windows 的 cwd 是反斜杠，只切 `/` 会整条漏出来 */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}
