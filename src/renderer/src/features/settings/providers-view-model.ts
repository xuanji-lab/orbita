/**
 * ProvidersView 的纯函数层 —— 弹窗解析 / 费率合并 / 复制 id / 行简报。
 * UI 状态留在组件里，这里只放有边界要守的换算；node --test 可直接加载。
 */
import type { CatalogPreference, ModelDefaults } from "@shared/model-defaults";
import type { ModelCostDecl, ModelDecl, ProviderApi, ProviderDto } from "@shared/provider";
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名（type import 剥离后无此问题）
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_GROUPS,
  catalogPreferenceOf,
  knownProviderGroup,
  knownProviderOf,
  type KnownProvider,
  type KnownProviderGroup,
} from "../../../../shared/known-providers.ts";
import { formatTokens } from "../../utils/format-tokens.ts";
import type { Messages } from "../../messages-en.ts";

/** 弹窗数值输入的解析结果：undefined = 留空继承，"invalid" = 不是合法数字 */
export type ParsedInput = number | undefined | "invalid";

/** "128000" / "128k" / "1M" → tokens；空串 = 继承（undefined）。不许负号与其它花样 */
export function parseTokenInput(text: string): ParsedInput {
  const t = text.trim().toLowerCase();
  if (t === "") return undefined;
  const m = /^([0-9.]+)\s*(k|m)?$/.exec(t);
  if (m === null) return "invalid";
  let value = Number(m[1]);
  if (!Number.isFinite(value)) return "invalid";
  if (m[2] === "k") value *= 1_000;
  if (m[2] === "m") value *= 1_000_000;
  return Math.round(value);
}

/** 费率输入：空串 = 继承；负数 / 非数 = invalid */
export function parseRateInput(text: string): ParsedInput {
  const t = text.trim();
  if (t === "") return undefined;
  const value = Number(t);
  return Number.isFinite(value) && value >= 0 ? value : "invalid";
}

/**
 * 弹窗 Apply 的费率合并：只动 input / output 两档，cacheRead / cacheWrite 按
 * 现值 → 目录 → 0 兜住（decl.cost 是整份替换，四档必须齐全）。
 * 两档都留空 = 纯继承，返回 undefined（decl.cost 整个删掉）。
 */
export function mergeModelCost(
  existing: ModelCostDecl | undefined,
  meta: { cost: ModelCostDecl } | undefined,
  patch: { input: number | undefined; output: number | undefined },
): ModelCostDecl | undefined {
  if (patch.input === undefined && patch.output === undefined) return undefined;
  const pick = (a: number | undefined, b: number | undefined) => a ?? b ?? 0;
  return {
    input: pick(patch.input, existing?.input ?? meta?.cost.input),
    output: pick(patch.output, existing?.output ?? meta?.cost.output),
    cacheRead: existing?.cacheRead ?? meta?.cost.cacheRead ?? 0,
    cacheWrite: existing?.cacheWrite ?? meta?.cost.cacheWrite ?? 0,
  };
}

/** 复制厂商的 id：deepseek → deepseek-copy → deepseek-copy2 …（全程过 provider id 正则） */
export function nextCopyId(existing: readonly string[], base: string): string {
  const taken = new Set(existing);
  if (!taken.has(`${base}-copy`)) return `${base}-copy`;
  for (let n = 2; ; n++) {
    const id = `${base}-copy${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * 从目录新建厂商的 id：没占就用条目 id 本身，占了依次试 anthropic-compatible-2 / -3 …
 * 目录条目可以加不止一次（两个 Anthropic 兼容网关、同厂两个账号），id 却是存储主键——
 * 直接拿条目 id 会让第二个落盘时整条换掉第一个。带后缀的 id 认不出目录条目时，
 * 新建时另写 kind 字段；没有 kind 的老数据由 knownProviderOf 剥掉 -N 后缀认回条目。
 */
export function nextFreeId(existing: readonly string[], base: string): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * 拖拽重排后的 id 顺序：被拖行落到目标行的位置（小框框住的那行），其余行顺移补位。
 * from/to 不在表里或相同则原样返回。
 */
export function reorderIds(ids: readonly string[], from: string, to: string): readonly string[] {
  const fi = ids.indexOf(from);
  const ti = ids.indexOf(to);
  if (fi < 0 || ti < 0 || from === to) return ids;
  const next = ids.slice();
  next.splice(fi, 1);
  next.splice(ti, 0, from);
  return next;
}

/** provider 来自哪个目录条目（knownProviderOf：显式 kind > id 推断 > 按协议落兼容）。
 * 设置页与聊天底栏的模型简报共用——两边必须认同同一个目录。 */
export function kindOf(provider: ProviderDto): string {
  return knownProviderOf(provider).id;
}

/**
 * 一个已配置 provider 查型号参数时的偏好（去哪家目录查、协议、目录说不说了算）。
 * 模型菜单、底栏思考档菜单、子会话默认档共用——与主进程装配会话载荷同一个来源
 * （catalogPreferenceOf），菜单里能选的档就是会话里真能发出去的档。
 */
export function modelPreferenceOf(provider: ProviderDto): CatalogPreference {
  return catalogPreferenceOf(knownProviderOf(provider), provider.endpoint.api);
}

/** 按 id 找 provider 再取偏好；找不到（已删的服务商、列表还没加载）就按型号的通用口径答 */
export function modelPreferenceById(providers: readonly ProviderDto[], providerId: string): CatalogPreference {
  const provider = providers.find((item) => item.id === providerId);
  return provider === undefined ? {} : modelPreferenceOf(provider);
}

/**
 * 模型卡片左栏一个厂商格的渲染内容：一律厂商 / 协议图标。
 *
 * 取代原 `railShortNames` 的文字短名（DS / zhipu / STEP…）。2026-10-19 方案丁原本
 * 让自建兼容网关留实例名文字；同日用户改判：「即使我的 openai 兼容的 provider 叫
 * proma，也应该给我加上 openai 的 logo，好让我知道这是 openai 接口的，比较统一」——
 * 兼容网关显示**协议**的标（openai-compatible → OpenAI，anthropic-compatible →
 * Anthropic，VendorLogo 的 LOGOS 里本就有这两条映射）。
 *
 * 同一家 / 同一协议多个实例共用一枚标、不带序号角标，区别靠格子的 title / aria-label
 * （实例名）；模型行的副行也写着实例名。
 */
export interface RailVendorCell {
  kindId: string;
  label: string;
}

export function railVendorCell(provider: ProviderDto): RailVendorCell {
  return { kindId: knownProviderOf(provider).id, label: provider.displayName };
}

/**
 * 「这个厂商能不能用」的唯一判定：凭据已就位 = api_key 且已存密钥，或密钥来自环境变量
 * （env 档没有 hasSecret 可查，scheme 本身就是「已配置」的声明）；none 恒为假。
 * nav 状态点与模型菜单的 usableProviders 是两个真实消费者——此前各写各的判定，
 * env 档厂商在模型菜单里能选、nav 却挂空心环，同一个问题给出两个答案。
 */
export function hasCredentials(auth: ProviderDto["auth"]): boolean {
  if (auth.scheme === "api_key") return auth.hasSecret;
  if (auth.scheme === "oauth") return auth.loggedIn;
  return auth.scheme === "env";
}

/**
 * 模型行的上下文简报。**生效值 = 用户覆盖 > 推断出的基线**（基线内部已经是
 * 白名单 > pi 目录 > 兜底，见 shared/model-defaults），与 agent 注册时的装配同源
 * ——显示与 runtime 讲同一个故事。
 *
 * fallback: true = 这个数字是编出来的（目录、白名单、用户都没说话）。徽标上不写
 * "(fallback)" 字样（用户要求干净），悬停 title 由调用方用这个标志给兜底说明。
 */
export function modelContextText(
  decl: ModelDecl | undefined,
  defaults: ModelDefaults,
): { text: string; fallback: boolean } {
  const ctx = decl?.contextWindow ?? defaults.contextWindow;
  return {
    text: compactTokens(ctx),
    fallback: decl?.contextWindow === undefined && defaults.source === "fallback",
  };
}

/**
 * 这个模型到底能不能吃图：用户的 vision 开关优先，没填就看推断出的模态。
 * 行上的图片徽标与弹窗的 Inherit 档位共用它，两处不会说两个答案。
 */
export function modelAcceptsImage(decl: ModelDecl | undefined, defaults: ModelDefaults): boolean {
  return decl?.vision ?? defaults.input.includes("image");
}

/**
 * 手填模型 id 的合法形状：小写字母 / 数字 / 点 / 短横，1–64 字，不以点或短横开头。
 *
 * **点号必须允许**——内置目录（known-providers）自己就有 `glm-5.3-flash`、`step-3.5-flash`，
 * 不认点号的校验会拒绝自家目录的 id 格式（2026-09-11 验收：加 `glm-5.3` 被拦）。
 * 这是 renderer 侧对用户输入的形状约束；shared 层对 model id 只查非空 + 不重复。
 */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** 校验不过时给用户看的话；过了返回 null。 */
export function modelIdIssue(id: string, t: Messages): string | null {
  return MODEL_ID_PATTERN.test(id) ? null : t.providers.modelIdIssue;
}

/**
 * token 数的短写：128000 → 128k、1000000 → 1M。模型行的上下文徽标与模型弹窗的继承
 * 占位共用——两处写法不一，用户会以为是两个数。徽标要 1M 不要 1.0M（底栏统计要小数，
 * 这里不要），只抹 .0，1.2M 原样。短写能原样填回输入框（parseTokenInput 认 k / M）。
 */
export function compactTokens(n: number): string {
  return formatTokens(n).replace(/\.0(?=[kM]$)/, "");
}

/**
 * 客户端会接在 Base URL 后面的路径——显示成 URL 框尾的灰字，代替原来那句
 * 「The client appends /chat/completions」。每种协议一个口径，与 pi 的请求路径一致
 * （Gemini 原生协议接的是 `/models/<型号>:streamGenerateContent`，型号随会话变，只写到 /models）。
 */
export function urlSuffix(api: ProviderApi): string {
  if (api === "anthropic-messages") return "/v1/messages";
  if (api === "openai-responses") return "/responses";
  // pi 的 Codex 客户端在 baseUrl 后接 /codex/responses（openai-codex-responses.ts 的 resolveCodexUrl）
  if (api === "openai-codex-responses") return "/codex/responses";
  if (api === "google-generative-ai") return "/models";
  return "/chat/completions";
}

/**
 * 卡片底行的预填地址：去掉协议头与尾斜杠，**保留路径**。同一主机上常挂着几条不同的接入
 * （火山方舟的 /api/v3 与 /api/plan、智谱的 /api/paas/v4 与 /api/anthropic），只写主机
 * 的话几张卡底行一模一样，看不出区别。不是合法 URL 的原样返回。
 */
export function cardAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, "");
  } catch {
    return url;
  }
}

/**
 * 连接区有没有没存的改动——决定 Save 条出不出现（只在有改动时出现）。
 *
 * key 输入框空着 = 沿用已存的 key，不算改动；点「Show」会把已存明文拉进输入框当可编辑
 * 草稿（`revealedKey`），原样未动也不算改动，改了一个字才算。
 */
export function connectionDirty(
  draft: { displayName: string; baseUrl: string; apiKey: string; api?: string },
  saved: { displayName: string; baseUrl: string; api?: string },
  revealedKey: string | null,
): boolean {
  if (draft.displayName !== saved.displayName) return true;
  if (draft.baseUrl !== saved.baseUrl) return true;
  // 换了接入协议：Kimi 的 Chat 与 Responses 同在 /v1，地址不变也算改动
  if (draft.api !== undefined && saved.api !== undefined && draft.api !== saved.api) return true;
  return draft.apiKey !== "" && draft.apiKey !== revealedKey;
}

/** 模型服务卡片墙的一张卡：一个目录条目 + 用户名下归它的全部实例（按存储顺序） */
export interface ProviderCard {
  known: KnownProvider;
  instances: ProviderDto[];
}

/**
 * 卡片墙按分区（API / 套餐 / 浏览器登录 / 自定义）排好、过滤好的内容。纯函数：搜索与「仅显示已添加」
 * 都在这里判，组件只管画。
 *
 * - 实例按 `knownProviderOf` 归卡：同一家的第二个实例（deepseek-2）也归 DeepSeek，
 *   角标数字才对得上。
 * - 搜索不分大小写，命中任一即可：卡片的名字与说明（调用方给本地化后的文本）、预填地址、
 *   以及实例的名字与地址——用户常记得自己起的名字（「Proma」）而不记得它挂在哪张卡下。
 * - 空区整个不返回，调用方不画空的分区标题。
 */
export function providerCards(
  providers: readonly ProviderDto[],
  options: {
    query: string;
    onlyAdded: boolean;
    /** 本地化后的卡片文字（名字 + 说明），参与搜索 */
    textOf: (known: KnownProvider) => string;
  },
): { group: KnownProviderGroup; cards: ProviderCard[] }[] {
  const query = options.query.trim().toLowerCase();
  const cards = KNOWN_PROVIDERS.map((known) => ({
    known,
    instances: providers.filter((provider) => knownProviderOf(provider).id === known.id),
  }))
    .filter((card) => !options.onlyAdded || card.instances.length > 0)
    .filter((card) => {
      if (query === "") return true;
      const haystack = [
        options.textOf(card.known),
        card.known.label,
        card.known.baseUrl,
        ...card.instances.flatMap((instance) => [instance.displayName, instance.endpoint.baseUrl]),
      ];
      return haystack.some((text) => text.toLowerCase().includes(query));
    });
  return KNOWN_PROVIDER_GROUPS
    .map((group) => ({ group, cards: cards.filter((card) => knownProviderGroup(card.known) === group) }))
    .filter((entry) => entry.cards.length > 0);
}
