/**
 * agent 写盘请求的落地（4-3）：把 skillWriteRequest / mcpWriteRequest 翻成
 * SkillStore / McpStore 的调用，产出回执。**纯模块**（store 注入），可被
 * `node --test` 直接测——main/index.ts 只做路由与回发。
 *
 * scope 的 workspace 一侧在这里解析：agent 进程不知道 workspaceId，主进程
 * 按会话归属查（session meta 的 workspaceId；没有工作区的会话报错——
 * 「workspace」对它没有指称，宁可报错也不猜成 global）。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { isMcpServerName, parseServer, type McpStatus } from "../../shared/mcp.ts";
import type { SkillScope } from "../../shared/skill.ts";
import type { SkillStore } from "../skill/store.ts";
import type { McpStore } from "../mcp/store.ts";
import type { SessionStore } from "../session/store.ts";

export type WriteOutcome =
  | { ok: true; path?: string; status?: McpStatus }
  | { ok: false; error: string };

export async function applySkillWrite(
  skills: SkillStore,
  sessions: SessionStore,
  event: Extract<AgentEvent, { type: "skillWriteRequest" }>,
): Promise<WriteOutcome> {
  try {
    const scope: SkillScope =
      event.scope === "global"
        ? { kind: "global" }
        : { kind: "workspace", workspaceId: await workspaceOf(sessions, event.sessionId) };
    // 有则更新无则新建：模型重复调（改了再试）不该被「已存在」卡死。
    // 新建带着全文（E2E 抓回过一版只落骨架、丢 description/body 的实现）。
    const existing = await skills.read(event.slug);
    if (existing === null) {
      await skills.create(event.slug, event.name, scope, {
        description: event.description,
        body: event.body,
      });
    } else {
      await skills.write(event.slug, { name: event.name, description: event.description, body: event.body });
      await skills.link(event.slug, scope);
    }
    return { ok: true, path: (await skills.locateDir(event.slug)) ?? undefined };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

export async function applyMcpWrite(
  mcp: McpStore,
  /** 写盘后让 agent 进程拆掉连接重来。不送 servers：每轮开轮本来就会送该工作区那一份 */
  reload: () => Promise<void>,
  statusOf: (name: string) => McpStatus | undefined,
  event: Extract<AgentEvent, { type: "mcpWriteRequest" }>,
): Promise<WriteOutcome> {
  try {
    // 入口校验（2026-10-11 用户报的「回执 Server added 但配置没了」的另一半裂缝）：
    // 模型传什么形状都可能，认不出的直接报错，不落盘——写进去却在读回时被
    // parseMcpConfig 静默丢弃，比拒绝更糟。顺带规范化：type:"http" / 只有 url
    // 都归一成 transport:"http"，文件里只存自家格式。
    if (!isMcpServerName(event.name)) {
      return {
        ok: false,
        error: `非法 server 名「${event.name}」：只能字母 / 数字 / 连字符 / 下划线，它要拼进工具名`,
      };
    }
    const server = parseServer(event.server);
    if (server === null) {
      return {
        ok: false,
        error:
          `server 配置认不出来：要 stdio {transport:"stdio", command, args?, env?} ` +
          `或 http {transport:"http", url, headers?}；收到的是 ${JSON.stringify(event.server)}`,
      };
    }
    // 已存在同名：拒绝（覆盖等于吃掉用户现有配置）；模型要改就去编辑文件
    await mcp.add(event.name, server);
    await reload().catch(() => undefined); // 重连失败不算写失败（配置已在）
    return { ok: true, status: statusOf(event.name) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * 会话 → 工作区。没有工作区（或会话不在了）就抛——「workspace」没有指称。
 * 报错要讲清两件事（2026-10-11 用户实测：两次撞「不属于任何工作区」的墙，
 * 旧文案既不说为什么 cwd 明明是个目录还不算、也不说出路）：工作目录只是
 * 这单活儿用哪个目录，不等于会话归属工作区；出路是改 global，或把会话
 * 移进工作区再试。错误文案会作为工具结果回到模型手上，它照着改。 */
async function workspaceOf(sessions: SessionStore, sessionId: string): Promise<string> {
  const detail = await sessions.load(sessionId);
  const workspaceId = detail?.meta.workspaceId ?? null;
  if (workspaceId === null) {
    const cwd = detail?.meta.cwd ?? "（未记录）";
    throw new Error(
      `这条会话没有归属工作区（它的工作目录是 ${cwd}，但会话不是从工作区里开的，工作目录不等于归属）：` +
        `scope "workspace" 无处可挂。请改用 "global"，或在左栏把这条会话移进工作区后再试`,
    );
  }
  return workspaceId;
}
