/**
 * 旧技能 / 旧 MCP 显示成「只有一样东西的插件」——**视图层的投影，不搬文件**：
 * - 技能：`skill-links/` 的链接表是真源。global 链 → 所有工作区；链在某些工作区 → 那些工作区；
 *   哪里都没链 → 停用且没有位置（落「未启用」组）。断链（missing，真身目录没了）也列出来、停用且没有位置，
 *   带一条 skill-folder-missing 问题——旧技能面板撤了以后，清理断链引用只能从这里进。
 * - MCP：全局 `mcp.json`。`workspaces` 白名单为空 → 所有工作区；`disabled` → 停用但位置还记着
 *   （停用的行仍落在原来的组里，与真插件一致）。白名单里写的可以是工作区名或 id，投影时翻成 id，
 *   翻不到的丢掉（那个工作区已经不在了）。工作区自带的 `.mcp.json` 不算「你的 MCP」，不在这里。
 *
 * 写路径把 PluginScope 映射回各自的真源（link / unlink、mcp.json 的 disabled 与 workspaces），
 * 所以在插件页里拨开关与在旧面板里拨，落到的是同一份状态，不存在第二份。
 */
import { join } from "node:path";
import {
  pluginViewId,
  type PluginPlacement,
  type PluginScope,
  type PluginView,
} from "../../shared/plugin.ts";
import { describeServer, isHttpServer, type McpServer } from "../../shared/mcp.ts";
import { EMPTY_PLUGIN_IO } from "../../shared/plugin-board.ts";
import type { SkillMeta, SkillScope } from "../../shared/skill.ts";
import type { Workspace } from "../../shared/workspace.ts";

/** 旧技能 / MCP 没有的那几块：每个视图一份新数组，别让两个视图共用同一个可变空数组。 */
function emptyParts(): Pick<PluginView, "author" | "version" | "license" | "unsupported" | "config" | "conflicts" | "problems" | "install"> {
  return { author: null, version: null, license: null, unsupported: [], config: [], conflicts: [], problems: [], install: null };
}

export function skillViews(metas: readonly SkillMeta[], storeRoot: string): PluginView[] {
  return metas.map((meta): PluginView => {
    // 断链的技能没有东西可开关：不论链接还剩几条，都按「没有位置、停用」列出，只留清理入口
    const placement: PluginPlacement | null = meta.missing
      ? null
      : meta.global
        ? { kind: "global" }
        : meta.workspaces.length > 0
          ? { kind: "workspaces", ids: [...meta.workspaces] }
          : null;
    return {
      ...emptyParts(),
      id: pluginViewId("user-skill", meta.slug),
      origin: "user-skill",
      name: meta.name,
      description: meta.description,
      scope: placement ?? { kind: "off" },
      placement,
      contents: { skills: 1, mcp: 0, scripts: false },
      skills: [{ slug: meta.slug, name: meta.name, description: meta.description }],
      workflow: [],
      io: EMPTY_PLUGIN_IO,
      external: [],
      board: null,
      tuned: false,
      mcp: [],
      problems: meta.missing ? [{ kind: "skill-folder-missing", detail: meta.slug }] : [],
      location: meta.linkedPath ?? join(storeRoot, meta.slug),
    };
  });
}

export function mcpViews(servers: Readonly<Record<string, McpServer>>, workspaces: readonly Workspace[]): PluginView[] {
  return Object.entries(servers)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, server]): PluginView => {
      const whitelist = server.workspaces ?? [];
      const ids = [
        ...new Set(
          whitelist.flatMap((entry) => {
            const found = workspaces.find((workspace) => workspace.id === entry || workspace.name === entry);
            return found === undefined ? [] : [found.id];
          }),
        ),
      ];
      // 白名单写了但一个都翻不到：它此刻对任何工作区都不生效，也没有可落的组
      const placement: PluginPlacement | null = whitelist.length === 0 ? { kind: "global" } : ids.length > 0 ? { kind: "workspaces", ids } : null;
      const enabled = server.disabled !== true && placement !== null;
      return {
        ...emptyParts(),
        id: pluginViewId("user-mcp", name),
        origin: "user-mcp",
        name,
        description: describeServer(server),
        scope: enabled && placement !== null ? placement : { kind: "off" },
        placement,
        contents: { skills: 0, mcp: 1, scripts: false },
        skills: [],
        workflow: [],
        io: EMPTY_PLUGIN_IO,
        external: [],
        board: null,
        tuned: false,
        mcp: [
          {
            name,
            qualified: name,
            transport: isHttpServer(server) ? "http" : "stdio",
            commandLine: describeServer(server),
            problem: null,
          },
        ],
        location: null,
      };
    });
}

/**
 * 改旧技能的启用范围。global / workspace 互斥由 SkillStore.link 自己执行（链进 global 删各
 * 工作区的链接，链进工作区删 global 的链接）；这里只补「目标之外的要移出」。
 */
export async function applySkillScope(
  store: { link(slug: string, scope: SkillScope): Promise<void>; unlink(slug: string, scope: SkillScope): Promise<void> },
  meta: SkillMeta,
  scope: PluginScope,
): Promise<void> {
  if (scope.kind === "off") {
    if (meta.global) await store.unlink(meta.slug, { kind: "global" });
    for (const id of meta.workspaces) await store.unlink(meta.slug, { kind: "workspace", workspaceId: id });
    return;
  }
  if (scope.kind === "global") {
    await store.link(meta.slug, { kind: "global" });
    return;
  }
  for (const id of scope.ids) await store.link(meta.slug, { kind: "workspace", workspaceId: id });
  for (const id of meta.workspaces) {
    if (!scope.ids.includes(id)) await store.unlink(meta.slug, { kind: "workspace", workspaceId: id });
  }
  // 名单为空等于哪里都不链：和 off 一样把 global 也移出
  if (scope.ids.length === 0 && meta.global) await store.unlink(meta.slug, { kind: "global" });
}

/** 改旧 MCP 的启用范围，一次写完 disabled 与白名单。白名单写工作区 id（改名后仍生效）。 */
export async function applyMcpScope(
  store: { setScope(name: string, patch: { disabled: boolean; workspaces?: string[] }): Promise<void> },
  name: string,
  scope: PluginScope,
): Promise<void> {
  if (scope.kind === "off") return store.setScope(name, { disabled: true });
  if (scope.kind === "global") return store.setScope(name, { disabled: false, workspaces: [] });
  // 空名单会被当成「所有工作区」：宁可当停用，也不要用户选了「只在这些」却一个没选就全开
  if (scope.ids.length === 0) return store.setScope(name, { disabled: true });
  return store.setScope(name, { disabled: false, workspaces: scope.ids });
}
