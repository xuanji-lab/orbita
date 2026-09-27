/**
 * 同站节流：agent 对同一个站点（host）发起的「会发请求的动作」（导航、点击、提交、后退）
 * 相邻两次至少隔 `minIntervalMs`，所有会话的 agent tab 合起来算。
 *
 * 为什么：学术数据库（Scopus、Web of Science…）按机构出口 IP 检测批量访问，触发了封的是整个学校。
 * 工具描述里已经叮嘱模型别连开页面，这里是兜底——模型不听、或者几个会话同时在翻同一个站，
 * 速度也被压在「人手点」的量级。单个会话里模型每步本来就要几秒，节流几乎感觉不到。
 *
 * 纯逻辑：时钟与睡眠可注入，node --test 直接测。file://、about: 等非 http(s) 地址不节流。
 */
export class HostPacer {
  /** 每个 host 最近一次**被放行**（或已预约）的时刻 */
  private readonly slots = new Map<string, number>();
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: { minIntervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }) {
    this.minIntervalMs = options.minIntervalMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * 轮到这个站点时返回（回等了多少毫秒）。**同步预约时段**再睡：两个并发调用不会
   * 看到同一个「上次」而同时放行。
   */
  async wait(url: string): Promise<number> {
    const host = hostOf(url);
    if (host === null) return 0;
    const now = this.now();
    const previous = this.slots.get(host);
    const slot = previous === undefined ? now : Math.max(now, previous + this.minIntervalMs);
    this.slots.set(host, slot);
    const waited = slot - now;
    if (waited > 0) await this.sleep(waited);
    return waited;
  }
}

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : null;
  } catch {
    return null;
  }
}
