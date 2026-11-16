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

import { isThinkingLevel, type ThinkingLevel } from "./thinking.ts";

export interface MainAgentProfile {
  workspaceId: string;
  /** 主智能体那条会话的 id（第一句话之前是预留的，会话还不存在） */
  sessionId: string;
  /** 档案建立的时刻（Unix ms）：工作区里早于它的会话就是「升级前攒下的」，空态据此说清它们去了哪 */
  createdAt: number;
  /**
   * 应用退出 / 崩了再打开时，这个主智能体名下（它自己 + 它派出的活）有活被打断的记录，旧 → 新，最多留 20 条。
   * 主智能体的对话里据此记一行「断了多久、几件接着做了、几件没接上」。
   * **不写进会话转录**：旧版本读转录时不认识的记录不会跳过（会当消息画），写进去回滚就会出错。缺席 = 没断过。
   */
  resumes?: MainAgentResume[];
  /**
   * 这个工作区的主智能体以后都用的型号与思考档（2026-11-17，用户在顶栏「主智能体」上定）。
   * **缺席 = 沿用现在新会话的默认**（上次用的型号与新任务的思考档规则）；建档时不抄一份进来——默认值改了它要跟着走。
   * 有值时主智能体那条会话每轮开轮以它为准（输入框里不再有型号与思考档选择器），它派活不点名型号也沿用它。
   */
  model?: MainAgentModel;
}

export interface MainAgentModel {
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

/** agents:set-main-model 的载荷 */
export interface MainAgentModelInput {
  workspaceId: string;
  model: MainAgentModel;
}

/** 档案里的型号：三项齐全且合法才认，坏了当缺席（沿用默认，不让一份坏档案把主智能体堵死） */
export function parseMainAgentModel(raw: unknown): MainAgentModel | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const providerId = value["providerId"];
  const modelId = value["modelId"];
  const thinkingLevel = value["thinkingLevel"];
  if (typeof providerId !== "string" || providerId === "" || typeof modelId !== "string" || modelId === "") return null;
  if (!isThinkingLevel(thinkingLevel)) return null;
  return { providerId, modelId, thinkingLevel };
}

/** 一次「断过」：from = 被打断的活最后一次落盘的时刻（约等于断的时刻），at = 重开后接上的时刻 */
export interface MainAgentResume {
  at: number;
  from: number;
  /** 自动接着做了的会话 id（主智能体自己或它派的活；上次是正常退出） */
  resumed: string[];
  /** 没接上、停在原处的（上次是异常退出：命令可能成了孤儿，自动重跑会把有副作用的事再做一遍） */
  stopped: string[];
}

/** 档案里最多留几条「断过」记录（只有最近的几条会被画出来，多了只占地方） */
export const MAIN_AGENT_RESUMES_KEPT = 20;

function parseResume(raw: unknown): MainAgentResume | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const ids = (list: unknown): string[] | null =>
    Array.isArray(list) && list.every((id) => typeof id === "string") ? (list as string[]) : null;
  const resumed = ids(value["resumed"]);
  const stopped = ids(value["stopped"]);
  if (typeof value["at"] !== "number" || typeof value["from"] !== "number" || resumed === null || stopped === null) return null;
  return { at: value["at"], from: value["from"], resumed, stopped };
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
  // 坏的「断过」条目逐条丢，不连累整份档案
  const resumes = Array.isArray(value["resumes"])
    ? value["resumes"].map(parseResume).filter((item): item is MainAgentResume => item !== null)
    : [];
  const model = parseMainAgentModel(value["model"]);
  return { workspaceId, sessionId, createdAt, ...(resumes.length > 0 ? { resumes } : {}), ...(model === null ? {} : { model }) };
}

/**
 * 重开应用时，这个主智能体名下被打断的活（resumePolicy 非空的那些）记成一次「断过」：
 * 自动接着做的进 resumed，停在原处的进 stopped；from 取它们最后一次落盘的时刻（崩溃时没有别的钟可看）。
 * 名下没有被打断的活 = null（不记）。纯函数，主进程启动时调。
 */
export function resumeOf(
  family: readonly { id: string; updatedAt: number; policy: "resume" | "crashed" | "ask" | null }[],
  at: number,
): MainAgentResume | null {
  const hit = family.filter((item) => item.policy !== null);
  if (hit.length === 0) return null;
  return {
    at,
    from: Math.max(...hit.map((item) => item.updatedAt)),
    resumed: hit.filter((item) => item.policy === "resume").map((item) => item.id),
    stopped: hit.filter((item) => item.policy !== "resume").map((item) => item.id),
  };
}
