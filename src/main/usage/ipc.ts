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
import { buildPriceChart } from "./price-chart.ts";
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
 * 回填每扫完一条会话让一次事件循环。recorder 在这之前就可能来记账——都排在同一条写入链上，
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
 * 「价格 · 能力图」（usage:price-chart）：只读任务账本 + 服务商声明 + pi 目录（目录要等 agent
 * 进程报上来，host.listBuiltins 自带 15s 兜底），不扫会话。首次请求若赶上回填在途，等它落定。
 */
export function registerPriceChartIpc(deps: {
  ledger: TaskLedger;
  providers: () => Promise<Provider[]>;
  catalog: () => Promise<BuiltinProvider[]>;
}): void {
  /**
   * 上次算好的结果：账本版本、服务商声明（型号与费率）、目录条数都没变就原样返回。
   * 设置页每挂载一次就请求一次（开发版的 StrictMode 还会挂两次），这一层让重复请求不再重算。
   */
  let memo: { key: string; data: PriceChartData } | null = null;
  ipcMain.handle(ipcChannels.usagePriceChart, async (): Promise<PriceChartData> => {
    const started = Date.now();
    await deps.ledger.settled();
    const [providers, catalog] = await Promise.all([deps.providers(), deps.catalog()]);
    const key = [
      deps.ledger.version(),
      catalog.length,
      JSON.stringify(providers.map((p) => [p.id, p.kind, p.endpoint.api, p.models.declared])),
    ].join("|");
    if (memo?.key === key) {
      console.error(`[price-chart] 账本未变，直接返回上次的结果（${Date.now() - started}ms）`);
      return memo.data;
    }
    const data = await buildPriceChart(
      { tasks: async () => deps.ledger.tasks(), providers: async () => providers, catalog: async () => catalog },
      arenaSnapshot,
    );
    memo = { key, data };
    console.error(`[price-chart] 重算：${data.profile.taskCount} 个任务，用时 ${Date.now() - started}ms`);
    return data;
  });
}
