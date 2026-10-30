/**
 * 专注 shell：App 里所有「专注的接线」都收进这一个 hook。
 *
 * 搬进来的（#267 B1）：`useFocus()` 的状态、浏览态与浮层请求、左栏文件视图的派生、
 * 到点那一拍（提示音 / 系统通知 / 展开侧栏）、星云气泡与收工卡节点，以及两个入口
 * （工具栏 / 星云卡「再专注一轮」/浏览态「以此开始专注」）共用的出口。
 *
 * **搬接线，不是改功能**：计时与小结状态机仍在 `shell/focus/use-focus.ts`，秒针仍在
 * `FocusControl.tsx`，卡仍是 `FocusSummaryCard.tsx`——这里只把它们的判定与回调接在
 * 一起，行为逐字节保持（同一套判定抄进 `focus-shell.ts` 后补了测试）。
 *
 * App 需要给的事实都是参数：工作区与会话（工作区名、清单里的会话数）、设置里的
 * 提示音开关、文案表，再加四个出口——退掉设置页与子视图、展开侧栏、开文件面板、
 * 响提示音。App 自己那三份 state（overlay / archived / carryovers）不搬进来：
 * 它们也属于别处的入口，搬走就要为「谁持有」再造一层。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../../api";
import type { Messages } from "../../messages-en.ts";
import { rootSessions, type SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { FocusControl } from "../../shell/focus/FocusControl.tsx";
import { useFocus } from "../../shell/focus/use-focus.ts";
import type { FocusStatus } from "../../shell/focus/use-focus.ts";
import { isWindowInactive } from "../../shell/window-activity.ts";
import { FocusCardLayer, FocusSay } from "./FocusLayer.tsx";
import { focusBubbleOf, focusFilesViewOf, focusSuspendActionOf, type FocusFilesView } from "./focus-shell.ts";

interface FocusShellOptions {
  /** 文案表（到点通知的正文按它写；星云气泡与卡在组件里自己取） */
  t: Messages;
  workspaces: readonly Workspace[];
  /** 开始浮层的默认工作区（当前会话所在的那个） */
  defaultWorkspaceId: string | null;
  /** 会话清单：开始浮层每行的「N 个会话」从这里数 */
  sessions: readonly SessionMeta[];
  /** 设置里的完成提示音（到点那一拍读它） */
  completionSound: boolean;
  /**
   * 退掉盖在左栏之上的三样：设置页 overlay、归档、遗留事项子视图。
   * 它们的优先级都高过左栏文件视图（Sidebar 的 filesViewWs 判这三样）——起专注 /
   * 进浏览态前不退，左栏会继续停在原地（#267 B3 的根因）。
   */
  leaveSurfaces: () => void;
  /** 到点把收起的侧栏展开（星云要在左下角说话） */
  expandSidebar: () => void;
  /** 左栏双击文件 → 右栏开文件面板 */
  openFilesPanel: () => void;
  playChime: () => void;
}

interface FocusShell {
  /** 当前专注相位（App 的 FilesPanel 接线读 done） */
  status: FocusStatus;
  /** 工具栏左胶囊那一格（闪电 / 倒计时） */
  control: ReactNode;
  /** 星云头顶的气泡（Sidebar 的 usageSay） */
  say: ReactNode;
  /** 星云头顶的收工卡（Sidebar 的 usageCard） */
  card: ReactNode;
  /** 左栏此刻的文件视图；null = 会话列表 */
  filesView: FocusFilesView | null;
  /** 左栏双击打开请求（递到右栏文件面板，留在 App 接线） */
  fileOpen: { path: string; token: number } | null;
  /** 专注中（计时里）：完成提醒静音，别的会话跑完只记未读 */
  quiet: boolean;
  /** Sidebar 的 onBrowseWorkspace：进浏览态（先退掉设置页与子视图） */
  browseWorkspace: (workspaceId: string) => void;
  /** Sidebar 的 onExitBrowse */
  exitBrowse: () => void;
  /** Sidebar 的 onStartFocusHere / 卡片的「再专注一轮」：开开始浮层（token 递增） */
  startAt: (workspaceId: string, minutes?: number) => void;
  /** Sidebar 的 onOpenFile */
  openFile: (absPath: string) => void;
}

export function useFocusShell(options: FocusShellOptions): FocusShell {
  const {
    t,
    workspaces,
    defaultWorkspaceId,
    sessions,
    completionSound,
    leaveSurfaces,
    expandSidebar,
    openFilesPanel,
    playChime,
  } = options;

  // 计时住在内存里（用户裁决：关掉重开 = 已结束），App 经这个 hook 持有：
  // 工具栏左胶囊的 FocusControl、左栏的文件视图与星云的气泡 / 卡片共用同一份状态。
  const focus = useFocus();
  /** 浏览态（不计时看一眼工作区文件）；专注开始时退出 */
  const [wsBrowse, setWsBrowse] = useState<string | null>(null);
  /** 外部发起的开浮层请求（浏览态的「以此开始专注」/卡片的「再专注一轮」）：token 递增，同源连点也重开 */
  const focusPickerNonceRef = useRef(0);
  const [focusPickerRequest, setFocusPickerRequest] = useState<{
    workspaceId: string;
    minutes?: number;
    token: number;
  } | null>(null);
  /** 左栏（专注 / 浏览态）双击文件 → 右栏文件面板开预览标签（token 递增，与 reviewFocus 同款） */
  const fileOpenNonceRef = useRef(0);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ path: string; token: number } | null>(null);
  /** 星云卡片的一次关闭（「关闭（保持专注视图）」）：只藏卡不结束专注；每轮新开时重置 */
  const [summaryCardClosed, setSummaryCardClosed] = useState(false);
  /** 「正在整理」气泡的一次关闭（点了 x）：只藏气泡，到点的卡照样弹（focus-say 的口径） */
  const [sayDismissed, setSayDismissed] = useState(false);

  const openFocusFile = useCallback(
    (absPath: string): void => {
      fileOpenNonceRef.current += 1;
      setFileOpenRequest({ path: absPath, token: fileOpenNonceRef.current });
      openFilesPanel();
    },
    [openFilesPanel],
  );

  const openFocusPickerAt = useCallback((workspaceId: string, minutes?: number): void => {
    focusPickerNonceRef.current += 1;
    setFocusPickerRequest({
      workspaceId,
      ...(minutes === undefined ? {} : { minutes }),
      token: focusPickerNonceRef.current,
    });
  }, []);

  /**
   * 起专注（工具栏浮层的「开始专注」）：专注是替代会话列表的左栏视图，设置页 /
   * 归档 / 遗留事项都比它优先——先退掉，再停浏览态，最后才起表。气泡与卡的
   * 一次性关闭态在这里重置（每一轮都从「没点过 x」开始）。
   */
  const startFocus = useCallback(
    (workspaceId: string, minutes: number): void => {
      setWsBrowse(null);
      leaveSurfaces();
      setSummaryCardClosed(false);
      setSayDismissed(false);
      focus.start(workspaceId, minutes);
    },
    [focus, leaveSurfaces],
  );

  const browseWorkspace = useCallback(
    (workspaceId: string): void => {
      leaveSurfaces();
      setWsBrowse(workspaceId);
    },
    [leaveSurfaces],
  );

  const exitBrowse = useCallback((): void => setWsBrowse(null), []);

  const filesView = focusFilesViewOf(focus.status, wsBrowse);
  /**
   * 左栏双击打开请求只属于当时那个专注 / 浏览工作区：模式结束或换工作区后作废。
   *
   * 请求是一次性的，但面板收下后 token 仍留在这里——面板关掉再打开（FilesPanel
   * 重挂、consumed 的 ref 清空）会再消费一次；那时该工作区的根已经不在 tree.roots 里，
   * 于是报一句「<文件> 不在这个面板能看到的文件夹里」（2026-10-22 验收 #259 时实测）。
   * 同一个工作区内重开面板不受影响（workspaceId 没变）。
   */
  const filesWorkspaceId = filesView?.workspaceId ?? null;
  useEffect(() => {
    setFileOpenRequest(null);
  }, [filesWorkspaceId]);

  const focusRun = focus.status.kind === "off" ? null : focus.status.run;

  /**
   * 睡眠即结束专注（用户 2026-10-28 裁决，判定在 focus-shell.ts）：系统 suspend 时
   * 把在跑的一轮直接收掉，左栏落到同一工作区的浏览态。不走 ending 的问询——人
   * 已睡着，问句没人答，醒来也不该弹浮层；不发到点通知（没到 done）；睡眠期间
   * 不调模型，所以也不跑小结。end() 同时作废在途的小结结果（use-focus 的代次）。
   *
   * 依赖只盯真正用到的两样：相位（判定读它）与 end（稳定引用，useCallback([])）。
   * 不能写 [focus]——useFocus 每次渲染都返回新对象，App 每渲染一次就会退订重订
   * 一次 IPC（审查指出）；写 [focus.status, focus.end] 只在相位变化时重订。
   */
  const focusStatus = focus.status;
  const focusEnd = focus.end;
  useEffect(
    () =>
      api.focus.onSuspend(() => {
        const action = focusSuspendActionOf(focusStatus);
        if (action === null) return;
        setWsBrowse(action.workspaceId);
        focusEnd();
      }),
    [focusStatus, focusEnd],
  );

  /**
   * 到点那一拍要响的事：提示音（设置可关）、窗口不在前台时发系统通知、收起的
   * 侧栏展开（星云要在左下角说话——原型待定 10 的默认做法）。依赖只盯 kind：
   * done 只发生一次，延长不会重响。
   */
  useEffect(() => {
    if (focus.status.kind !== "done" || focusRun === null) return;
    if (completionSound) playChime();
    if (
      isWindowInactive({
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
      })
    ) {
      const wsName =
        workspaces.find((item) => item.id === focusRun.workspaceId)?.name ?? t.focus.deletedWorkspace;
      void api.focus.notifyDone({
        title: t.focus.notifyTitle,
        body: t.focus.notifyBody(Math.round(focusRun.totalMs / 60_000), wsName),
      });
    }
    expandSidebar();
    // settle 那拍读到的闭包值就是真值（workspaces / t / 开关都在本渲染里）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus.status.kind]);

  const focusWorkspaceName =
    (focusRun !== null ? workspaces.find((item) => item.id === focusRun.workspaceId)?.name : undefined) ??
    t.focus.deletedWorkspace;

  /** 卡上的「再专注一轮」：先复位这一轮，再按上一次的档位把开始浮层重新打开 */
  const again = useCallback((): void => {
    if (focusRun === null) return;
    const preset = focus.lastPreset ?? { workspaceId: focusRun.workspaceId, minutes: 25 };
    focus.end();
    openFocusPickerAt(preset.workspaceId, preset.minutes);
  }, [focus, focusRun, openFocusPickerAt]);

  const control = (
    <FocusControl
      status={focus.status}
      workspaces={workspaces}
      defaultWorkspaceId={defaultWorkspaceId}
      preset={focus.lastPreset}
      pickerRequest={focusPickerRequest}
      sessionCountOf={(id) =>
        rootSessions(sessions).filter((meta) => meta.workspaceId === id && !meta.archived).length
      }
      onStart={startFocus}
      onExtend={focus.extend}
      onEarlyEnd={focus.earlyEnd}
      onEnd={focus.end}
    />
  );

  const say = (
    <FocusSay
      view={focusBubbleOf(focus.status, focus.summary, sayDismissed)}
      onDismiss={() => setSayDismissed(true)}
      onRequestSummary={focus.requestSummary}
      onEnd={focus.end}
    />
  );

  const card = (
    <FocusCardLayer
      status={focus.status}
      run={focusRun}
      summary={focus.summary}
      closed={summaryCardClosed}
      workspaceName={focusWorkspaceName}
      onRetry={focus.retrySummary}
      onEnd={focus.end}
      onAgain={again}
      onClose={() => setSummaryCardClosed(true)}
    />
  );

  return {
    status: focus.status,
    control,
    say,
    card,
    filesView,
    fileOpen: fileOpenRequest,
    quiet: focus.status.kind === "run",
    browseWorkspace,
    exitBrowse,
    startAt: openFocusPickerAt,
    openFile: openFocusFile,
  };
}
