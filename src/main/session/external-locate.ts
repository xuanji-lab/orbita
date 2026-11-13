/**
 * 外部来源的数据目录在哪：自动发现（import-locate.ts 的定位规格：环境变量 → 默认目录 → 名字
 * 变体）+ 用户手动加的自定义目录（import-custom-roots.ts）。Kimi Work 没有定位规格，只认它
 * 桌面运行时在 appData 下的那一个目录。
 *
 * 自定义目录**不在这里过 validate**：目录被挪走或删掉后仍然列着，由读取方如实报「这里没有会话
 * 数据」——静默丢掉会让用户以为那批会话被 Orbita 弄丢了。
 */
import { join, resolve } from "node:path";
import type { ImportCustomRoot } from "../../shared/import.ts";
import { EXTERNAL_SOURCE_IDS, type ExternalSourceId } from "../../shared/external-sources.ts";
import { kimiWorkDataRoot } from "./external-adapters.ts";
import { dirsOf } from "./import-custom-roots.ts";
import { baseDir, DATA_ROOT_SPECS, findDataRoots, hasDirectory, type LocateContext } from "./import-locate.ts";

export interface LocatedExternalSource {
  source: ExternalSourceId;
  /** 要读的数据目录：自动发现的在前，自定义的按添加顺序垫后（resolve 后去重） */
  roots: string[];
  /** 一个都没发现时，默认会去哪里找（设置页写「没找到：<这里>」） */
  expected: string;
  /** 默认位置的目录在不在（在、却没有会话数据 → 设置页写「目录在，没有会话」） */
  expectedExists: boolean;
}

export async function locateExternalSources(
  context: LocateContext,
  custom: readonly ImportCustomRoot[],
): Promise<LocatedExternalSource[]> {
  return Promise.all(
    EXTERNAL_SOURCE_IDS.map(async (source): Promise<LocatedExternalSource> => {
      if (source === "kimi-work") {
        const root = kimiWorkDataRoot(baseDir("appData", context));
        return {
          source,
          roots: (await hasDirectory(join(root, "sessions"))) ? [root] : [],
          expected: root,
          expectedExists: await hasDirectory(root),
        };
      }
      const spec = DATA_ROOT_SPECS[source];
      const roots: string[] = [];
      for (const dir of [...(await findDataRoots(spec, context)), ...dirsOf(custom, source)]) {
        const resolved = resolve(dir);
        if (!roots.includes(resolved)) roots.push(resolved);
      }
      const fromEnv = spec.env === undefined ? undefined : context.env[spec.env];
      const expected = fromEnv || join(baseDir(spec.base, context), spec.canonical);
      return { source, roots, expected, expectedExists: await hasDirectory(expected) };
    }),
  );
}
