/**
 * 「正在做」列表：每个工作区 `<根>/plugins/<文件夹>/` 下**有清单、还没安装**的插件文件夹。
 *
 * 草稿本来只存在于对话进行时的 renderer 内存里；用户中途离开后没有入口回来。这里把它还原成
 * 「磁盘上的事实」：文件夹在、有清单、没装 = 正在做。不起新的存储。
 *
 * 纯逻辑模块（不 import electron；工作区、安装记录、会话查询都是注入的端口），可被 `node --test` 直接测：
 * - 每个文件夹先 realpath，必须落在该工作区根（也 realpath）之内——`plugins/x` 是指到别处的符号链接就不列；
 * - 清单读不出来 / 写坏的也列（`manifestProblem` 带原文）：草稿还在写时常见，列出来用户才找得到；
 *   完全没有清单的不列（那还只是个空文件夹，不是「插件」）；
 * - 已装的不列：安装记录是链接装、指向同一文件夹（realpath 比），或拷贝装且来源是它；
 * - 最近改动时间 = 清单、技能、看板、脚本等常见位置里最新的 mtime（深度与条数封顶，不递归整棵树）。
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { PluginDraftEntry, PluginProblem } from "../../shared/plugin.ts";
import { manifestDisplayName, readManifest } from "./manifest.ts";
import type { PluginRecord } from "./records.ts";

/** 每个工作区最多列几个草稿文件夹（一个 plugins/ 下不会有几百个；防异常目录） */
const DRAFTS_PER_WORKSPACE_MAX = 100;
/** 算「最近改动」时最多看几个条目、往下几层 */
const MTIME_ENTRIES_MAX = 300;
const MTIME_DEPTH_MAX = 3;
/** 不往里看的目录名 */
const MTIME_SKIP = new Set(["node_modules", ".git"]);

export interface DraftScanDeps {
  /** 所有工作区（Home 没有 plugins/ 约定，不在里面） */
  workspaces: () => Promise<Array<{ id: string; path: string }>>;
  /** 全部安装记录（含内置） */
  records: () => Promise<PluginRecord[]>;
  /** 草稿路径（realpath）→ 最近在做它的会话与标题；没记过 / 会话已删为 null（标题空串当没有标题） */
  sessionOf: (draftPath: string) => Promise<{ sessionId: string; title: string } | null>;
}

export async function scanDrafts(deps: DraftScanDeps): Promise<PluginDraftEntry[]> {
  const records = await deps.records();
  // 已装的文件夹（realpath 之后）：链接装的 path、拷贝装的 from
  const installedRoots = new Set<string>();
  for (const record of records) {
    const source = record.source;
    const origin = source.kind === "link" ? source.path : source.kind === "copy" ? source.from : null;
    if (origin === null) continue;
    installedRoots.add(await realpath(origin).catch(() => origin));
  }

  const entries: PluginDraftEntry[] = [];
  for (const workspace of await deps.workspaces()) {
    const realWorkspace = await realpath(workspace.path).catch(() => null);
    if (realWorkspace === null) continue;
    const pluginsDir = join(realWorkspace, "plugins");
    let names: string[];
    try {
      names = (await readdir(pluginsDir)).filter((name) => !name.startsWith(".")).sort();
    } catch {
      continue; // 没有 plugins/ 目录：这个工作区没有草稿
    }
    for (const folder of names.slice(0, DRAFTS_PER_WORKSPACE_MAX)) {
      const real = await realpath(join(pluginsDir, folder)).catch(() => null);
      if (real === null || !isInside(realWorkspace, real) || real === realWorkspace) continue;
      if (!(await stat(real).then((info) => info.isDirectory(), () => false))) continue;
      if (installedRoots.has(real)) continue;
      const problems: PluginProblem[] = [];
      const { manifest, manifestFile } = await readManifest(real, problems);
      if (manifestFile === null) continue; // 还没有清单：只是个空文件夹
      const rawName = typeof manifest["name"] === "string" && manifest["name"] !== "" ? manifest["name"] : basename(real).toLowerCase();
      const description = typeof manifest["description"] === "string" ? manifest["description"] : "";
      const session = await deps.sessionOf(real);
      entries.push({
        workspaceId: workspace.id,
        path: real,
        name: rawName,
        displayName: manifestDisplayName(manifest, rawName),
        description,
        updatedAt: await latestChange(real),
        sessionId: session?.sessionId ?? null,
        sessionTitle: session === null || session.title === "" ? null : session.title,
        manifestProblem: problems.length === 0 ? null : problems.map((problem) => problem.detail).join("; "),
      });
    }
  }
  // 最近动过的在前（每个工作区内的次序由渲染层按分组保持）
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 文件夹里最近一次改动：根目录与往下几层里所有条目的 mtime 取最大。
 * 不跟符号链接（lstat 语义用 withFileTypes 的 dirent 判断，只往真目录里走），条数封顶。
 */
export async function latestChange(root: string): Promise<number> {
  let latest = 0;
  let seen = 0;
  const visit = async (dir: string, depth: number): Promise<void> => {
    const info = await stat(dir).catch(() => null);
    if (info !== null) latest = Math.max(latest, info.mtimeMs);
    if (depth >= MTIME_DEPTH_MAX) return;
    const children = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const child of children) {
      if (seen >= MTIME_ENTRIES_MAX) return;
      if (MTIME_SKIP.has(child.name)) continue;
      seen += 1;
      const path = join(dir, child.name);
      if (child.isDirectory()) await visit(path, depth + 1);
      else if (child.isFile()) {
        const fileInfo = await stat(path).catch(() => null);
        if (fileInfo !== null) latest = Math.max(latest, fileInfo.mtimeMs);
      }
    }
  };
  await visit(root, 0);
  return latest;
}
