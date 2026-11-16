/**
 * 常驻主智能体契约 —— IPC 四层的第 1 层（2026-11-17）。
 *
 * 每个工作区一个常驻主智能体，是用户在这个工作区的唯一入口：点侧栏的工作区那一行就是在跟它说话。
 * 它本身是一条普通会话（存储、回退、压缩、搜索全复用），meta 上带 `role: "main"`；
 * 「工作区 → 哪条会话是主智能体」记在主进程的一份小档案里：`<userData>/agents/main/<工作区 id>.json`（原子写）。
 *
 * 为什么另放一份档案而不写进工作区配置：工作区列表是用户能导出 / 同步的配置，主智能体指针是运行时数据，
 * 混在一起会把一台机器上的会话 id 带到另一台。以后的智能体档案（名字、头像、能力）也长在这份档案上。
 *
 * 惰性：第一次进入工作区时才建档案，只记一个预留的会话 id；会话本身在第一句话发出时才落盘
 * （没说过话的工作区不在磁盘上留一条空会话）。不迁、不吞旧会话——旧会话照旧是普通会话，主智能体能用 read_task 读。
 */

export interface MainAgentProfile {
  workspaceId: string;
  /** 主智能体那条会话的 id（第一句话之前是预留的，会话还不存在） */
  sessionId: string;
  /** 档案建立的时刻（Unix ms）：工作区里早于它的会话就是「升级前攒下的」，空态据此说清它们去了哪 */
  createdAt: number;
}

/** 盘上读回的档案：缺字段或类型不对一律当没有（重建一份，不让一份坏文件把工作区堵死） */
export function parseMainAgentProfile(raw: unknown): MainAgentProfile | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const workspaceId = value["workspaceId"];
  const sessionId = value["sessionId"];
  const createdAt = value["createdAt"];
  if (typeof workspaceId !== "string" || workspaceId === "") return null;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  return { workspaceId, sessionId, createdAt };
}
