/**
 * 每日用量的 IPC —— 四层契约的第 2 层。
 *
 *   usage:week    renderer 拉最近 7 天（回填在途时可能是全 0，跑完推真值）
 *   usage:event   账本每次变化（模型调用落账 / 回填完成）推一份完整快照
 *
 * 启动**不阻塞**：load + backfill 异步跑，注册即返回——初始拉取先拿到空账，
 * 界面画空格；回填完 onChange 推一份真值把格子填上。
 */
import { ipcMain } from "electron";
import { mainWindows } from "../window/main-windows.ts";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { UsageWeekEvent } from "../../shared/usage.ts";
import type { UsageLedger, UsageBackfillSource } from "./ledger.ts";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { PriceChartData } from "../../shared/price-chart.ts";
import type { Provider } from "../../shared/provider.ts";
import { buildPriceChart } from "./price-chart.ts";
import type { TaskBackfillSource, TaskLedger } from "./task-ledger.ts";
import arenaSnapshot from "./arena-snapshot.json" with { type: "json" };

export function registerUsageIpc(ledger: UsageLedger, sessions: UsageBackfillSource): void {
  ipcMain.handle(ipcChannels.usageWeek, () => ledger.week());

  ledger.onChange((days) => {
    const event: UsageWeekEvent = { days };
    for (const window of mainWindows.list()) {
      window.webContents.send(ipcChannels.usageEvent, event);
    }
  });

  void ledger
    .load()
    .then(() => ledger.backfill(sessions))
    .catch((error: unknown) => {
      console.error("[usage] 日账本装载 / 回填失败，下次启动重试", error);
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
