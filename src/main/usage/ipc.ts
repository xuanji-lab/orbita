/**
 * 用量的 IPC —— 四层契约的第 2 层。侧栏用量格与价格 · 能力图吃的是同一本任务账本（task-ledger.ts）。
 *
 *   usage:week         renderer 拉最近 7 天（每天的合计、按型号的分布、折算花费）
 *   usage:event        账本每次变化（模型调用落账 / 回填完成）推一份完整 7 天快照
 *   usage:price-chart  价格 · 能力图
 *
 * 启动**不阻塞**：账本的 load + backfill 异步跑（startTaskLedger）；首次拉取若赶上回填在途，等它落定。
 */
import { ipcMain } from "electron";
import { mainWindows } from "../window/main-windows.ts";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { dateKeysBack, type UsageDayTotal, type UsageWeekEvent } from "../../shared/usage.ts";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { PriceChartData } from "../../shared/price-chart.ts";
import type { ModelCostDecl, Provider } from "../../shared/provider.ts";
import { boardIndexOf, type BoardRow } from "./arena-board.ts";
import { usageDays } from "./day-summary.ts";
import { modelGroups } from "./model-groups.ts";
import { createPriceChartSource, type PriceChartSource, type PriceChartSourceDeps } from "./price-chart-source.ts";
import type { TaskBackfillSource, TaskLedger } from "./task-ledger.ts";
import arenaSnapshot from "./arena-snapshot.json" with { type: "json" };

/** 侧栏显示的天数（含今天） */
const USAGE_WEEK_DAYS = 7;

/** 快照里出现过的全部榜单基名（型号口径的兜底匹配要它），建一次 */
const boardIndex = boardIndexOf(
  Object.values(arenaSnapshot.categories).map((category) =>
    category.rows.flatMap((row): BoardRow[] => {
      const [name, score, lower, upper, samples, rank] = row;
      return typeof name === "string" &&
        typeof score === "number" &&
        typeof lower === "number" &&
        typeof upper === "number" &&
        typeof samples === "number" &&
        typeof rank === "number"
        ? [[name, score, lower, upper, samples, rank]]
        : [];
    }),
  ),
);

/**
 * （型号，服务商）→ 官方单价：与侧栏用量格、价格 · 能力图同一个型号口径（model-groups）。
 * 收尾卡片给每件做完的事标「≈ 官方价花费」用的就是它。
 */
export function officialRatesResolver(
  providers: readonly Provider[],
  catalog: readonly BuiltinProvider[],
): (modelId: string, providerId: string) => ModelCostDecl | null {
  const models = modelGroups(providers, catalog, boardIndex);
  return (modelId, providerId) => models.of(modelId, providerId).rates;
}

/**
 * 侧栏用量格（usage:week / usage:event）：从任务账本按「天 × 型号」汇总（day-summary.ts）。
 * 每天的合计与改之前的日账本口径相同（day-summary.test.ts 守着）；悬停一格时按型号列明细与折算花费。
 */
export function registerUsageIpc(deps: {
  ledger: TaskLedger;
  providers: () => Promise<Provider[]>;
  catalog: () => Promise<BuiltinProvider[]>;
}): void {
  const week = async (): Promise<UsageDayTotal[]> => {
    await deps.ledger.settled();
    const [providers, catalog] = await Promise.all([deps.providers(), deps.catalog()]);
    return usageDays({
      dates: dateKeysBack(USAGE_WEEK_DAYS, Date.now()),
      tasks: deps.ledger.tasks(),
      intent: deps.ledger.intentByDay(),
      models: modelGroups(providers, catalog, boardIndex),
    });
  };
  ipcMain.handle(ipcChannels.usageWeek, week);
  deps.ledger.onChange(() => {
    void week()
      .then((days) => {
        const event: UsageWeekEvent = { days };
        for (const window of mainWindows.list()) window.webContents.send(ipcChannels.usageEvent, event);
      })
      .catch((error: unknown) => console.error("[usage] 用量格推送失败", error));
  });
}

/**
 * 任务账本（价格 · 能力图的数据面）开机：读盘，升级后第一次启动回填一次。不阻塞启动；
 * 回填流式读、按 8ms 时间片让事件循环（task-ledger.ts「回填的代价」）。recorder 在这之前就可能来记账——都排在同一条写入链上，
 * load 先跑。
 */
export function startTaskLedger(ledger: TaskLedger, source: TaskBackfillSource): void {
  void ledger
    .load()
    .then(() => ledger.backfill(source))
    .then((stats) => {
      if (stats === null) return;
      console.error(
        `[task-ledger] 回填完成：${stats.sessions} 条有用量的原生会话，其中 ${stats.untrustedSessions} 条的` +
          `历史档位对不上（记成档不可考，不进图），${ledger.tasks().length} 个任务段，用时 ${stats.ms}ms`,
      );
    })
    .catch((error: unknown) => {
      console.error("[task-ledger] 任务账本装载 / 回填失败，下次启动重试", error);
    });
}

/**
 * 「价格 · 能力图」（usage:price-chart）：数据来自 price-chart-source.ts 的那份带 memo 的来源
 * （agent 的 model_costs 工具读的是同一份，见 main/index.ts）。
 */
export function priceChartSourceOf(deps: Omit<PriceChartSourceDeps, "snapshot">): PriceChartSource {
  return createPriceChartSource({ ...deps, snapshot: arenaSnapshot });
}

export function registerPriceChartIpc(source: PriceChartSource): void {
  ipcMain.handle(ipcChannels.usagePriceChart, (): Promise<PriceChartData> => source());
}
