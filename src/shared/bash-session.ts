/**
 * 交还句柄的 bash 会话 —— 一条协议、两种读者。
 *
 * **一条协议**：签到点（agent/bash-observe.ts）在工具结果尾部写一行
 * `[orbita] kind=detached session=b1 idle=0s | …`。模型读竖线后的英文散文，
 * renderer 只解析竖线前的键值。生产与解析放在同一个文件里，是为了让格式只有
 * 一处真源——改前缀却忘了改解析，界面上那一行会静默退回成普通 bash 行。
 *
 * **两种读者**：状态通路（renderer 轮询 → 主进程 → utility 会话表）搬的就是
 * `BashSessionStatus`：界面上「跑了多久、还在动吗、怎么没的」全部只认这一份，
 * 不让 renderer 自己从输出文本里猜。
 *
 * 本文件在 `src/shared/`：主进程 / renderer / agent 三个进程共用，**禁引 node 内置**。
 */

/**
 * 会话的结束原因。agent 侧的 `SessionEndReason` 是同一套取值——
 * `lifetime` 是「跑满 4 小时寿命上限被兜底杀掉」，与用户 / 模型主动停
 * （`stop`）、用户停轮（`abort`）、应用退出（`shutdown`）分开说：
 * 界面上只有上限那一种是「意外没了」（警示色），其余都是人做的决定。
 */
export type BashSessionEndReason = "lifetime" | "stop" | "abort" | "shutdown";

/**
 * 一条 bash 会话的对外状态。**秒**而不是毫秒：这份数据只为界面事实槽而存在，
 * 毫秒精度在「已 12:34」这种画法里没有意义，还多两个要除的数。
 */
export interface BashSessionStatus {
  id: string;
  status: "running" | "finished" | "killed";
  exitCode: number | null;
  /** 从 spawn 到「现在」（已结束的算到结束那一刻） */
  elapsedSeconds: number;
  /** 距上一次输出多久。界面上「无输出 2:10」就是它 */
  idleSeconds: number;
  /** 只有被杀的会话有：怎么没的 */
  endReason?: BashSessionEndReason;
}

/** 交还提示行的前言（竖线之左）。生产方与解析方共用这一条，见文件头 */
export function detachedNoticeHeader(sessionId: string): string {
  return `[orbita] kind=detached session=${sessionId} idle=0s`;
}

/**
 * 从工具结果文本里认出交还的会话 id。
 *
 * 只认 `b<数字>`：会话 id 由会话表铸造（bash-sessions.ts 的 `b1` / `b2`…），
 * 别的形状一律当没认出来——宁可这一行退回普通 bash 行，也不要拿半个字符串去查表。
 */
export function parseDetachedSessionId(text: string): string | null {
  const match = /\[orbita\] kind=detached session=(b\d+)/.exec(text);
  return match === null ? null : (match[1] ?? null);
}
