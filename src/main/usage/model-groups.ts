/**
 * 「一个型号」的口径——价格 · 能力图与侧栏用量格共用的一份。**纯模块**，可被 `node --test` 直接测。
 *
 * 同一条榜单基名下的全部已添加（服务商，id）合成一个型号（k3 挂在 Kimi Code、kimi-k3 挂在
 * Anthropic 兼容，合成一个 Kimi K3）；不在任何榜上的 id 各自成组。用户 2026-10-24：「其实只要
 * 看得出模型的数据就好了，不关心它有多少个服务商」。
 */
import type { BuiltinProvider } from "../../shared/agent-ipc.ts";
import { catalogPreferenceOf, knownProviderOf } from "../../shared/known-providers.ts";
import { modelDisplayName } from "../../shared/model-defaults.ts";
import type { ModelCostDecl, Provider } from "../../shared/provider.ts";
import { boardBaseOf, type BoardIndex } from "./arena-board.ts";
import { officialRates } from "./task-cost.ts";

export interface ModelGroup {
  key: string;
  /** 榜单基名；不在榜上的 id 为 undefined */
  base: string | undefined;
  /** 代表 id：服务商列表里最先添加的那个（显示名与头像按它取） */
  modelId: string;
  /**
   * 这个型号的官方单价：成员按服务商列表的顺序逐个用 officialRates 查（用户自填 > 本家目录 >
   * 全目录），**取第一个查得到的**。几家查到的价不同时以先添加的那家为准——同一个型号的官方价
   * 本该是一个数，不同多半是某家目录或用户自填有偏差，取哪个都要有个确定的规则。
   */
  rates: ModelCostDecl | null;
  /** 显示名（modelDisplayName，按代表 id 与声明它的那家服务商） */
  name: string;
  /** 头像第三级兜底用的服务商（厂商条目 id 与显示名） */
  vendor: { kindId: string; label: string };
  /** 是不是已添加的型号（任务账本里还有删掉的服务商留下的任务） */
  added: boolean;
}

export interface ModelGroups {
  /** 已添加的型号，按服务商列表里第一次出现的顺序 */
  added: readonly ModelGroup[];
  /**
   * 任意（服务商，id）所属的型号：已添加的归到它的组；没添加的（服务商删掉了、或从没声明过）
   * 现建一组——单价按全目录查，名字按目录，头像兜底用记录上的服务商 id。
   */
  of(modelId: string, providerId: string): ModelGroup;
}

const keyOf = (base: string | undefined, modelId: string): string =>
  base === undefined ? `id:${modelId}` : `base:${base}`;

export function modelGroups(
  providers: readonly Provider[],
  catalog: readonly BuiltinProvider[],
  index: BoardIndex,
): ModelGroups {
  const groups = new Map<string, ModelGroup>();
  for (const provider of providers) {
    const known = knownProviderOf(provider);
    const prefer = catalogPreferenceOf(known, provider.endpoint.api);
    for (const decl of provider.models.declared) {
      const base = boardBaseOf(decl.id, index);
      const key = keyOf(base, decl.id);
      const group = groups.get(key) ?? {
        key,
        base,
        modelId: decl.id,
        rates: null,
        name: modelDisplayName(catalog, decl.id, prefer, decl.name),
        vendor: { kindId: known.id, label: provider.displayName },
        added: true,
      };
      group.rates ??= officialRates(catalog, decl.id, prefer, decl.cost);
      groups.set(key, group);
    }
  }
  const added = [...groups.values()];
  return {
    added,
    of(modelId, providerId) {
      const base = boardBaseOf(modelId, index);
      const key = keyOf(base, modelId);
      const hit = groups.get(key);
      if (hit !== undefined) return hit;
      const extra: ModelGroup = {
        key,
        base,
        modelId,
        rates: officialRates(catalog, modelId, {}, undefined),
        name: modelDisplayName(catalog, modelId),
        vendor: { kindId: providerId, label: providerId },
        added: false,
      };
      groups.set(key, extra);
      return extra;
    },
  };
}
