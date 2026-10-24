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
import { createPortal } from "react-dom";
import type { BuiltinProvider } from "@shared/agent-ipc";
import { modelDisplayName, resolveModelDefaults } from "@shared/model-defaults";
import type { ProviderDto } from "@shared/provider";
import type { ModelDecl } from "@shared/provider";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { Menu, menuFooterRowStyle, type MenuItem } from "../../shell/Menu";
import type { MenuPlacementSide } from "../../shell/menu-position";
import { useHoverTooltip } from "../../shell/useHoverTooltip.ts";
import {
  hasCredentials,
  modelAcceptsImage,
  modelContextText,
  MODEL_SCOPE_ALL,
  modelPreferenceOf,
  type ModelScope,
  openingModelScope,
  railVendorCell,
} from "./providers-view-model.ts";
import { ModelAvatar } from "./ModelAvatar";
import { VendorLogo } from "./VendorLogo";
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
    let live = true;
    void api.provider
      .builtins()
      .then((providers) => {
        if (live) setCatalog(providers);
      })
      .catch(() => {
        if (live) setCatalog([]);
      });
    // 目录在后台从 pi.dev 刷新完会再广播一次：开着的菜单与设置页跟着换，不用刷新窗口
    const off = api.agent.onEvent((event) => {
      if (event.type === "builtins") setCatalog(event.providers);
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return catalog;
}

/** 某厂商下某个模型的参数兜底（按模型 id 跨目录推断：自建网关没有 catalogId，但它跑的型号在目录里多半有官方口径） */
function defaultsFor(provider: ProviderDto, catalog: readonly BuiltinProvider[], modelId: string) {
  return resolveModelDefaults(catalog, modelId, modelPreferenceOf(provider));
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
 * 模型芯片（输入卡底栏、子会话面板两处）显示什么：型号头像 + 显示名，不带服务商名
 * （2026-10-24 用户：「要，还要显示 avatar。可以不用显示渠道名，就 avatar + 模型名字」）。
 * 服务商与型号 id 退到悬停提示里——同一型号挂在两家时靠它分辨。
 * 显示名、头像与模型卡片同一套口径（modelDisplayName / ModelAvatar）。
 * 选中的服务商已被删 / 没 key 了：头像按型号 id 认（第三级退到首字），名字照样按目录查。
 */
export function modelChipParts(
  providers: readonly ProviderDto[],
  catalog: readonly BuiltinProvider[],
  selected: { providerId: string; modelId: string },
): { avatar: React.ReactNode; name: string; detail: string } {
  const provider = providers.find((p) => p.id === selected.providerId);
  const declared = provider?.models.declared.find((m) => m.id === selected.modelId);
  const prefer = provider === undefined ? {} : modelPreferenceOf(provider);
  const name = modelDisplayName(catalog, selected.modelId, prefer, declared?.name);
  const cell =
    provider === undefined ? { kindId: selected.providerId, label: selected.providerId } : railVendorCell(provider);
  return {
    // 20px = 输入框发送键（28px 圆）的内接正方形（28 / √2 ≈ 19.8）：头像在圆里刚好顶住
    // （2026-10-24 用户：「composer 里的 chip 的模型 avatar 就是刚好在圆形里顶住的方形」）
    avatar: <ModelAvatar modelId={selected.modelId} provider={cell} size={20} />,
    name,
    // 名字就是 id 时不再写第二遍
    detail: name === selected.modelId ? cell.label : `${cell.label} · ${selected.modelId}`,
  };
}

/** 两个左栏选中态是不是同一格（provider 档要比 id）。内部用：只给下面关着时的对齐去重 */
function sameScope(a: ModelScope, b: ModelScope): boolean {
  if (a.kind === "provider" || b.kind === "provider") {
    return a.kind === "provider" && b.kind === "provider" && a.id === b.id;
  }
  return a.kind === b.kind;
}

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
  fontSize: "var(--font-size-xs)",
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
  const [scope, setScope] = useState<ModelScope>(() => openingModelScope(props.providers, props.selected));
  const [open, setOpen] = useState(false);
  /*
   * 每次打开都落在当前型号所属的那家（openingModelScope）。**关着的时候就对齐**，不等打开那一刻：
   * Menu 在点开的同一个事件里按**当时的清单**把光标放到打勾行（cursorAtChecked）、再
   * scrollIntoView——若等打开后才改左栏，那一刻打勾行还不在清单里，光标落到第一行。
   * 关着时跟着 selected 变：换会话 / 刚选了别家的型号，下次打开就是新那家。
   * 打开期间不动：用户手点的左栏 / 搜索复位照旧；关掉即回到当前型号那家，不沿用上次手选。
   */
  const selectedProviderId = props.selected?.providerId ?? null;
  useEffect(() => {
    if (open) return;
    const next = openingModelScope(props.providers, selectedProviderId === null ? null : { providerId: selectedProviderId });
    // 调用方多半每次渲染都给一份新的 providers 数组：等值就留旧对象，不白白多渲染一次
    setScope((prev) => (sameScope(prev, next) ? prev : next));
  }, [open, selectedProviderId, props.providers]);
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
      onOpenChange={setOpen}
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
 * （会话行在用）。选中那一格说的是「现在只看星标」，那是视图状态，走左栏当前格的
 * 底 + 光圈（`.model-rail-cell[aria-selected]`，styles.css），不借填充去说。
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
      {/*
        左栏只有图标格（2026-10-19 用户：兼容网关也换协议的标，「比较统一」），格宽恒定、
        不随选中字重变——原先给文字格（自建网关实例名）准备的隐藏宽度尺随之删掉。
      */}
      <RailCell
        label={options.t.modelMenu.starred}
        selected={options.scope.kind === "starred"}
        onClick={() => options.onScope({ kind: "starred" })}
      >
        <Icon name="star" size={13} strokeWidth={1.8} />
      </RailCell>
      <RailCell
        label={options.t.menu.all}
        selected={options.scope.kind === "all"}
        onClick={() => options.onScope(MODEL_SCOPE_ALL)}
      >
        <Icon name="menu" size={13} strokeWidth={1.8} />
      </RailCell>
      {options.providers.map((provider) => {
        const cell = railVendorCell(provider);
        return (
          <RailCell
            key={provider.id}
            // 同协议多个网关共用一枚标：实例名靠悬停提示与读屏 aria-label 区分
            label={provider.displayName}
            selected={options.scope.kind === "provider" && options.scope.id === provider.id}
            onClick={() => options.onScope({ kind: "provider", id: provider.id })}
          >
            <VendorLogo kindId={cell.kindId} label={cell.label} size={14} />
          </RailCell>
        );
      })}
    </>
  );
}

/** 左栏格子的悬停提示延迟：与 IconButton 同 200ms（同为纯图标控件） */
const RAIL_TIP_DELAY_MS = 200;

/**
 * 左栏一格：纯图标，所以名字全靠悬停提示与 aria-label。
 *
 * 提示用自绘的 useHoverTooltip，不挂原生 `title`：macOS 原生 tooltip 约两秒才出
 * （同 IconButton 弃用 title 的理由），而左栏只有标、同协议的网关还共用一枚标——
 * 「这格是哪家」只能靠悬停回答（2026-10-25 用户：「也看不清是什么 provider」）。
 * 选中态的光圈在 CSS（`.model-rail-cell[aria-selected="true"]`），状态样式不写 inline。
 */
function RailCell(props: {
  label: string;
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactNode {
  const tooltip = useHoverTooltip<HTMLButtonElement>(RAIL_TIP_DELAY_MS, true);
  return (
    <>
      <button
        ref={tooltip.anchorRef}
        type="button"
        className="option-row model-rail-cell"
        style={RAIL_CELL}
        // 图标格的 VendorLogo / Icon 自身 aria-hidden，按钮不能只靠图标——补全名给读屏
        aria-label={props.label}
        aria-selected={props.selected}
        onClick={props.onClick}
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
        onFocus={tooltip.handlers.onFocus}
        onBlur={tooltip.handlers.onBlur}
      >
        {props.children}
      </button>
      {tooltip.open &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            role="tooltip"
            className="model-rail-tip"
            data-placed={tooltip.placement !== null}
            style={{ top: tooltip.placement?.top ?? 0, left: tooltip.placement?.left ?? 0 }}
          >
            {props.label}
          </div>,
          document.body,
        )}
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
  /*
   * 「全部」与「星标」里同一个型号可能来自不同服务商（OpenCode 上的 kimi-k3 与 Kimi 套餐的 k3），
   * 副行要缀上服务商名；左栏选了某一家时它就在左栏亮着，副行只留 id（原型 4，2026-10-24）。
   */
  const showProvider = options.scope.kind !== "provider";
  const rowFor = (provider: ProviderDto, declared: ModelDecl): MenuItem => {
    const prefer = modelPreferenceOf(provider);
    const defaults = resolveModelDefaults(options.catalog, declared.id, prefer);
    const context = modelContextText(declared, defaults);
    const isStarred = starredKeys.has(starKey(provider.id, declared.id));
    const name = modelDisplayName(options.catalog, declared.id, prefer, declared.name);
    return {
      id: starKey(provider.id, declared.id),
      label: name,
      /*
       * 有显示名：主文字是名字，型号 id 降到副行（等宽：它是机器事实）。
       * 没有（名字就是 id）：副行不再把 id 写第二遍，照旧写服务商名——行还是两行，
       * 卡片「定高六行」的尺子不变。
       */
      ...(name === declared.id
        ? { subLabel: provider.displayName }
        : {
            subLabel: declared.id,
            subLabelMono: true,
            ...(showProvider ? { subLabelTrail: provider.displayName } : {}),
          }),
      // 主行换成显示名之后，按 id 与服务商名照样要搜得到
      searchText: `${declared.id} ${provider.displayName}`,
      // 32px：两行行（48px，上下各留 4px）里约等于两行文字的高度（2026-10-24 用户：原来的 20px 太小）
      avatar: <ModelAvatar modelId={declared.id} provider={railVendorCell(provider)} size={32} />,
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
