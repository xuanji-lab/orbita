/**
 * 收尾的 IPC —— 四层契约的第 2 层（契约在 shared/wrapup.ts）。
 *
 *   session:wrapup-plan     这次要扫的轮次与各轮用量（扫描 prompt 与卡片上的花费都吃它）
 *   session:wrapup-revise   按用户一句话改清单：家务活模型一次独立小调用，**不进会话**——
 *                           对话流里不多出一轮机器提问，意图系统与任务账本也就碰不到它
 *   session:wrapup-confirm  确认：收尾记录进 meta、留下的事进遗留清单、会话标完成、
 *                           这条会话在接着做的遗留事项标为做完
 */
import { readFile } from "node:fs/promises";
import { ipcMain } from "electron";
import { ipcChannels, type BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { CarryoverDraft } from "../../shared/session.ts";
import type {
  SessionWrapup,
  WrapupConfirmInput,
  WrapupPlan,
  WrapupReviseInput,
  WrapupReviseResult,
} from "../../shared/wrapup.ts";
import { buildWrapupRevisePrompt, parseWrapupRevise, WRAPUP_REVISE_SYSTEM } from "../../shared/wrapup-scan.ts";
import type { AgentHost } from "../agent/host.ts";
import { resolveProviderSecrets } from "../agent/ipc.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SettingsStore } from "../settings/store.ts";
import { officialRatesResolver } from "../usage/ipc.ts";
import { piThinkingTimeline } from "../usage/task-cost.ts";
import type { CarryoverStore } from "./carryover-store.ts";
import type { SessionStore } from "./store.ts";
import { wrapupOf, wrapupPlanOf } from "./wrapup.ts";

export function registerWrapupIpc(deps: {
  sessions: SessionStore;
  carryovers: CarryoverStore;
  providers: ProviderStore;
  settings: SettingsStore;
  host: AgentHost;
  catalog: () => Promise<BuiltinProvider[]>;
  /** 确认落定后（账本记账用） */
  onConfirmed?: (sessionId: string, wrapup: SessionWrapup) => void;
}): void {
  const planOf = async (id: string): Promise<WrapupPlan | null> => {
    const detail = await deps.sessions.load(id);
    if (detail === null) return null;
    const meta = detail.meta;
    // 没盖档的旧记录才要 pi 时间线（同任务账本回填）
    const needsTimeline = detail.transcript.some(
      (r) => r.role === "assistant" && r.usage !== undefined && !("thinkingLevel" in r),
    );
    const piText =
      needsTimeline && meta.piSessionFile !== null ? await readFile(meta.piSessionFile, "utf8").catch(() => null) : null;
    const [providers, catalog] = await Promise.all([deps.providers.load(), deps.catalog()]);
    return wrapupPlanOf({
      records: detail.transcript,
      meta,
      timeline: piText === null ? [] : piThinkingTimeline(piText),
      rates: officialRatesResolver(providers, catalog),
    });
  };

  ipcMain.handle(ipcChannels.sessionWrapupPlan, (_event, id: string) => planOf(id));

  ipcMain.handle(
    ipcChannels.sessionWrapupRevise,
    async (_event, id: string, input: WrapupReviseInput): Promise<WrapupReviseResult> => {
      try {
        const detail = await deps.sessions.load(id);
        if (detail === null) return { ok: false, error: "task not found" };
        const plan = await planOf(id);
        // 家务活模型；没配就用会话自己的模型（与收尾扫描同一条退路）
        const choice = (await deps.settings.read()).choreModel ?? {
          providerId: detail.meta.providerId,
          modelId: detail.meta.modelId,
        };
        const provider = await resolveProviderSecrets(deps.providers, choice.providerId);
        const text = await deps.host.choreComplete(
          provider,
          choice.modelId,
          WRAPUP_REVISE_SYSTEM,
          buildWrapupRevisePrompt({
            turns: plan?.turns ?? [],
            sinceTurn: input.sinceTurn,
            lastTurn: input.lastTurn,
            draft: input.draft,
            feedback: input.feedback,
          }),
        );
        const parsed = parseWrapupRevise(text, { sinceTurn: input.sinceTurn, lastTurn: input.lastTurn });
        if (parsed === null) {
          console.warn(`[wrapup] 改写回复读不懂，原文前 300 字：${JSON.stringify(text.slice(0, 300))}`);
          return { ok: false, error: "unreadable" };
        }
        return { ok: true, draft: parsed.draft, summary: parsed.summary };
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  );

  ipcMain.handle(
    ipcChannels.sessionWrapupConfirm,
    async (_event, id: string, input: WrapupConfirmInput): Promise<void> => {
      const plan = (await planOf(id)) ?? { sinceTurn: input.throughTurn + 1, lastTurn: input.throughTurn, turns: [] };
      const wrapup = wrapupOf(plan, input, Date.now());
      const drafts: CarryoverDraft[] = input.carryovers.filter((draft) => draft.title.trim() !== "");
      // 遗留事项先落：会话标了完成而清单丢了，比反过来更糟（再点完成还能重扫）
      await deps.carryovers.append(id, drafts);
      const result = await deps.sessions.confirmWrapup(id, wrapup, drafts.length > 0 ? "done_with_todos" : "done");
      if (result === null) throw new Error(`session ${id} not found`);
      for (const carryoverId of result.resumed) await deps.carryovers.setStatus(carryoverId, "done");
      deps.onConfirmed?.(id, wrapup);
    },
  );
}
