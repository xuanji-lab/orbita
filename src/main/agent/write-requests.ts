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
import type { SkillScope } from "../../shared/skill.ts";
import type { SkillStore } from "../skill/store.ts";
import type { McpStore } from "../mcp/store.ts";
import type { SessionStore } from "../session/store.ts";

export type WriteOutcome =
  | { ok: true; path?: string; status?: { kind: "ready" | "failed" | "disabled" | "connecting"; message?: string } }
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
  reload: (servers: Awaited<ReturnType<McpStore["read"]>>) => Promise<void>,
  statusOf: (name: string) => { kind: "ready" | "failed" | "disabled" | "connecting"; message?: string } | undefined,
  event: Extract<AgentEvent, { type: "mcpWriteRequest" }>,
): Promise<WriteOutcome> {
  try {
    // 已存在同名：拒绝（覆盖等于吃掉用户现有配置）；模型要改就去编辑文件
    await mcp.add(event.name, event.server);
    await reload(await mcp.read()).catch(() => undefined); // 重连失败不算写失败（配置已在）
    return { ok: true, status: statusOf(event.name) };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** 会话 → 工作区。没有工作区（或会话不在了）就抛——「workspace」没有指称。 */
async function workspaceOf(sessions: SessionStore, sessionId: string): Promise<string> {
  const meta = await sessions.load(sessionId);
  const workspaceId = meta?.meta.workspaceId ?? null;
  if (workspaceId === null) {
    throw new Error("这条会话不属于任何工作区，scope 只能用 global");
  }
  return workspaceId;
}
