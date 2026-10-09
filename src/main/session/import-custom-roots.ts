/**
 * 自定义来源路径的持久化与合并 —— 纯模块：不 import electron，可被 `node --test` 直接测。
 *
 * 用户手动指定、validate 过的来源数据目录清单（背景与词汇见 shared/import.ts 的
 * ImportCustomRoot）。落盘在 userData 下的 `import-custom-roots.json`，原子写
 * （AGENTS.md「本地优先」）。为什么不并进 settings.json：settings 是「应用怎么表现」的
 * 键值（主题 / 模型 / 抽屉），这份是用户攒下的一份数据清单，生命周期跟着迁移域走；
 * settings 的 patch 深合并语义也不适合数组——整块覆盖会吃掉别的键的并发写。
 * 容错同 settings：读不了 / 坏 JSON 退回空清单——清单丢了再添一次就是，不值得让迁移页起不来。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import {
  IMPORT_CUSTOM_ROOT_INVALID_CODE,
  isCustomRootSource,
  type ImportCustomRoot,
  type ImportCustomRootInput,
} from "../../shared/import.ts";
import { DATA_ROOT_SPECS, hasDirectory, type DataRootSpec } from "./import-locate.ts";

/** 自定义路径支持的来源（主进程侧的口径：有定位规格的那批）。 */
export type CustomRootSource = ImportCustomRoot["source"];

/** 落盘形状：{ "roots": [{ source, dir }, …] }（包一层对象，往后加字段不用改数组语义）。 */
interface CustomRootsFile {
  roots: ImportCustomRoot[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 展开路径开头的 `~`（只认单独的 `~` 与 `~/` 前缀，其余原样）：粘贴进来最常见的写法。
 * 纯函数（home 作参数），测试不必碰真实家目录。
 */
export function expandHome(rawDir: string, home: string): string {
  if (rawDir === "~") return home;
  if (rawDir.startsWith("~/")) return join(home, rawDir.slice(2));
  return rawDir;
}

export class CustomRootsStore {
  private readonly filePath: string;

  constructor(dir: string) {
    this.filePath = join(dir, "import-custom-roots.json");
  }

  /** 读清单：文件不存在 / 坏 JSON / 混进不认识的条目都滤掉（不抛，理由见模块头）。 */
  async read(): Promise<ImportCustomRoot[]> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch {
      return [];
    }
    if (!isRecord(parsed) || !Array.isArray(parsed["roots"])) return [];
    const out: ImportCustomRoot[] = [];
    for (const entry of parsed["roots"]) {
      if (!isRecord(entry)) continue;
      const source = entry["source"];
      const dir = entry["dir"];
      if (!isCustomRootSource(source) || typeof dir !== "string" || dir === "") continue;
      out.push({ source, dir });
    }
    return out;
  }

  /**
   * 添加：展开 ~ → resolve 成绝对路径 → 是目录 → 该来源的 validate（聊天记录在不在）→
   * 不与已添加的重复，五关都过才落盘。不过的抛 `IMPORT_CUSTOM_ROOT_INVALID:` + reason
   * （renderer 按码翻文案）。返回更新后的清单。
   */
  async add(source: CustomRootSource, rawDir: string): Promise<ImportCustomRoot[]> {
    const spec = DATA_ROOT_SPECS[source];
    const dir = resolve(expandHome(rawDir, homedir()));
    if (!(await hasDirectory(dir))) {
      throw new Error(IMPORT_CUSTOM_ROOT_INVALID_CODE + "not-found");
    }
    if (!(await spec.validate(dir))) {
      throw new Error(IMPORT_CUSTOM_ROOT_INVALID_CODE + "no-data");
    }
    const current = await this.read();
    if (current.some((root) => root.source === source && resolve(root.dir) === dir)) {
      throw new Error(IMPORT_CUSTOM_ROOT_INVALID_CODE + "duplicate");
    }
    return this.persist([...current, { source, dir }]);
  }

  /** 移除一条（按 resolve 后的路径认；不在清单里是幂等空操作）。目录本身永不被碰。 */
  async remove(source: CustomRootSource, rawDir: string): Promise<ImportCustomRoot[]> {
    const dir = resolve(expandHome(rawDir, homedir()));
    const next = (await this.read()).filter(
      (root) => !(root.source === source && resolve(root.dir) === dir),
    );
    return this.persist(next);
  }

  private async persist(next: ImportCustomRoot[]): Promise<ImportCustomRoot[]> {
    const file: CustomRootsFile = { roots: next };
    await writeJsonAtomic(this.filePath, file);
    return next;
  }
}

/**
 * 自动定位的结果与自定义路径合并，探测 / 扫描 / 执行三处共用（重扫一致，勾选才不对错位）。
 * 顺序稳定：自动定位到的（env → canonical → 变体）在前，自定义路径按添加顺序垫后——
 * 排前的胜（importer.ts 的 dedupeAcrossRoots）：自动定位到的是产品自己写数据的家，
 * 同名会话两边都有时留那边一份。去重按 resolve 后的路径。
 *
 * 自定义路径此刻仍要过 validate：数据可能已被删或挪走，过不了的这次不进清单——
 * 探测的 paths 是「扫描会读什么」的隐私声明，读不了的不该列。自动定位那半不再验：
 * findDataRoots 已验过，而且探测的兜底根（规范位置）本来就可能不在盘上。
 */
export async function mergeCustomRoots(
  auto: readonly string[],
  custom: readonly string[],
  spec: DataRootSpec,
): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of auto) {
    const resolved = resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  for (const dir of custom) {
    const resolved = resolve(dir);
    if (seen.has(resolved)) continue;
    if (!(await spec.validate(resolved))) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** 清单里属于某个来源的目录（保持添加顺序）。 */
export function dirsOf(roots: readonly ImportCustomRoot[], source: CustomRootSource): string[] {
  return roots.filter((root) => root.source === source).map((root) => root.dir);
}
