/**
 * 会话的 IPC —— 四层契约的第 2 层。
 * 落盘那一半在 `recorder.ts`：它是纯模块，抽出去是为了能被 `node --test` 直接测。
 */
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { writeFile } from "node:fs/promises";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  parseSessionUnread,
  transcriptToMarkdown,
  type CarryoverStatus,
  type SessionCompletion,
  type SessionOlderPage,
} from "../../shared/session.ts";
import {
  MODEL_ASSIGN_TARGET_GONE_CODE,
  findDeadTarget,
  groupUnassignedModels,
  parseModelAssignEntries,
  planAssignments,
  type ModelAssignGroups,
  type ModelAssignRunResult,
} from "../../shared/model-assign.ts";
import type { AgentHost } from "../agent/host.ts";
import type { CarryoverStore } from "./carryover-store.ts";
import { executeRevert, executeUndo, fileTurnsIn, planRevert, planUndo } from "./revert.ts";
import type { RevertFileOutcome } from "../../shared/revert.ts";
import { isWebPageFile } from "../../shared/files.ts";
import type { SessionRecord } from "../../shared/session.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SessionStore } from "./store.ts";

export function registerSessionIpc(
  store: SessionStore,
  onSessionRemoved: ((id: string) => void) | undefined,
  agentHost: AgentHost,
  carryovers: CarryoverStore,
  /** 给导入的会话分配模型：执行前校验目标 provider / 模型仍存在（model-assign.ts） */
  providers: ProviderStore,
  /** 轮尾产物在内置浏览器「你的」tab 打开（BrowserSandbox.openLocalFile） */
  openArtifactInBrowser: (path: string) => Promise<void>,
  /** 会话回退成功后的意图系统作度钩子（实验功能 intent-system；undefined = 不启用） */
  onReverted?: (sessionId: string, turnIds: readonly string[]) => Promise<void>,
): void {
  ipcMain.handle(ipcChannels.sessionList, () => store.list());
  // 打开会话：**只回尾窗**（主进程仍全量读 + 折叠，见 store.loadWindow 的注释）——
  // 25MB / 2948 条的会话一次过 IPC 是瓶颈所在，renderer 也无力一次渲染完
  ipcMain.handle(ipcChannels.sessionLoad, (_event, id: string) => store.loadWindow(id));
  // 更早的一页：滚动触顶时 renderer 拿窗口第一条记录的 id 来拉（before 就是它）
  ipcMain.handle(
    ipcChannels.sessionLoadOlder,
    (_event, id: string, before: string, limit: number): Promise<SessionOlderPage> =>
      store.loadOlder(id, before, limit),
  );

  // —— 给导入的会话分配模型（设置 › 服务商，契约在 shared/model-assign.ts） ——
  ipcMain.handle(ipcChannels.modelAssignGroups, async (): Promise<ModelAssignGroups> =>
    groupUnassignedModels(await store.list()),
  );
  ipcMain.handle(
    ipcChannels.modelAssignRun,
    async (_event, raw: unknown): Promise<ModelAssignRunResult> => {
      const entries = parseModelAssignEntries(raw);
      // 写入前再校验一次：目标 provider 与模型仍存在（预览到确认之间可能被删）。
      // 整批拒绝而不是跳过那一条——半截结果会让人以为全配上了
      const dead = findDeadTarget(
        entries,
        (await providers.list()).flatMap((provider) =>
          provider.models.declared.map((model) => ({ providerId: provider.id, modelId: model.id })),
        ),
      );
      if (dead !== null) throw new Error(MODEL_ASSIGN_TARGET_GONE_CODE + dead.model);
      // 会话侧按当下的盘算：还是占位且原模型名在清单里的才分配；写入时 store
      // 再核一次占位——期间被用户改过的自然跳过（skipped）
      let assigned = 0;
      let skipped = 0;
      for (const plan of planAssignments(await store.list(), entries)) {
        if (await store.assignModel(plan.id, plan.providerId, plan.modelId)) assigned += 1;
        else skipped += 1;
      }
      return { assigned, skipped };
    },
  );

  ipcMain.handle(ipcChannels.sessionRename, (_event, id: string, title: string) =>
    store.rename(id, title),
  );
  ipcMain.handle(ipcChannels.sessionDelete, async (_event, id: string) => {
    // 先停事件源再删文件：顺序反了的话，runtime 里还活着的会话会继续喷事件，
    // record() 虽有 meta 守卫不会重建文件，但那一轮里事件还是白跑。
    // 级联删（子会话 2026-09-22）：子会话是母会话的附属物，删母连带删子——
    // 先停全部后代 + 自己在 runtime 里的活跑轮（onSessionRemoved = disposeSession，
    // 它的 dispose 会 abort 在跑的轮），store.remove 自己再级联删文件。
    for (const descendantId of await store.descendants(id)) {
      onSessionRemoved?.(descendantId);
    }
    onSessionRemoved?.(id);
    await store.remove(id);
  });
  // 工作台现状：删除确认项要把「里面有几个文件」说出来（提示后删）。
  // 按需现算，见 store.workbenchStat
  // 看大图读原图：引用的格式校验在 store.readOriginal（它拼路径，校验挨着拼的地方）
  ipcMain.handle(ipcChannels.sessionAttachment, (_event, ref: unknown) => store.readOriginal(ref));
  ipcMain.handle(ipcChannels.sessionWorkbenchStat, (_event, id: string) =>
    store.workbenchStat(id),
  );
  ipcMain.handle(ipcChannels.sessionPin, (_event, id: string, pinned: boolean) =>
    store.setPinned(id, pinned),
  );
  ipcMain.handle(ipcChannels.sessionStar, (_event, id: string, starred: boolean) =>
    store.setStarred(id, starred),
  );
  ipcMain.handle(
    ipcChannels.sessionSetCompletion,
    (_event, id: string, completion: SessionCompletion) => store.setCompletion(id, completion),
  );
  // 意图召回的会话级开关（实验功能 intent-system）：只落 meta，下一轮生效
  ipcMain.handle(
    ipcChannels.sessionSetIntentEnabled,
    (_event, id: string, enabled: boolean) => store.setIntentEnabled(id, enabled),
  );
  ipcMain.handle(ipcChannels.sessionUnread, (_event, id: string, unread: unknown) =>
    // 载荷在入口就洗：坏形状当已读（null）写回，不裸存进 meta
    store.setUnread(id, parseSessionUnread(unread)),
  );
  // —— 遗留事项（收尾仪式）三通道。store 铸 id/status/时间戳，renderer 不猜 ——
  ipcMain.handle(ipcChannels.carryoverList, () => carryovers.list());
  ipcMain.handle(
    ipcChannels.carryoverSetStatus,
    (_event, id: string, status: CarryoverStatus) => carryovers.setStatus(id, status),
  );
  ipcMain.handle(ipcChannels.sessionArchive, (_event, id: string, archived: boolean) =>
    store.setArchived(id, archived),
  );
  ipcMain.handle(
    ipcChannels.sessionMove,
    (_event, id: string, workspaceId: string | null) => store.move(id, workspaceId),
  );

  /**
   * 从某条 agent 回答另起一支（C-2）。三步有序：先在本地算前缀与角色序列（store），
   * 再让 pi 把它的本子裁一份新文件（agent 进程，对账守卫在那边），最后才把新会话
   * 落盘——中途失败最多留一个孤儿 pi 文件，不出现「看得见历史但 pi 没有前文」的
   * 半残会话。
   */
  ipcMain.handle(
    ipcChannels.sessionBranch,
    async (_event, id: string, anchorItemId: string): Promise<string> => {
      const plan = await store.prepareBranch(id, anchorItemId);
      const piSessionFile = await agentHost.branchSession(
        {
          sourcePiSessionFile: plan.sourcePiSessionFile,
          cwd: plan.meta.cwd,
          roles: plan.roles,
        },
        plan.newId,
      );
      await store.commitBranch(plan, piSessionFile);
      return plan.newId;
    },
  );

  // —— 会话回退 / 单轮撤销（revert.ts）：计划与执行分两条通道，确认框只读计划 ——
  ipcMain.handle(ipcChannels.sessionRevertPlan, (_event, id: string, targetMessageId: string) =>
    planRevert(store, id, targetMessageId),
  );
  ipcMain.handle(
    ipcChannels.sessionRevert,
    async (_event, id: string, targetMessageId: string): Promise<RevertFileOutcome[]> => {
      // 被回退轮次的 user 记录 id（intent-lab /invalidate 要作度的 turnId 就是它们）。
      // 回退前先取——executeRevert 落 RevertRecord 后 readLog 就是折叠后的新世界
      let invalidatedTurnIds: string[] = [];
      try {
        const detail = await store.load(id);
        if (detail !== null) {
          const index = detail.transcript.findIndex(
            (record) => record.id === targetMessageId && record.role === "user",
          );
          if (index >= 0) {
            invalidatedTurnIds = detail.transcript
              .slice(index)
              .filter((record): record is Extract<SessionRecord, { role: "user" }> => record.role === "user")
              .map((record) => record.id);
          }
        }
      } catch {
        invalidatedTurnIds = [];
      }
      const outcomes = await executeRevert({ store, host: agentHost }, id, targetMessageId);
      // 意图系统（实验）：被回退轮次的 QA 送 intent-lab 作度（fire-and-forget，
      // 绝不动回退本身；开关关 / 连不上都只记日志）。回调由 index.ts 注入
      if (onReverted !== undefined && invalidatedTurnIds.length > 0) {
        void onReverted(id, invalidatedTurnIds);
      }
      return outcomes;
    },
  );
  ipcMain.handle(ipcChannels.sessionUndoPlan, (_event, id: string, turnId: string) =>
    planUndo(store, id, turnId),
  );
  ipcMain.handle(ipcChannels.sessionUndo, (_event, id: string, turnId: string) =>
    executeUndo({ store, host: agentHost }, id, turnId),
  );

  /**
   * 轮尾产物的两个打开方式。白名单是「这条会话的文件账里记过的路径」
   * （changes 或旁路 webArtifacts 都算——后者也是本轮产出的网页，只是不经
   * write / edit）——面板/卡片不是通用文件浏览器，账上没有的路径一概不碰
   * （同 fs:open 的纪律，但根不是目录树而是会话自己的账本）。内置浏览器再叠加
   * isWebPageFile。
   */
  const knownArtifact = async (id: string, path: string): Promise<void> => {
    const turns = fileTurnsIn(await store.readRawLog(id));
    const known = turns.some(
      (turn) =>
        turn.changes.some((change) => change.path === path) ||
        (turn.webArtifacts?.includes(path) ?? false),
    );
    if (!known) throw new Error(`That file is not in this task's change record: ${path}`);
  };
  ipcMain.handle(ipcChannels.sessionOpenArtifactInBrowser, async (_event, id: string, path: string) => {
    await knownArtifact(id, path);
    if (!isWebPageFile(path)) {
      throw new Error(`Only web pages (html/svg) open in the built-in browser: ${path}`);
    }
    await openArtifactInBrowser(path);
  });
  // 第二个出口是「打开文件所在位置」而不是「默认浏览器」（用户 2026-10-01 裁决）：
  // 默认浏览器与内置浏览器是同一件事的两个版本，定位文件才是另一种需要（拷走、拖进别的应用）
  ipcMain.handle(ipcChannels.sessionRevealArtifact, async (_event, id: string, path: string) => {
    await knownArtifact(id, path);
    shell.showItemInFolder(path);
  });

  /**
   * 导出成 Markdown。**渲染在主进程做**：`transcriptToMarkdown` 在 shared，
   * 与「复制整条对话」是同一份实现；写文件必须在主进程（renderer 在 sandbox 里）。
   */
  ipcMain.handle(ipcChannels.sessionExport, async (event, id: string): Promise<string | null> => {
    const detail = await store.load(id);
    if (detail === null) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: `${safeFileName(detail.meta.title || id)}.md` };
    const result = await (window
      ? dialog.showSaveDialog(window, options)
      : dialog.showSaveDialog(options));
    if (result.canceled || result.filePath === undefined) return null;
    await writeFile(result.filePath, transcriptToMarkdown(detail.transcript, detail.meta), "utf8");
    return result.filePath;
  });
}

/**
 * 标题 → 能当文件名的东西。**这是安全检查，不是美观**：标题是用户输入的，
 * 里面的 `/` 会被当成路径分隔符，`..` 会往上跳一级。
 */
function safeFileName(title: string): string {
  return title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+/, "").slice(0, 80) || "task";
}
