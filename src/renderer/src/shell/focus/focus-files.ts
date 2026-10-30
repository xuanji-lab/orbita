/**
 * 工作区文件视图的纯推导（原型的「查看工作区文件」与专注中左栏共用）。
 * 树的加载 / 缓存 / 刷新在 features/files 的 useFileTree（整棵复用），这里只算
 * U / M 的视图派生：路径匹配、目录圆点、改动汇总、增删行数的文案。
 */
import type { FocusChangeEntry, FocusChangeKind } from "@shared/focus";

/** 隐藏条目（`.` 开头）：默认不进树（VS Code 资源管理器同款默认；PR 描述里可推翻） */
export function isHiddenEntry(name: string): boolean {
  return name.startsWith(".");
}

/** 改动清单 → 按路径索引 */
export function changeIndexOf(entries: readonly FocusChangeEntry[]): Map<string, FocusChangeEntry> {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

/**
 * 目录圆点的聚合：每个改动路径的全部祖先目录都标上「里面有改动」。
 * U 压过 M——目录里只要有一个新文件，圆点就是成功绿（「这里有新东西」）。
 */
export function dirChangeIndex(entries: readonly FocusChangeEntry[]): Map<string, FocusChangeKind> {
  const dirs = new Map<string, FocusChangeKind>();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      const prev = dirs.get(dir);
      if (prev !== "U" && (entry.kind === "U" || prev === undefined)) dirs.set(dir, entry.kind);
    }
  }
  return dirs;
}

/** 一条改动路径的全部祖先目录（相对路径，浅 → 深）；文件在根层时是空数组 */
export function ancestorsOf(path: string): string[] {
  const parts = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/** 改动汇总行：「改动 N 个文件，其中 M 个新文件」的两个数 */
export function changeSummary(entries: readonly FocusChangeEntry[]): { changed: number; untracked: number } {
  return { changed: entries.length, untracked: entries.filter((entry) => entry.kind === "U").length };
}

/** 增删行数文案（悬停才出现）：`+42 −7`，只有一侧就只写一侧；二进制没有行级统计 */
export function formatChangeLines(entry: FocusChangeEntry): string {
  if (entry.binary) return "";
  const parts: string[] = [];
  if (entry.added > 0) parts.push(`+${entry.added}`);
  if (entry.removed > 0) parts.push(`\u2212${entry.removed}`);
  return parts.join(" ");
}

/** 树里的相对路径（dir 与 entry 拼接，正斜杠——git 路径同口径） */
export function joinRel(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * 这一拍要不要去拉 U / M：窗口藏起来（最小化 / 切到别的应用 / 别的 Space）时
 * 不拉——后台没人看，30 秒一次的 git 读与 IPC 只是烧电（`perf(focus)`：最小化
 * 时 focus:changes 照样每 30 秒调一次）。回到前台由 visibilitychange 立刻补一拍，
 * 所以看得见的时候永远不会比旧行为更旧。
 */
export function shouldPollChanges(visibilityState: string): boolean {
  return visibilityState !== "hidden";
}

/**
 * 轮询守卫的小状态（在途标记 + 其代次与工作区）。代数简单，不值得一个类：
 * 三个纯函数盖住全部转移，组件里只拿 ref 存它。`node --test` 直接可测。
 */
export interface PollGate {
  /** 有没有一遭 focus:changes 在途（30 秒一拍 + 回前台补拍都可能发起） */
  inflight: boolean;
  /** 在途那遭的代次（每次真正发起 +1；落定时对不上号就作废） */
  generation: number;
  /** 在途那遭查的工作区 */
  workspaceId: string | null;
}

export const POLL_GATE_IDLE: PollGate = { inflight: false, generation: 0, workspaceId: null };

/** 发起成功的回执：新状态 + 这一遭的号（落定时拿它对号） */
export interface PollTicket {
  gate: PollGate;
  mine: number;
}

/**
 * 发起前：在途去重。**同一工作区**在途时后来的拍子直接放弃（慢 git 一次 status
 * 数秒，30 秒一拍 + 回前台补拍会叠起来；在途那遭回来就是新鲜数据，不欠这拍）。
 * 工作区变了就顶替：旧在途不被等，代次 +1 让它落定时作废——key 重挂已经保证
 * 换工作区是新实例，这里是同一实例内换了 prop 时的兑底。
 */
export function pollGateBegin(current: PollGate, workspaceId: string): PollTicket | null {
  if (current.inflight && current.workspaceId === workspaceId) return null;
  const generation = current.generation + 1;
  return { gate: { inflight: true, generation, workspaceId }, mine: generation };
}

/** 落定时：这一遭的号还是最新才收——对不上号只在被顶替时发生，宁作废不串台 */
export function pollGateAccept(current: PollGate, mine: number): boolean {
  return current.generation === mine;
}

/** 结束（收不收都走）：在途清零；代次与工作区留着给后到者对号 */
export function pollGateSettle(current: PollGate): PollGate {
  return { inflight: false, generation: current.generation, workspaceId: current.workspaceId };
}
