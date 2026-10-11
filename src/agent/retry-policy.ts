/**
 * 重试策略参数与界面可见性阈值 —— 对齐 Proma（pi 同源 runtime 的既有裁决）。
 *
 * 来源：用户自部署的 sub2api 网关走 Cloudflare，偶发**瞬时 502**（会话 3ae38a33
 * 2026-10-09 17:25 连续 502、一小时内同请求成功）。原先 3 次 × 固定 5 秒的窗口
 * （约 15 秒）扛不过这种抖动；Proma 侧同场景用 8 次、1 秒起指数退避（1+2+…+128
 * ≈ 4 分 15 秒总窗口）跑得稳，orbita 继承同一套参数。
 *
 * 指数退避是 pi 的原生行为——原先拍平它的两段 patch 已随本文件撤销（见
 * patches/README.md 与提交历史），这里不再 patch、只注入参数。
 *
 * 纯模块：不 import pi（与 branch-cut.ts 同一纪律），由 runtime.ts 消费、
 * retry-policy.test.ts 守卫。
 */

/** 重试次数上限（pi 的 maxRetries：第 1 次失败后最多再试这么多次） */
export const RETRY_MAX_ATTEMPTS = 8;

/** 退避基数（毫秒）：第 n 次重试前等 base × 2^(n-1)，即 1s、2s、4s … 128s */
export const RETRY_BASE_DELAY_MS = 1000;

/**
 * 前 N 次重试不打扰界面：瞬时 502 / 网络抖动大多在前几次自愈，每次都弹
 * 「Retry 2/8 · in 3s」是把内部恢复当成了用户的事故。第 N+1 次起才发
 * `retry` 事件给 renderer；最终失败（重试耗尽）照常报错，不受此阈值影响。
 * 与 Proma 的 PI_RETRY_VISIBILITY_THRESHOLD 同值同语义（那边注释：与 Claude
 * runtime 的自动恢复体验保持一致）。
 */
export const RETRY_VISIBILITY_THRESHOLD = 5;

/** 该次重试（attempt 从 1 起）是否要在界面上显示等待行。 */
export function retryVisibleToUi(attempt: number): boolean {
  return attempt > RETRY_VISIBILITY_THRESHOLD;
}
