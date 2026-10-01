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
import type { ModelDecl } from "@shared/provider";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import type { MenuItem } from "../../shell/Menu";
import { hasCredentials, kindOf, modelAcceptsImage, modelContextText } from "./providers-view-model.ts";
import type { Messages } from "../../messages-en.ts";

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

/** 某厂商下某个模型的参数兜底（按模型 id 跨目录推断：自建网关没有 catalogId，但它跑的型号在目录里多半有官方口径） */
function defaultsFor(provider: ProviderDto, catalog: readonly BuiltinProvider[], modelId: string) {
  const known = KNOWN_PROVIDERS.find((k) => k.id === kindOf(provider));
  return resolveModelDefaults(catalog, modelId, { catalogId: known?.catalogId, api: known?.api });
}

/**
 * 选中的模型能不能看图——与菜单里的图片徽标同一套口径（用户覆盖 > 目录 > 兜底）。
 * 输入框靠它在有附图时提醒「这个模型看不到」。找不到厂商 / 模型就当能看：
 * 不确定时不吓人，发出去 pi 也只是换成占位文字。
 */
export function selectedModelAcceptsImage(
  providers: readonly ProviderDto[],
  catalog: readonly BuiltinProvider[],
  selected: { providerId: string; modelId: string } | null,
): boolean {
  if (selected === null) return true;
  const provider = providers.find((p) => p.id === selected.providerId);
  const declared = provider?.models.declared.find((m) => m.id === selected.modelId);
  if (provider === undefined || declared === undefined) return true;
  return modelAcceptsImage(declared, defaultsFor(provider, catalog, declared.id));
}

/**
 * 按厂商分组的模型菜单项：厂商名做组头行，模型行缩进其下只带参数徽标。
 *
 * @param providers 已过 `usableProviders` 的厂商列表
 * @param selected 当前选中的模型；null = 一个都没选（如设置面选了「Same as session」）
 */
export function modelMenuItems(options: {
  /** 文案表：徽标的悬停说明跟界面语言走 */
  t: Messages;
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
  selected: { providerId: string; modelId: string } | null;
  onSelect: (providerId: string, modelId: string) => void;
}): MenuItem[] {
  return options.providers.flatMap((provider) => {
    const defaultsOf = (id: string) => defaultsFor(provider, options.catalog, id);
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
            <span className="pv-badge" title={options.t.modelMenu.contextWindow}>
              {badge.text}
            </span>
            {modelAcceptsImage(declared, defaults) && (
              <span className="pv-badge" title={options.t.modelMenu.acceptsImage}>
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

/**
 * 左栏的选中态。
 *
 * 用 provider 实例 id，不用 kind：同一个 kind 可以有两个实例（两把 key 的自建网关），
 * 而右栏列的是实例。星标是**跨厂商**的一维，所以自成一档，不跟厂商交集
 * （交集会造出空集：星标里恰好没有某家的模型时，用户对着两格都亮着的地方看到空卡片）。
 */
export type ModelScope =
  | { kind: "all" }
  | { kind: "starred" }
  | { kind: "provider"; id: string };

/** 「全部」在状态里的值。默认态，也是搜索时的复位目标 */
export const MODEL_SCOPE_ALL: ModelScope = { kind: "all" };

/** 星标的键：两个 id 成对（与 AppSettings.starredModels 同一口径） */
export function starKey(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

/**
 * 左栏一格。**纯图标格（星标 / 全部）与厂商格共用这一套尺寸**：两组混在一列里，
 * 行高与左缘对不上就会看起来是两件没拼上的东西。左缘是同一个起点——没有图标槽，
 * 厂商格的文字就落在纯图标格图标的同一条线上（2026-10-01 定）。
 */
const RAIL_CELL: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  minHeight: "var(--control-height-md)",
  padding: "0 var(--space-2)",
  border: 0,
  borderRadius: "var(--radius-sm)",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-caption)",
  textAlign: "left",
  cursor: "pointer",
};

/** 底部固定行（「配置模型」）。整行可点，右端一个 chevron 说明它领着你去别处 */
const FOOTER_ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  minHeight: "var(--control-height-lg)",
  padding: "0 var(--space-2)",
  border: 0,
  borderRadius: "var(--radius-sm)",
  color: "var(--color-text-primary)",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-control)",
  textAlign: "left",
  cursor: "pointer",
};

/**
 * 卡片底部的「配置模型」——去了就没模型的出口。
 *
 * 这个卡片会**筛掉没配 key 的厂商**（usableProviders）：只看得见一家的用户，
 * 在这张卡片里看不出「别的厂商不是不存在，是你没配」。这行是卡片里唯一能把
 * 这件事说清楚的地方，也是左栏为什么只有几家那个问题的答案。
 */
export function modelCardFooter(options: { t: Messages; onConfigure: () => void }): React.ReactNode {
  return (
    <button type="button" className="option-row" style={FOOTER_ROW} onClick={options.onConfigure}>
      <Icon name="plus" size={13} strokeWidth={1.8} />
      <span>{options.t.modelMenu.configure}</span>
      <span style={{ marginLeft: "auto", display: "inline-flex", color: "var(--color-text-tertiary)" }}>
        <Icon name="chevron-right" size={13} strokeWidth={1.8} />
      </span>
    </button>
  );
}

/** 厂商在左栏里的短名。改过名的实例显示他起的名字——那列说的是「哪个接入」 */
function railShortName(provider: ProviderDto): string {
  const known = KNOWN_PROVIDERS.find((k) => k.id === kindOf(provider));
  if (known === undefined || provider.displayName !== known.label) return provider.displayName;
  return known.short;
}

/**
 * 模型卡片的左栏：星标 / 全部 / 各厂商（**单选互斥**）。
 *
 * 星标格永远描边、不填实：星形的**填充在这个应用里只有一个意思**——「这个模型已星标」
 * （会话行在用）。选中那一格说的是「现在只看星标」，那是视图状态，走 .option-row 的
 * 选中底（aria-selected），不借填充去说。
 *
 * 不用像设置面那样列「组头」：左栏已经把厂商说了一遍，行里只在副行重复一次。
 */
export function modelPickerRail(options: {
  t: Messages;
  providers: readonly ProviderDto[];
  scope: ModelScope;
  onScope: (scope: ModelScope) => void;
}): React.ReactNode {
  return (
    <>
      <button
        type="button"
        className="option-row"
        style={RAIL_CELL}
        title={options.t.modelMenu.starred}
        aria-label={options.t.modelMenu.starred}
        aria-selected={options.scope.kind === "starred"}
        onClick={() => options.onScope({ kind: "starred" })}
      >
        <Icon name="star" size={13} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="option-row"
        style={RAIL_CELL}
        title={options.t.menu.all}
        aria-label={options.t.menu.all}
        aria-selected={options.scope.kind === "all"}
        onClick={() => options.onScope(MODEL_SCOPE_ALL)}
      >
        <Icon name="menu" size={13} strokeWidth={1.8} />
      </button>
      {options.providers.map((provider) => (
        <button
          key={provider.id}
          type="button"
          className="option-row"
          style={RAIL_CELL}
          title={provider.displayName}
          aria-selected={options.scope.kind === "provider" && options.scope.id === provider.id}
          onClick={() => options.onScope({ kind: "provider", id: provider.id })}
        >
          <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
            {railShortName(provider)}
          </span>
        </button>
      ))}
    </>
  );
}

/**
 * 模型卡片的行：**两行**（模型名 + 它属于哪家）、右端一颗星。
 *
 * 与设置面那份的差别全部来自左栏：厂商归属已经在左栏可见，所以这里不再插组头行
 * （组头 + 左栏是在同一句话上说两遍），厂名改从副行说。
 *
 * 星标视图（scope=starred）**按加入顺序**列，不按厂商分组：星标的意义就是
 * 「我挑出来的这几个」，再按厂商拢回去等于又把它搅成全量清单的形状。
 * 星标过的模型后来没 key 了 / 从声明里消失：静默剔除（同 drawer.docked 丢已删会话）。
 */
export function modelCardItems(options: {
  t: Messages;
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
  selected: { providerId: string; modelId: string } | null;
  scope: ModelScope;
  starred: readonly { providerId: string; modelId: string }[];
  onToggleStar: (pair: { providerId: string; modelId: string }) => void;
  onSelect: (providerId: string, modelId: string) => void;
}): MenuItem[] {
  const starredKeys = new Set(options.starred.map((pair) => starKey(pair.providerId, pair.modelId)));
  const rowFor = (provider: ProviderDto, declared: ModelDecl): MenuItem => {
    const known = KNOWN_PROVIDERS.find((k) => k.id === kindOf(provider));
    const defaults = resolveModelDefaults(options.catalog, declared.id, {
      catalogId: known?.catalogId,
      api: known?.api,
    });
    const context = modelContextText(declared, defaults);
    const isStarred = starredKeys.has(starKey(provider.id, declared.id));
    return {
      id: starKey(provider.id, declared.id),
      label: declared.id,
      subLabel: provider.displayName,
      badge: (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}>
          <span className="pv-badge" title={options.t.modelMenu.contextWindow}>
            {context.text}
          </span>
          {modelAcceptsImage(declared, defaults) && (
            <span className="pv-badge" title={options.t.modelMenu.acceptsImage}>
              <Icon name="image" size={11} strokeWidth={1.8} />
            </span>
          )}
        </span>
      ),
      checked:
        options.selected?.providerId === provider.id && options.selected.modelId === declared.id,
      trailing: (
        /*
         * 与**会话行的星标同一套**（Sidebar 的 meta.starred 那颗）：同一个 IconButton、
         * 同一个 accent 色、同样「已星标常显、未星标只在悬停/键盘聚焦时浮出」。
         * 两处的星长得不一样比不好看更糟——同一个手势在两处给不同反馈，用户会怀疑
         * 它们是不是一件事（2026-10-01 用户点名要求统一）。
         */
        <IconButton
          label={isStarred ? options.t.modelMenu.unstar : options.t.modelMenu.star}
          title={isStarred ? options.t.modelMenu.starredTip : options.t.modelMenu.star}
          size={20}
          onClick={() => options.onToggleStar({ providerId: provider.id, modelId: declared.id })}
          className="reveal"
          style={{
            borderRadius: "var(--radius-xs)",
            marginRight: "var(--space-1)",
            color: isStarred ? "var(--color-accent)" : "var(--color-text-tertiary)",
            opacity: isStarred ? 1 : undefined,
          }}
        >
          <Icon name="star" size={13} strokeWidth={1.8} fill={isStarred} />
        </IconButton>
      ),
      onSelect: () => options.onSelect(provider.id, declared.id),
    };
  };

  const scope = options.scope;
  if (scope.kind === "starred") {
    return options.starred.flatMap((pair) => {
      const provider = options.providers.find((p) => p.id === pair.providerId);
      const declared = provider?.models.declared.find((m) => m.id === pair.modelId);
      if (provider === undefined || declared === undefined) return [];
      return [rowFor(provider, declared)];
    });
  }
  const shown =
    scope.kind === "provider" ? options.providers.filter((p) => p.id === scope.id) : options.providers;
  return shown.flatMap((provider) => provider.models.declared.map((declared) => rowFor(provider, declared)));
}
