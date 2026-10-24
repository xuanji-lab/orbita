/**
 * 每日用量的 IPC —— 四层契约的第 2 层。
 *
 *   usage:week    renderer 拉最近 7 天（回填在途时可能是全 0，跑完推真值）
 *   usage:event   账本每次变化（模型调用落账 / 回填完成）推一份完整快照
 *
 * 启动**不阻塞**：load + backfill 异步跑，注册即返回——初始拉取先拿到空账，
 * 界面画空格；回填完 onChange 推一份真值把格子填上。
 */
import { readFile } from "node:fs/promises";
import { ipcMain } from "electron";
import { mainWindows } from "../window/main-windows.ts";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { UsageWeekEvent } from "../../shared/usage.ts";
import type { UsageLedger, UsageBackfillSource } from "./ledger.ts";
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { PriceChartData } from "../../shared/price-chart.ts";
import type { Provider } from "../../shared/provider.ts";
import { buildPriceChart, type PriceChartSources, type SessionScan } from "./price-chart.ts";
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
 * 「价格 · 能力图」（usage:price-chart）：每次请求现算——读全部非导入会话、pi 本子的档位
 * 时间线、服务商声明与 pi 目录（目录要等 agent 进程报上来，host.listBuiltins 自带 15s 兜底）。
 * 历史会话丢了多少条（pi 时间线与锚点对不上）落一条日志，验收与 PR 描述用。
 */
export function registerPriceChartIpc(deps: {
  sessions: PriceChartSources["sessions"];
  providers: () => Promise<Provider[]>;
  catalog: () => Promise<BuiltinProvider[]>;
}): void {
  const sources: PriceChartSources = {
    sessions: deps.sessions,
    providers: deps.providers,
    catalog: deps.catalog,
    readPiFile: (path) => readFile(path, "utf8").catch(() => null),
  };
  // 按会话的扫描缓存：只活在内存里，首次请求读全部会话，之后只重读 updatedAt 变过的
  const cache = new Map<string, SessionScan>();
  ipcMain.handle(ipcChannels.usagePriceChart, async (): Promise<PriceChartData> => {
    const started = Date.now();
    const { data, stats } = await buildPriceChart(sources, arenaSnapshot, cache);
    console.error(
      `[price-chart] ${stats.sessions} 条会话，其中 ${stats.untrusted} 条的历史档位对不上（未盖章部分不计），` +
        `${data.profile.taskCount} 个任务，用时 ${Date.now() - started}ms`,
    );
    return data;
  });
}
