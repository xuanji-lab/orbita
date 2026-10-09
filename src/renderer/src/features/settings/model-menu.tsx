/**
 * 「挑一个模型」的卡片 —— 三个消费者共用：输入卡底栏的模型芯片、设置面的家务活模型、
 * 设置面的子会话模型（`ModelPickerMenu`）。
 *
 * 共用两层理由：
 * 1. **口径**：哪些厂商能用（填了 key 且声明过模型）、每个模型的上下文窗口与图片能力，
 *    必须与设置页同源（用户覆盖 > pi 目录 > 白名单 > 兜底）。复制一份的话，两处迟早
 *    对同一个模型说出两个上下文窗口。
 * 2. **形状**：左栏过滤、两行行、定高六行、宽度按全部模型里最长那一行定。三处各拼一遍
 *    就是这一刀返工五次的起因（2026-10-01）——所以外壳只有一个，谁也不许再拼。
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
import { Menu, menuFooterRowStyle, type MenuItem } from "../../shell/Menu";
import type { MenuPlacementSide } from "../../shell/menu-position";
import { hasCredentials, kindOf, modelAcceptsImage, modelContextText, railShortNames } from "./providers-view-model.ts";
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

/** 星标的键：两个 id 成对（与 AppSettings.starredModels 同一口径）。内部用，不导出——没有第二个消费者 */
function starKey(providerId: string, modelId: string): string {
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
  fontSize: "var(--font-size-micro)",
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
    <button type="button" className="option-row" style={menuFooterRowStyle} onClick={options.onConfigure}>
      <Icon name="plus" size={13} strokeWidth={1.8} />
      <span>{options.t.modelMenu.configure}</span>
      <span style={{ marginLeft: "auto", display: "inline-flex", color: "var(--color-text-tertiary)" }}>
        <Icon name="chevron-right" size={13} strokeWidth={1.8} />
      </span>
    </button>
  );
}

/**
 * 三处「挑一个模型」共用的卡片外壳：输入卡的模型芯片、设置面的家务活模型、子会话模型。
 *
 * 抽出来的理由比「口径同源」那条更强：这三处的**形状**必须一致（左栏过滤、
 * 两行行、定高六行、宽度按全部模型里最长的那一行定），各拼一遍 Menu 的 props 早晚会漂
 * ——而形状不一致正是这一刀返工五次的原因（2026-10-01）。
 *
 * 组件自己拿着左栏的选中态：那是「现在想找什么」的一时状态，不属于设置。
 */
export function ModelPickerMenu(props: {
  t: Messages;
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
  selected: { providerId: string; modelId: string } | null;
  starred: readonly { providerId: string; modelId: string }[];
  onToggleStar: (pair: { providerId: string; modelId: string }) => void;
  onSelect: (providerId: string, modelId: string) => void;
  /**
   * 过滤不掉的置顶项（设置面那两个「同会话 / 同父」）。它们不是模型，不进左栏过滤，
   * 但参与宽度尺——它们一直在，所以不影响「尺寸不跟着过滤变」。
   */
  leading?: MenuItem[];
  trigger: (state: { open: boolean; toggle: () => void }) => React.ReactNode;
  /** 底部固定行。只有输入卡给（「配置模型」）；设置面本身就在设置里，不用再来一个入口 */
  footer?: (close: () => void) => React.ReactNode;
  /** 原样转发给 Menu：输入卡给 `above`（芯片菜单朝上开），设置面与子会话面板用默认下方 */
  placement?: MenuPlacementSide;
}): React.ReactNode {
  const [scope, setScope] = useState<ModelScope>(MODEL_SCOPE_ALL);
  const pick = (range: ModelScope) =>
    modelCardItems({
      t: props.t,
      providers: props.providers,
      catalog: props.catalog,
      selected: props.selected,
      scope: range,
      starred: props.starred,
      onToggleStar: props.onToggleStar,
      onSelect: props.onSelect,
    });
  const visible = pick(scope);
  // 宽度尺要的是**不过滤**的那一份
  const all = scope.kind === "all" ? visible : pick(MODEL_SCOPE_ALL);
  const withLeading = (rows: MenuItem[]) => (props.leading === undefined ? rows : [...props.leading, ...rows]);
  /*
   * 一个可用的模型都没有时不摆卡片架子：没东西可筛却给一列空左栏 + 六行定高，
   * 看起来像坏了。退回普通菜单（设置面那两个 picker 在没配服务商时就是这个状态）。
   */
  const isCard = props.providers.length > 0;

  // 选着的那家被删了 / 没 key 了：过滤要跟着回「全部」，否则清单停在空集上
  useEffect(() => {
    if (scope.kind === "provider" && !props.providers.some((p) => p.id === scope.id)) {
      setScope(MODEL_SCOPE_ALL);
    }
  }, [scope, props.providers]);

  return (
    <Menu
      items={withLeading(visible)}
      searchable
      rail={
        isCard ? modelPickerRail({ t: props.t, providers: props.providers, scope, onScope: setScope }) : undefined
      }
      // 搜索是一切的旁路：左栏正亮着某家时去搜，必须复位到「全部」，
      // 否则会出现「左栏亮着智谱、列表里全是 deepseek」这种自相矛盾的画面
      onSearch={(query) => {
        if (query.trim() !== "") setScope(MODEL_SCOPE_ALL);
      }}
      // 三种空要说清是哪一种：星标一条都没星过 ≠ 在一家里面搜不到 ≠ 全部里搜不到
      emptyText={(query) => {
        if (scope.kind === "starred") return props.t.modelMenu.starredEmpty;
        if (scope.kind === "provider") return props.t.menu.noMatchInProvider(query);
        return props.t.menu.noModels;
      }}
      panelMaxHeight={520}
      panelMaxWidth={480}
      widthItems={isCard ? withLeading(all) : undefined}
      listRows={isCard ? 6 : undefined}
      placement={props.placement}
      trigger={props.trigger}
      footer={props.footer}
    />
  );
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
  const shortNames = railShortNames(options.providers);
  return (
    <>
      {/*
        左栏的宽度尺：选中那一格是 semibold（.option-row 的选中配方），比常规字重宽——
        不把「加粗后的宽度」也算进基准的话，切厂商时左栏会自己胖瘦，卡片宽度跟着动
        （2026-10-01 真机验收量到：379 → 369）。摆一份加粗的全部短名，不可见、不占高。
      */}
      <span
        aria-hidden
        style={{
          height: 0,
          overflow: "hidden",
          visibility: "hidden",
          whiteSpace: "nowrap",
          fontFamily: "var(--font-family-base)",
          // 与 RAIL_CELL 同一档（micro）：尺量错了，切厂商时左栏会自己胖瘦
          fontSize: "var(--font-size-micro)",
          fontWeight: "var(--weight-semibold)",
        }}
      >
        {options.providers.map((provider) => (
          // 横向 padding 与 RAIL_CELL 相同：尺比的是「格子整宽」——少算这 16px 的话，
          // 选中格变 semibold 时左栏还是会胖 1px（pr138 机器验收量到 61.55 → 62.55）
          <div key={`rail-ruler:${provider.id}`} style={{ padding: "0 var(--space-2)" }}>
            {shortNames.get(provider.id) ?? provider.displayName}
          </div>
        ))}
      </span>
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
            {shortNames.get(provider.id) ?? provider.displayName}
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
