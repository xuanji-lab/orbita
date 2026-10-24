/**
 * 「价格 · 能力图」契约 —— IPC 四层的第 1 层。
 *
 *   usage:price-chart（agent-ipc.ts 的 ipcChannels.usagePriceChart）  renderer 拉一份现算的图数据
 *
 * 设置 › 模型服务的卡片墙下面那张散点图：**一个点 = 型号 × 思考档**，也就是一条榜单条目
 * （用户 2026-10-24：「其实只要看得出模型的数据就好了，不关心它有多少个服务商」）。同一个型号
 * 挂在几家服务商下、或用别名（k3 / kimi-k3）添加，都合成一个点，契约里因此没有服务商字段。
 *
 * - **纵轴：分数**。只用 Arena 官方 HF 数据集 `lmarena-ai/leaderboard-dataset`（CC-BY-4.0，
 *   须署名）——快照随应用分发（src/main/usage/arena-snapshot.json，带 revision）。arena.ai
 *   网页上的成本 / 单价 / Agent 其余三类分数条款禁止分发，一个数字都不进来。
 * - **横轴：用户自己的「每任务成本」**（美元，对数刻度）。一个任务 = 一个会话里同一型号 ×
 *   同一思考档的连续一段，中途换型号或换档就切开。实测点取这个型号 × 档在各服务商下全部任务
 *   花费的中位数；没用过的
 *   型号 × 档按官方单价 × 用户自己的 token 构成 × 任务 token 中位数估算（空心点）。
 *
 * 计算全在主进程（main/usage/price-chart.ts）：要读全部会话 JSONL 与 pi 本子，renderer
 * 只画。帕累托前沿由 renderer 按当前分类现算（纯函数，见 settings/price-chart-model.ts）。
 */
import type { ThinkingLevel } from "./thinking.ts";

/**
 * 六个分类，左右按钮按这个顺序循环；默认第一个（Agent 综合）。
 * agent = HF agent 子集（只有 overall 一类）；overall / coding / math / instruction_following =
 * text_style_control 子集（网页默认开 style control）；webdev = webdev 子集的 webdev 类。
 */
export const PRICE_CHART_CATEGORIES = [
  "agent",
  "overall",
  "coding",
  "webdev",
  "math",
  "instruction_following",
] as const;
export type PriceChartCategory = (typeof PRICE_CHART_CATEGORIES)[number];

/** 分数的单位：agent 是 net improvement（小数，0 = 平均水平，界面显示成 ±百分比）；其余是 Bradley-Terry 分 */
export type PriceChartScoreUnit = "net-improvement" | "rating";

/** 横轴的来历 */
export type PriceChartCostBasis =
  /** 用户会话里真实跑过：各段花费的中位数 */
  | "measured"
  /** 没用过：官方单价 × 用户自己的 token 构成 × 用户任务 token 中位数 */
  | "estimated"
  /** 没用过，且用户一个任务都没有：同一个公式，构成与中位数用内置参考画像 */
  | "reference";

export interface PriceChartPoint {
  /**
   * 代表这个型号的 Orbita id（显示名与头像按它取）：同一型号的几个别名里，取服务商列表里
   * 最先添加的那一个。
   */
  modelId: string;
  /** 榜单条目上的思考档；null = 榜单没标档（不猜档，横轴取这个型号全部档位的任务） */
  thinkingLevel: ThinkingLevel | null;
  /** 榜单原名（悬停显示出处用），如 `Claude Opus 5.5 (Max)` */
  boardName: string;
  /** 榜单括号里的 harness（`Codex Harness`）：分数是在别家外壳里跑出来的，悬停时写明 */
  harness?: string;
  score: number;
  scoreLower: number;
  scoreUpper: number;
  /** 每任务成本，美元 */
  cost: number;
  costBasis: PriceChartCostBasis;
  /** 实测点的样本数（任务段数）；估算点为 0 */
  samples: number;
  /**
   * 估算点上**不够门槛的实测**：这个型号 × 档跑过（各服务商合计）、但任务数不到门槛（见主进程
   * MIN_MEASURED_TASKS），点按估算画，悬停时另写一行「实测 n 个任务 $x」。实测点上缺席。
   */
  measured?: { cost: number; samples: number };
}

/** 已添加但不能画进图的型号（列在图下，按型号去重：别名合成一条，不缀服务商） */
export interface PriceChartModelRef {
  modelId: string;
}

/**
 * 用过、但当前分类的榜单没评这一档：这个型号在榜上有条目，只是没有这一档（用户用 Fable 5.1 的
 * 高档发过消息，榜单只评了最高档）。有花费、没有分数——**不借别的档的分、不画点**，单列一组。
 */
export interface PriceChartUnratedLevel {
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** 这一档的实测任务数（各服务商合计，不受实测门槛限制） */
  samples: number;
  /** 这一档各任务花费的中位数，美元 */
  cost: number;
  /** 榜单在当前分类评过的档（悬停 / 点开时写「榜单只评了：最高」） */
  ratedLevels: ThinkingLevel[];
}

export interface PriceChartCategoryData {
  category: PriceChartCategory;
  unit: PriceChartScoreUnit;
  /** 榜单发布日期（HF 的 leaderboard_publish_date） */
  publishDate: string;
  points: PriceChartPoint[];
  /** 当前分类的榜单上查不到的已添加型号 */
  unranked: PriceChartModelRef[];
  /** 上了榜、但既没有实测花费也找不到官方单价，横轴没法定：列出来提示去填费率 */
  unpriced: PriceChartModelRef[];
  /** 用过、但榜单没评的档（按型号 × 档去重；整个型号不在榜上的进 unranked，两组不重复） */
  unratedLevels: PriceChartUnratedLevel[];
}

/** 估算用的 token 画像：构成是占比（四项和为 1），medianTaskTokens 是全部任务 token 量的中位数 */
export interface PriceChartProfile {
  taskCount: number;
  medianTaskTokens: number;
  mix: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** true = 用户没有任何任务，画像是内置参考值 */
  reference: boolean;
}

export interface PriceChartData {
  categories: PriceChartCategoryData[];
  profile: PriceChartProfile;
  /** 已添加的服务商里有套餐计费的（图下说一句「套餐按官方单价折算」） */
  hasPlanProvider: boolean;
  /** 署名与出处（CC-BY-4.0 的义务：署名 + 注明改动 + revision） */
  source: {
    dataset: string;
    url: string;
    revision: string;
    license: string;
    attribution: string;
  };
}
