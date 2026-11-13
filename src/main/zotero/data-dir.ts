/**
 * 找 Zotero 的数据目录。**纯模块**（不 import electron），可被 `node --test` 直接测。只读文件，不写任何东西。
 *
 * 顺序（与 Zotero 自己定位数据目录的规则一致：源码 xpcom/dataDirectory.js、xpcom/profile.js）：
 * 1. 开发 / 测试的覆盖：`ORBITA_ZOTERO_DATA_DIR`——**打包版不认**（同 data-dirs.ts 的 devDataDirs：packaged 直接不看）；
 * 2. Zotero 默认 profile 的 `prefs.js`：`extensions.zotero.useDataDir` 为 true 时用 `extensions.zotero.dataDir`；
 *    默认 profile 由 profile 根目录的 `profiles.ini` 里 `Default=1` 那一节给（只有一个 profile 时就是它）；
 * 3. 都没有：默认 `~/Zotero`（dataDirectory.js 的 defaultDir = homeDir + "Zotero"，各平台相同）。
 * 目录里没有 `zotero.sqlite` = 没找到。
 *
 * profile 根目录（Zotero 官方文档 kb/profile_directory）：
 * - macOS：`~/Library/Application Support/Zotero`（本机实测）；
 * - Windows：`%APPDATA%\Zotero\Zotero`（**未在 Windows 实测**）；
 * - Linux：`~/.zotero/zotero`（未实测）。
 *
 * 另从 prefs.js 取 `extensions.zotero.baseAttachmentPath`：链接文件的路径存成 `attachments:相对路径` 时相对它。
 */
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export interface ZoteroDataDir {
  dir: string;
  /** zotero.sqlite 的绝对路径 */
  database: string;
  /** 链接文件「attachments:」相对路径的基准目录；没设 = null */
  baseAttachmentPath: string | null;
  /** 怎么找到的（报告 / 错误说明用） */
  source: "override" | "prefs" | "default";
}

export interface DataDirEnv {
  home: string;
  platform: NodeJS.Platform;
  /** Windows 的 %APPDATA% */
  appData?: string;
  packaged: boolean;
  /** ORBITA_ZOTERO_DATA_DIR 的值 */
  override?: string;
}

/** 开发 / 测试覆盖：打包版不认 */
export function dataDirOverride(env: { packaged: boolean; override?: string }): string | null {
  if (env.packaged) return null;
  const value = env.override?.trim() ?? "";
  return value === "" ? null : value;
}

export function profileRoot(env: DataDirEnv): string | null {
  if (env.platform === "darwin") return join(env.home, "Library", "Application Support", "Zotero");
  if (env.platform === "win32") return env.appData === undefined || env.appData === "" ? null : join(env.appData, "Zotero", "Zotero");
  return join(env.home, ".zotero", "zotero");
}

/** profiles.ini → 默认 profile 的目录（Default=1 那节；没有标默认的就取第一节） */
export function defaultProfilePath(ini: string, root: string): string | null {
  const sections: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header !== null) {
      current = header[1]?.startsWith("Profile") === true ? {} : null;
      if (current !== null) sections.push(current);
      continue;
    }
    const pair = /^([^=]+)=(.*)$/.exec(line);
    if (pair !== null && current !== null) current[(pair[1] as string).trim()] = (pair[2] as string).trim();
  }
  const chosen = sections.find((s) => s["Default"] === "1") ?? sections[0];
  const path = chosen?.["Path"];
  if (path === undefined || path === "") return null;
  return chosen?.["IsRelative"] === "0" || isAbsolute(path) ? path : join(root, ...path.split("/"));
}

/** prefs.js 里一个 user_pref 的值（字符串或布尔）；Firefox 格式：`user_pref("name", value);`，字符串里 `\"` `\\` 转义 */
export function readPref(prefs: string, name: string): string | boolean | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^user_pref\\("${escaped}",\\s*(.+)\\);\\s*$`, "m").exec(prefs);
  if (match === null) return null;
  const value = (match[1] as string).trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return null;
}

async function hasDatabase(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "zotero.sqlite"))).isFile();
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** 找到返回目录与基准路径；找不到返回 null，`tried` 写上找过哪里（给错误说明） */
export async function findZoteroDataDir(env: DataDirEnv): Promise<{ found: ZoteroDataDir | null; tried: string[] }> {
  const tried: string[] = [];
  const root = profileRoot(env);
  let prefs: string | null = null;
  if (root !== null) {
    const ini = await readText(join(root, "profiles.ini"));
    const profile = ini === null ? null : defaultProfilePath(ini, root);
    if (profile !== null) prefs = await readText(join(profile, "prefs.js"));
  }
  const base = prefs === null ? null : readPref(prefs, "extensions.zotero.baseAttachmentPath");
  const baseAttachmentPath = typeof base === "string" && base !== "" ? base : null;
  const make = (dir: string, source: ZoteroDataDir["source"]): ZoteroDataDir => ({ dir, database: join(dir, "zotero.sqlite"), baseAttachmentPath, source });

  const override = dataDirOverride(env);
  if (override !== null) {
    tried.push(override);
    return { found: (await hasDatabase(override)) ? make(override, "override") : null, tried };
  }
  if (prefs !== null && readPref(prefs, "extensions.zotero.useDataDir") === true) {
    const dir = readPref(prefs, "extensions.zotero.dataDir");
    if (typeof dir === "string" && dir !== "") {
      tried.push(dir);
      if (await hasDatabase(dir)) return { found: make(dir, "prefs"), tried };
    }
  }
  const fallback = join(env.home, "Zotero");
  tried.push(fallback);
  return { found: (await hasDatabase(fallback)) ? make(fallback, "default") : null, tried };
}
