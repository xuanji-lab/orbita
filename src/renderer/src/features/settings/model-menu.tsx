/**
 * 「挑一个模型」的菜单构造 —— 两个消费者共用：输入卡底栏的模型芯片，
 * 与设置面的会话命名模型。
 *
 * 抽出来的理由是**这份菜单本身讲一个故事**：哪些厂商能用（填了 key 且声明过模型）、
 * 按厂商分组、每个模型带参数徽标，而参数口径必须与设置页同源（用户覆盖 > pi 目录 >
 * 白名单 > 兜底）。复制一份的话，两处迟早对同一个模型说出两个上下文窗口。
 */
import { useEffect, useState } from "react";
import type { BuiltinProvider } from "@shared/agent-ipc";
import { KNOWN_PROVIDERS } from "@shared/known-providers";
import { resolveModelDefaults } from "@shared/model-defaults";
import type { ProviderDto } from "@shared/provider";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import type { MenuItem } from "../../shell/Menu";
import { hasCredentials, kindOf, modelAcceptsImage, modelContextText } from "./providers-view-model.ts";

/**
 * 「配置好」= 设置里绿点的标准：api_key 已入库，或 env 档（密钥来自环境）——与 nav
 * 状态点共用 `hasCredentials`，两处不该对同一个厂商说两个答案。
 * 没填 key 的厂商与复制出来的副本不该出现在任何模型菜单里——选了也发不出去。
 */
export function usableProviders(providers: readonly ProviderDto[]): ProviderDto[] {
  return providers.filter((p) => hasCredentials(p.auth) && p.models.declared.length > 0);
}

/**
 * pi 内建目录：模型项的 ctx 徽标要从这里查官方参数。拉不到就空目录——
 * 徽标如实落到 fallback，不挡选模型。
 */
export function useBuiltinCatalog(): BuiltinProvider[] {
  const [catalog, setCatalog] = useState<BuiltinProvider[]>([]);
  useEffect(() => {
    void api.provider
      .builtins()
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);
  return catalog;
}

/**
 * 按厂商分组的模型菜单项：厂商名做组头行，模型行缩进其下只带参数徽标。
 *
 * @param providers 已过 `usableProviders` 的厂商列表
 * @param selected 当前选中的模型；null = 一个都没选（如设置面选了「Same as session」）
 */
export function modelMenuItems(options: {
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
  selected: { providerId: string; modelId: string } | null;
  onSelect: (providerId: string, modelId: string) => void;
}): MenuItem[] {
  return options.providers.flatMap((provider) => {
    const known = KNOWN_PROVIDERS.find((k) => k.id === kindOf(provider));
    // 按模型 id 跨目录推断：自建网关没有 catalogId，但它跑的型号在目录里多半有官方口径
    const defaultsOf = (id: string) =>
      resolveModelDefaults(options.catalog, id, { catalogId: known?.catalogId, api: known?.api });
    const rows: MenuItem[] = [
      { id: `hdr:${provider.id}`, label: provider.displayName, header: true },
    ];
    for (const declared of provider.models.declared) {
      const defaults = defaultsOf(declared.id);
      const badge = modelContextText(declared, defaults);
      rows.push({
        id: `${provider.id}:${declared.id}`,
        label: declared.id,
        badge: (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
            <span className="pv-badge" title="Context window">
              {badge.text}
            </span>
            {modelAcceptsImage(declared, defaults) && (
              <span className="pv-badge" title="Accepts image input — multimodal">
                <Icon name="image" size={11} strokeWidth={1.8} />
              </span>
            )}
          </span>
        ),
        checked:
          options.selected?.providerId === provider.id &&
          options.selected.modelId === declared.id,
        onSelect: () => options.onSelect(provider.id, declared.id),
      });
    }
    return rows;
  });
}
