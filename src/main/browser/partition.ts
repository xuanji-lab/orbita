/**
 * 受管浏览器的 partition：**每个会话一份登录态**。
 *
 * tab 本来就是按会话分的（agent tab），但升级前所有 tab 共用同一个持久化 partition，
 * cookie / localStorage 是串的：两个会话并行做网页任务，一个在某站点登录，另一个也跟着
 * 变成已登录。这一刀把 storage 也按会话分开——partition 名从 sessionId 派生。
 *
 * 命名：`persist:orbita-browser-<sessionId>`。`persist:` 前缀是 Electron 的持久化标记；
 * 前面的段沿用旧的全局名，一眼看得出是受管浏览器的存储。
 *
 * **不迁移旧数据**（2026-10 裁决）：升级前那份 `persist:orbita-browser` 原样保留，继续给用户
 * 自己的 tab 与「没有会话可归」的回落用，但不复制进各会话——把同一份身份复制成 N 份正好是
 * 这次要消除的串号。各会话升级后第一次打开浏览器是未登录状态，要登录就交接给用户
 * （request_user_action），在它自己的 tab 里登。
 *
 * 这里不 import electron：partition 的派生与生命周期（复用一个 session、按会话清存储）
 * 都是纯逻辑，`node --test` 直接加载，Electron 的 session 对象由主进程注入。
 */

/** 旧版全局 partition：用户的 tab、以及没有会话可归的回落都用它 */
export const BROWSER_PARTITION = "persist:orbita-browser";

const SESSION_PARTITION_PREFIX = `${BROWSER_PARTITION}-`;

/**
 * sessionId 能进 partition 名的字符。与 data-dirs.ts 的实例名同一条规矩：首字符是字母 / 数字，
 * 其余只许字母、数字、下划线、连字符。partition 名会被 Electron 拼进磁盘路径，别的字符一律不进去。
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * 会话的 partition 名。缺 sessionId / 空串 / 含不安全字符 → 旧的全局 partition（回落，
 * 不报错）；**不做「替换非法字符」**：`a/b` 与 `a:b` 会撞成同一个 partition，那正是要防的串号。
 */
export function partitionForSession(sessionId: string | null | undefined): string {
  if (typeof sessionId !== "string" || !SAFE_SESSION_ID.test(sessionId)) return BROWSER_PARTITION;
  return `${SESSION_PARTITION_PREFIX}${sessionId}`;
}

/** partition 的存储面：Electron 的 Session 满足它；测试注入假对象 */
export interface PartitionStorage {
  /** cookie、localStorage / IndexedDB、Service Worker 等站点存储。删会话与「清除全部」都走它 */
  clearStorageData(): Promise<void>;
  /** HTTP 缓存。只有「清除全部浏览器数据」用得到（删会话不碰缓存） */
  clearCache?(): Promise<void>;
  /** HTTP 认证缓存（401 那一套凭据），同上 */
  clearAuthCache?(): Promise<void>;
}

export interface SessionPartitionsDeps<T extends PartitionStorage> {
  /** partition 名 → 存储。主进程里是 session.fromPartition；测试注入假对象 */
  open: (partition: string) => T;
  /**
   * 新 partition 第一次被用到时装约束（权限全拒、UA、下载落点…）。
   * 每个 partition 只装一次：同一个 Session 上重复装会叠加监听。
   */
  guard?: (partition: string, storage: T) => void;
}

/** 一个 partition 的名字与它的存储 */
export interface OpenedPartition<T> {
  partition: string;
  storage: T;
}

/**
 * 打开过的 partition 的表：按会话取、按会话清。
 *
 * 为什么要有这张表：Electron 不提供「列出所有 partition」的接口，清存储与装约束都得先有
 * session 对象。表按 partition 名去重——同一个会话（哪怕 tab 被回收重建）始终拿到同一个
 * session，两个不同会话永远拿到两个。
 */
export class SessionPartitions<T extends PartitionStorage> {
  private readonly deps: SessionPartitionsDeps<T>;
  private readonly opened = new Map<string, T>();

  constructor(deps: SessionPartitionsDeps<T>) {
    this.deps = deps;
  }

  /** 会话（null = 用户自己 / 回落）的 partition 与它的存储；首次取用时装约束 */
  get(sessionId: string | null | undefined): OpenedPartition<T> {
    const partition = partitionForSession(sessionId);
    return { partition, storage: this.storage(partition) };
  }

  /**
   * 会话删除：清掉**它自己那一份**存储，别的会话分毫不动。
   * 没打开过的 partition 也清——数据在盘上，跟这一轮有没有建过 tab 无关。
   *
   * 回 false = 这个 id 派生不出会话自己的 partition（缺 id / 含不安全字符），什么都没清。
   * 这时绝不能退回去清 default：那会把用户自己 tab 的登录态一起抹掉，
   * 删一个坏 id 的会话不该有这种副作用。
   */
  async clearSession(sessionId: string | null | undefined): Promise<boolean> {
    const partition = partitionForSession(sessionId);
    if (partition === BROWSER_PARTITION) return false;
    await this.storage(partition).clearStorageData();
    return true;
  }

  /**
   * 设置里的「清除全部浏览器数据」：清本轮见过 / 用过的每个 partition。
   * 用户那份（旧的全局 partition）总在内——窗口没开过也能清，数据在盘上不在窗口里。
   *
   * 已知边界：Electron 枚举不到 partition，本轮没被碰过的旧会话 partition 不在这张表里，
   * 清不到。那些数据留在盘上，等那个会话下次用浏览器时按自己的身份继续用；要彻底清干净，
   * 得另存一份 partition 清单（会话创建时记进 meta）并在启动时读回来。
   */
  async clearAll(): Promise<void> {
    // 先取用户那份（它可能还不在表里）再拍快照；Set 按存储对象去重，同一份清且只清一遍
    const stores = new Set<T>([this.storage(BROWSER_PARTITION), ...this.opened.values()]);
    for (const storage of stores) {
      await storage.clearStorageData();
      await storage.clearCache?.();
      await storage.clearAuthCache?.();
    }
  }

  private storage(partition: string): T {
    const existing = this.opened.get(partition);
    if (existing !== undefined) return existing;
    const storage = this.deps.open(partition);
    this.opened.set(partition, storage);
    this.deps.guard?.(partition, storage);
    return storage;
  }
}
