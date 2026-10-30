/**
 * 「价格 · 能力图」数据的带 memo 来源 —— 设置页（usage:price-chart）与 agent 的 model_costs 工具
 * 共用这一份：同一本账、同一次计算、同一个 memo，工具给模型看的数字不会和设置页那张图对不上。
 * **纯模块**（不 import electron），可被 `node --test` 直接测。
 */
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { PriceChartData } from "../../shared/price-chart.ts";
import type { Provider } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { buildPriceChart, type ArenaSnapshot } from "./price-chart.ts";
import type { ChartTask } from "./task-cost.ts";
import type { TaskLedger } from "./task-ledger.ts";

export type PriceChartSource = () => Promise<PriceChartData>;

export interface PriceChartSourceDeps {
  /** 只用到这四个方法（测试里给假的就够） */
  ledger: Pick<TaskLedger, "settled" | "version"> & { chartTasks(childIds: ReadonlySet<string>): ChartTask[] };
  providers: () => Promise<Provider[]>;
  catalog: () => Promise<BuiltinProvider[]>;
  /** 会话清单：认哪些是子会话（子会话交回结果算一件做完的事） */
  sessions: () => Promise<SessionMeta[]>;
  snapshot: ArenaSnapshot;
}

/**
 * 只读任务账本 + 服务商声明 + pi 目录（目录要等 agent 进程报上来，host.listBuiltins 自带 15s 兜底），
 * 不扫会话。首次请求若赶上回填在途，等它落定。
 *
 * memo：账本版本、子会话数、目录条数、服务商声明（型号与费率）都没变就原样返回。设置页每挂载一次
 * 就请求一次（开发版的 StrictMode 还会挂两次），agent 每次派发前也会问一次，这一层让重复请求不再重算。
 */
export function createPriceChartSource(deps: PriceChartSourceDeps): PriceChartSource {
  let memo: { key: string; data: PriceChartData } | null = null;
  return async () => {
    const started = Date.now();
    await deps.ledger.settled();
    const [providers, catalog, sessions] = await Promise.all([deps.providers(), deps.catalog(), deps.sessions()]);
    const childIds = new Set(sessions.filter((meta) => meta.parentId !== undefined).map((meta) => meta.id));
    const key = [
      deps.ledger.version(),
      childIds.size,
      catalog.length,
      JSON.stringify(providers.map((p) => [p.id, p.kind, p.endpoint.api, p.models.declared])),
    ].join("|");
    if (memo?.key === key) {
      console.error(`[price-chart] 账本未变，直接返回上次的结果（${Date.now() - started}ms）`);
      return memo.data;
    }
    const data = await buildPriceChart(
      { tasks: async () => deps.ledger.chartTasks(childIds), providers: async () => providers, catalog: async () => catalog },
      deps.snapshot,
    );
    memo = { key, data };
    console.error(`[price-chart] 重算：${data.profile.taskCount} 个任务，用时 ${Date.now() - started}ms`);
    return data;
  };
}
