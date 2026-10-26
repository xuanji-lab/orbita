/**
 * 专注模式的 IPC —— 四层契约的第 2 层。
 *
 * 三个通道：U / M 走 git-source 的同一套只读 runner（不另起一套 git 调用），
 * 系统通知是 Electron 的 Notification（renderer sandbox 里没有），收工小结把
 * 主进程归拢的素材交给 agent 进程里的家务活模型（独立小调用，同
 * classifyGreetings 的通道）。路径策略在主进程：renderer 只传 workspaceId，
 * 路径由 WorkspaceStore 解——不信 renderer 传来的任何路径。
 */
import { BrowserWindow, Notification, ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  FocusChangeEntry,
  FocusChanges,
  FocusSummaryRequest,
  FocusSummaryResult,
} from "../../shared/focus.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { AgentHost } from "../agent/host.ts";
import { resolveProviderSecrets } from "../agent/ipc.ts";
import { gitWorkdirChanges, realGitRunner } from "../review/git-source.ts";
import { ExcerptStore } from "../excerpt/store.ts";
import { buildSummaryMaterial, buildSummaryPrompt, pickActiveSessions } from "./summary-source.ts";
import { normalizeFocusNotify } from "./notify.ts";

export function registerFocusIpc(
  workspaces: WorkspaceStore,
  sessions: SessionStore,
  providers: ProviderStore,
  settings: SettingsStore,
  host: AgentHost,
  excerpts: ExcerptStore,
): void {
  ipcMain.handle(ipcChannels.focusChanges, async (_event, raw: unknown): Promise<FocusChanges> => {
    if (typeof raw !== "string") return { kind: "error", message: "invalid focus changes request" };
    const workspace = (await workspaces.list()).find((item) => item.id === raw);
    if (workspace === undefined) {
      return { kind: "error", message: `工作区 ${raw} 不存在（可能刚被移除）` };
    }
    try {
      return await gitWorkdirChanges(realGitRunner, workspace.path);
    } catch (cause) {
      return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  ipcMain.handle(ipcChannels.focusNotifyDone, async (_event, raw: unknown): Promise<void> => {
    // renderer 传什么都不可信：非对象 / 空标题 / 空正文直接不发（超长截断）
    const req = normalizeFocusNotify(raw);
    if (req === null) return;
    // 时间到的提醒是「把人叫回来」：点通知聚焦主窗口（多窗口时聚焦最近使用的那张——
    // 专注是单窗口里的事，第一张就是我们自己的）
    const notice = new Notification({ title: req.title, body: req.body });
    notice.on("click", () => {
      const [first] = BrowserWindow.getAllWindows();
      first?.focus();
    });
    notice.show();
  });

  ipcMain.handle(ipcChannels.focusSummarize, async (_event, raw: unknown): Promise<FocusSummaryResult> => {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as FocusSummaryRequest).startedAt !== "number" ||
      typeof (raw as FocusSummaryRequest).until !== "number" ||
      typeof (raw as FocusSummaryRequest).workspaceId !== "string"
    ) {
      return { kind: "error", message: "invalid focus summary request" };
    }
    const req = raw as FocusSummaryRequest;
    try {
      // 素材一：时段内有活动的会话（用户裁决：所有会话，不限所选工作区）
      const active = pickActiveSessions(await sessions.list(), req.startedAt);
      const workspaceList = await workspaces.list();
      const workspace = workspaceList.find((item) => item.id === req.workspaceId) ?? null;
      const inputs = await Promise.all(
        active.map(async (meta) => ({
          meta,
          records: (await sessions.load(meta.id))?.transcript ?? [],
        })),
      );
      // 素材二：所选工作区此刻的 U / M（git 只读；拿不到就当没有，不拦小结）
      let changeEntries: FocusChangeEntry[] = [];
      let branch: string | null = null;
      if (workspace !== null) {
        const changes = await gitWorkdirChanges(realGitRunner, workspace.path);
        if (changes.kind === "ok") {
          changeEntries = changes.entries;
          branch = changes.branch;
        }
      }
      const material = buildSummaryMaterial(inputs, {
        workspaceNames: new Map(workspaceList.map((item) => [item.id, item.name])),
        workspaceName: workspace?.name ?? null,
        branch,
        changeEntries,
        startedAt: req.startedAt,
        until: req.until,
        // 摘抄不在会话记录里（独立存储），拼回素材：只取活动会话里的、窗口内摘的
        excerpts: (await excerpts.list())
          .filter((excerpt) => active.some((meta) => meta.id === excerpt.sessionId))
          .map((excerpt) => ({ sessionId: excerpt.sessionId, text: excerpt.text, createdAt: excerpt.createdAt })),
      });
      if (!material.hasActivity) return { kind: "empty", reason: "no-activity" };

      // 模型：家务活模型，缺席回退到上次使用的（lastUsed）——都没有就诚实说没有
      const appSettings = await settings.read();
      const lastUsed =
        appSettings.lastUsed?.providerId !== undefined && appSettings.lastUsed?.modelId !== undefined
          ? { providerId: appSettings.lastUsed.providerId, modelId: appSettings.lastUsed.modelId }
          : undefined;
      const choice = appSettings.choreModel ?? lastUsed;
      if (choice === undefined) return { kind: "empty", reason: "no-model" };

      const provider = await resolveProviderSecrets(providers, choice.providerId);
      const bullets = await host.summarizeFocus(provider, choice.modelId, buildSummaryPrompt(material, req.startedAt, req.until));
      return {
        kind: "ok",
        bullets,
        sessionsRead: material.sessions.length,
        modelLabel: `${choice.providerId}/${choice.modelId}`,
      };
    } catch (cause) {
      return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
  });
}
