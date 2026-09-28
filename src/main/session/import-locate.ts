/**
 * 迁移来源的数据目录定位 —— 纯模块：不 import electron，可被 `node --test` 直接测。
 *
 * 背景：此前各来源的数据目录写死单一路径，而且写的是开发者自己机器上的（Proma 写死
 * `~/.proma-dev`，Windows 用户只有 `~/.proma`，整个来源被判成没装；Reasonix 写死 Windows 的
 * %APPDATA%）。实际上一台机器常常同时有几个数据目录——正式版、开发版、分支版各一个
 * （`~/.zcode`、`~/.zcode-worktree`、`~/.zcode1`、`~/.test-zcode`），哪台机器上有哪几个说不准。
 *
 * 定位规则（用户裁决，原话「只要扫描到 zcode，看下名字是 zcode 的变体，进去看聊天记录在不在，
 * 在就说明找对地方了」）：在基础目录第一层找**名字里含产品名的目录（小写比较）**，再用
 * validate（聊天记录在不在）挡误判——名字放宽是因为变体的后缀不可穷举（`-dev`、`-fork`、
 * `1`、`.test-` 前缀……），内容检查才是「这里真的有聊天记录」的证据。本机真实误判样本：
 * `~/.codexbar` 是别的工具、`~/.kimi-cu` 与 `~/.kimi-work` 是 Kimi 的别的产品，都没有会话数据，
 * 名字撞上但 validate 不过，不算。
 *
 * 环境变量（CLAUDE_CONFIG_DIR / CODEX_HOME）优先：用户显式指定压过一切命名惯例——名字可以
 * 不含产品名、也不必在基础目录下，validate 过就算。
 *
 * 顺序必须稳定（env → canonical → 其余按名字）：执行导入时会重扫，用户在页面上勾的是扫描时
 * 看到的路径，两次扫描顺序不一样勾选会对错位。这个顺序同时决定几个目录里内容相同的会话留
 * 哪一份（排前面的胜），见 importer.ts 的 dedupeAcrossRoots。
 */
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ImportSourceId } from "../../shared/import.ts";

/** 基础目录挂在哪个平台惯例下。 */
export type DataRootBase = "home" | "appData" | "xdgData";

/** 定位的全部环境依赖：platform / home / env 由主进程注入，测试注入假值。 */
export interface LocateContext {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

/**
 * 基础目录的绝对路径。
 *
 * env 取值用 `||` 不是 `??`：环境变量空串同缺席（与 reasonixDataRoot 同款纪律），否则
 * 空串会让 join("") 塌成一个相对进程 cwd 的路径。
 *
 * - home：家目录本身（CLI 工具的点文件夹都在这里）
 * - appData：Electron userData 惯例。win32 = %APPDATA%（缺了退 home/AppData/Roaming）、
 *   darwin = ~/Library/Application Support、其余 = $XDG_CONFIG_HOME（缺了退 ~/.config）
 * - xdgData：XDG data 惯例，**所有平台同一个**（$XDG_DATA_HOME || ~/.local/share）——
 *   opencode 自己就这么放，macOS 上也在 ~/.local/share，不进 Library
 */
export function baseDir(base: DataRootBase, ctx: LocateContext): string {
  const { platform, home, env } = ctx;
  if (base === "home") return home;
  if (base === "xdgData") return env["XDG_DATA_HOME"] || join(home, ".local", "share");
  if (platform === "win32") return env["APPDATA"] || join(home, "AppData", "Roaming");
  if (platform === "darwin") return join(home, "Library", "Application Support");
  return env["XDG_CONFIG_HOME"] || join(home, ".config");
}

/** 一个来源怎么找它的数据目录（`DATA_ROOT_SPECS` 的条目形状）。 */
export interface DataRootSpec {
  /** 目录名里要含的产品名（小写比较；`.zcode-wt`、`.ZCode-Backup` 都算 zcode 的变体） */
  token: string;
  /** 默认目录名（找到了排最前；与 token 同款小写比较） */
  canonical: string;
  /** 在哪个基础目录的第一层找 */
  base: DataRootBase;
  /**
   * 环境变量直接指定一个数据目录：有值（非空串）时先于一切命名惯例检查，目录名可以
   * 不含 token、也不必在 base 下，validate 过就算。不设 = 没有这个入口
   */
  env?: string;
  /** 聊天记录在不在——名字撞上但这里不过的目录不算（挡 `.codexbar`、`.kimi-cu` 这类误判） */
  validate(dir: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// validate 用的 stat 小件（只 stat，不读内容；ENOENT / 断链 / 权限都算不在）
// ---------------------------------------------------------------------------

async function hasFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function hasDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 各来源的定位规格。validate 的依据是导入器实际要读的会话入口文件（见 importer.ts 与
 * import-ipc.ts 里的 *Paths）：聊天记录的入口在，扫描就有活干；入口不在，目录名再像也不算。
 */
export const DATA_ROOT_SPECS: Record<Exclude<ImportSourceId, "agent-skills">, DataRootSpec> = {
  proma: {
    token: "proma",
    canonical: ".proma",
    base: "home",
    // agent-sessions.json 是会话索引；旧数据根可能只剩 sdk-config/sessions（pi 真源）——
    // 索引里的源文件路径会指过去，两处入口任一在就算
    validate: async (dir) =>
      (await hasFile(join(dir, "agent-sessions.json"))) || (await hasDirectory(join(dir, "sdk-config", "sessions"))),
  },
  "claude-code": {
    token: "claude",
    canonical: ".claude",
    base: "home",
    env: "CLAUDE_CONFIG_DIR",
    // projects/ 按工作目录分子目录放会话 JSONL
    validate: (dir) => hasDirectory(join(dir, "projects")),
  },
  "kimi-code": {
    token: "kimi",
    canonical: ".kimi-code",
    base: "home",
    // sessions/<工作区>/<会话>/agents/main/wire.jsonl
    validate: (dir) => hasDirectory(join(dir, "sessions")),
  },
  opencode: {
    token: "opencode",
    canonical: "opencode",
    base: "xdgData",
    // opencode.db：SQLite 会话库（session/message/part 三表）
    validate: (dir) => hasFile(join(dir, "opencode.db")),
  },
  reasonix: {
    token: "reasonix",
    canonical: "reasonix",
    base: "appData",
    // projects/<项目>/sessions/*.jsonl
    validate: (dir) => hasDirectory(join(dir, "projects")),
  },
  zcode: {
    token: "zcode",
    canonical: ".zcode",
    base: "home",
    // cli/db/db.sqlite：与 opencode 同形的会话库
    validate: (dir) => hasFile(join(dir, "cli", "db", "db.sqlite")),
  },
  codex: {
    token: "codex",
    canonical: ".codex",
    base: "home",
    env: "CODEX_HOME",
    // sessions/YYYY/MM/DD/rollout-*.jsonl
    validate: (dir) => hasDirectory(join(dir, "sessions")),
  },
};

/** 码点序（小写后比较）：不依赖 locale，任何机器上排出的顺序都一样。 */
function byLowerName(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/**
 * 找一个来源的全部数据目录，顺序稳定：env 指定的（若通过 validate）→ canonical → 其余按
 * 名字排。只看基础目录的第一层；基础目录读不了（不存在 / 没权限）返回只剩 env 的部分。
 * 去重按 resolve 后的路径——env 指定与扫描撞到同一个目录时只出现一次，返回值也是
 * resolve 后的绝对路径。
 */
export async function findDataRoots(spec: DataRootSpec, ctx: LocateContext): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();

  // 候选的收编：是目录、validate 过、没见过，三者都过才进结果
  const consider = async (dir: string): Promise<void> => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    if (!(await hasDirectory(dir))) return;
    if (!(await spec.validate(dir))) return;
    seen.add(resolved);
    out.push(resolved);
  };

  if (spec.env) {
    const envDir = ctx.env[spec.env];
    // 空串当缺席（baseDir 同款纪律）：不指定，而不是 resolve("") 出一个进程 cwd
    if (envDir) await consider(envDir);
  }

  const base = baseDir(spec.base, ctx);
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return out;
  }
  const canonicalLower = spec.canonical.toLowerCase();
  const matched = names.filter((name) => name.toLowerCase().includes(spec.token)).sort(byLowerName);
  const ordered = [
    ...matched.filter((name) => name.toLowerCase() === canonicalLower),
    ...matched.filter((name) => name.toLowerCase() !== canonicalLower),
  ];
  for (const name of ordered) await consider(join(base, name));
  return out;
}
