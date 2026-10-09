/**
 * 应用设置契约 —— IPC 四层的第 1 层。
 *
 * 范围刻意只有主题一项。设置面从极少的 tab 起步、但 UI 第一天就落（guideline §六）；
 * 字段等有真实消费者再加，不提前占位。
 */
import { PERMISSION_MODES, type PermissionMode } from "./permission.ts";
import { isThinkingLevel, type ThinkingLevel } from "./thinking.ts";

/**
 * 主题偏好。"system" 是真正的默认，不是「light 的别名」：
 * 用户没表态时应用要跟着系统深浅走。system 的深色落点是 **"black"**（玄 Onyx，
 * 2026-09-03 用户指定、2026-09-30 换血后沿用）；两个暗档都是手动档。
 *
 * 暗色两档（2026-09-30 换血，色值取自 DeepSeek Harness 与 ZCode 的安装包实测，
 * 层次与理由见 tokens/colors.css 头注释）：**"graphite"**（黛 Slate，蓝灰、收敛）与
 * **"black"**（玄 Onyx，纯灰、外壳亮堂）。**档位 id 沿用旧名不动**——它们是 settings/IPC
 * 契约，换的只是显示名（`themes` 在 messages-*.ts）。第三档 "dark"（Warm 微暖）
 * 2026-09-27 退役，存量设置迁移到 graphite（`parseTheme`）。
 *
 * "copybook"（小学作业）与 "typescript"（打字稿）是璇玑载体谱「稿纸」一档的中文与英文
 * 两版（wafo 2026-09-25 要求载入）：绿格作业本 + 红笔，与打字稿 + 红色页边线。**只有明**，
 * system 不落这两档，都是手动档。copybook 载入当天由 "manuscript"（稿纸）改名：那个年代
 * 小学生写字用的是绿格作业本，不是稿纸。旧 id 的兼容见 `parseTheme`。
 */
export const THEME_PREFERENCES = ["system", "light", "graphite", "black", "copybook", "typescript"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** 界面语言。缺席 = "en"（语言设置落地之前，双语主题一直是英文界面） */
export const LANGUAGES = ["en", "zh"] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * 主题自带的语言。**稿纸一档是单语的**：小学作业的绿格按汉字画、打字稿的横线按英文打字机
 * 画，换一门文字格子就对不上（wafo 2026-09-25 当初不加语言开关的理由，正是这种组合）；
 * 其余各档（system 与它落到的 light / black，以及 graphite）中英都成立，跟 `language` 走。
 * null = 这个主题不定语言。
 */
export function themeLanguage(theme: ThemePreference): Language | null {
  if (theme === "copybook") return "zh";
  if (theme === "typescript") return "en";
  return null;
}

/**
 * 实际生效的语言：单语主题说了算，双语主题听设置。**渲染层（文案表、`<html lang>`）
 * 与主进程（commit / PR 署名）都走这一条**——两边各判一次的话，界面是中文、署名是英文。
 */
export function effectiveLanguage(theme: ThemePreference, language: Language | undefined): Language {
  return themeLanguage(theme) ?? language ?? "en";
}

/**
 * 右抽屉的记忆。**开关不记**：每次启动默认收起（2026-09-12 wafo 裁决，
 * 设计系统 closed by default 按字面执行）；只有宽度和停靠的记忆值得跨启动。
 * - `width`：抽屉宽度，px。钳制与重置在渲染层（drawer-state.ts），这里只存干净值。
 * - `docked`：抽屉标签条里开着的 task id，按标签顺序。启动时逐条恢复，
 *   已删除的会话静默丢弃——不弹错、不占位。**没发过首条消息的新任务占位不落盘**
   （它还不是 task，没有 id 可记）。
 */
export interface DrawerSettings {
  width: number;
  docked: string[];
}

/**
 * 自动压缩偏好（A-1）。**剩余百分制**：pi 在「上下文用量 > 窗口 − reserveTokens」
 * 时触发折叠，reserveTokens = contextWindow × reservePercent / 100——不同模型的
 * 窗口差 10 倍，百分比换个模型不失义。pi 出厂的绝对阈值（window − 16384）对
 * ≤16k 窗口的模型是非正数（第一轮聊完就压、保留量又大于整个窗口），百分制顺手
 * 修掉这个退化。换算与钳制在 src/agent（runtime 开轮时按本轮模型的窗口算）。
 *
 * - `enabled: false` = 关闭自动压缩，只认手动 `/compact`（手动压缩不走阈值，不受影响）。
 * - 保留量（pi 的 keepRecentTokens）**不暴露**：它与 reservePercent 耦合（两个旋钮
 *   互相牵制），内部按窗口钳制——min(2 万, 窗口的 25%)。
 */
export interface CompactionSetting {
  /** 触发阈值 = 剩余窗口的百分比；合法区间 [5, 50] 的数，坏值回 20 */
  reservePercent: number;
  /** 自动压缩开关；关闭后只认手动 `/compact` */
  enabled: boolean;
}

export const COMPACTION_DEFAULT: CompactionSetting = { reservePercent: 20, enabled: true };

/** reservePercent 的合法区间（解析钳制与设置面选项共用同一对数字）。 */
export const COMPACTION_PERCENT = { min: 5, max: 50 } as const;

/**
 * 上次使用的权限档与模型（A-0 复验 bug A：重启后 composer 忘了上次的选择）。
 * 会话各自的档/模型记在各条 meta 与内存 Map（按会话记账，cd0ee98）；这里是
 * **启动恢复点**：新会话槽的初始值。切换时逐键写回（改档只写 mode）。
 * 缺席 = 应用默认（DEFAULT_PERMISSION_MODE、第一个可用模型）。
 */
export interface LastUsedIntent {
  mode?: PermissionMode;
  providerId?: string;
  modelId?: string;
  // 思考档**不在这里**（wafo 2026-09-23）：彻底重启才落回模型的默认档，没重启就
  // 记住用户上一次手选——那份记忆只活在 renderer 内存里，跨重启持久化正是要去掉的行为。
  // 默认档见 model-defaults 的 `defaultThinkingLevel`。
}

/**
 * 给家务活用的模型（起名、收尾扫描、迁移的随手一句检查……）。这些是一次次的
 * 小调用，用不着主力模型——指一个小而快的，来得更快也更便宜，后面还会让它
 * 承担更多家务。两个 id 必须成对：光有 modelId 无法定位到哪家的密钥。
 */
export interface ModelPair {
  providerId: string;
  modelId: string;
}

export interface AppSettings {
  theme: ThemePreference;
  /**
   * 界面语言偏好。**只在双语主题下生效**（见 `effectiveLanguage`）：选了小学作业 / 打字稿时
   * 这个值留着不动，切回双语主题就恢复。缺席 = "en"。
   */
  language?: Language;
  /**
   * 右侧分屏面板的宽度（4-0 拖宽）。缺席 = 默认 320。**这里只做 ≥200 的硬校验**：
   * 合法上界依赖当前 pane 宽度（见 clampRightPanelWidth），落盘的值换个显示器就可能
   * 越界，所以真正的夹取在渲染层每次渲染时做，存储层只拦「把面板拖成一条线」的坏值。
   * 拖动中不落盘，松手才写（避免写风暴）。
   */
  rightPanelWidth?: number;
  /**
   * 左侧栏的宽度。缺席 = 默认 288（设计系统的出厂尺寸）；**固定像素区间 240–400**，
   * 越界或非数直接丢掉——左栏与「chat 的 1/3–2/3」无关（2026-09-22 wafo 澄清：
   * 那条比例规则说的是 chat 被一分为二的左右，即 chat 主区与右栏）。
   * 拖动中不落盘，松手才写。
   */
  sidebarWidth?: number;
  drawer: DrawerSettings;
  /**
   * 自动压缩偏好（A-1）。缺席 = COMPACTION_DEFAULT（主进程装配开轮命令时兜底）。
   * 改动**下一轮对话即生效**：pi 的压缩判定每次现读设置，runtime 每轮重新覆盖。
   */
  compaction?: CompactionSetting;
  /**
   * 粘贴文本 chip 是否折叠成一行。**缺席 = 折叠**（现状）：贴进来的长文收成
   * 「粘贴的文本 · N 行」一行，点开展开。关掉则输入框与转录里的粘贴文本
   * 都直接全文铺开，不再折叠。只认布尔，同 gitAttribution 的纪律。
   */
  collapsePastedText?: boolean;
  /**
   * 代用户提交时在 commit / PR 里留下 Orbita 标识。**缺席 = 开启**：默认署名，
   * 不想要的人关一次就够；默认关则绝大多数人不会知道有这件事。
   * 只认布尔——这个文件手改得到，`"yes"` 该被丢掉而不是当成真。
   * 改动下一轮对话即生效（主进程每轮现读，同 compaction）。
   */
  gitAttribution?: boolean;
  /**
   * 家务活模型：给任务起名、收尾扫描、迁移的「跳过随手一句」检查这类小活的专用模型。
   * **缺席 = 各自退回会话当时的模型**（起名 / 扫描）或置灰不可用（随手一句检查，
   * 状态行提醒去选）。主进程在发命令前把它解成带密钥的 provider 载荷；指的
   * provider 被删了不拦那件家务，退回会话模型。
   *
   * 由旧键 `titleModel`（只管起名的时代）平滑迁移：读取时 `choreModel` 缺席就
   * 读旧键，任何一次设置写入都会把旧键从盘上带走。
   */
  choreModel?: ModelPair;
  /**
   * 子会话（delegate）的默认模型。**缺席 = 同父**。优先级：delegate 参数 >
   * 这里 > 同父。形状同 choreModel（两 id 成对：光有 modelId 定位不到哪家的密钥）。
   */
  subSessionModel?: ModelPair;
  /**
   * 子会话的思考档。**绑定 subSessionModel**（wafo 2026-09-23）：档位因模型而异，
   * 脱离模型单独存一档，派到不支持它的模型上就是一个假选项。所以：
   * - 没指定 subSessionModel（同父）时它没有意义，解析时丢掉——思考档跟父走；
   * - 指定了模型、这里缺席 = 那个模型的默认档（`defaultThinkingLevel`）。
   * delegate 参数显式给的档仍然最优先。
   */
  subSessionThinking?: ThinkingLevel;
  /**
   * 星标的模型（收藏）。**跟着用户走、不分会话**，所以落在设置里而不是会话元数据。
   *
   * 与会话的 `starred` 是两件东西：那个只是用户标记，不影响排序、也不筛选任何东西；
   * 这一个**会当过滤口径用**（模型卡片左栏第一格：只看星标）。
   * 存对子不存 modelId：光有 modelId 定位不到哪家的密钥（同 choreModel 的理由）。
   */
  starredModels?: ModelPair[];
  /** 上次使用的权限档与模型；缺席 = 应用默认。 */
  lastUsed?: LastUsedIntent;
  /**
   * 通道列的宽度（子会话 2026-09-23 用户裁决：通道列可拖宽）。缺席 = 默认 300。
   * **这里只做 ≥ 地板的硬校验**：合法上界依赖当前 chat 区宽度（见
   * `clampChannelColumnWidth`），落盘的值换个窗口大小就可能越界，真正的夹取在
   * 渲染层每次渲染时做，同 `rightPanelWidth` 的纪律。拖动中不落盘，松手才写。
   */
  channelColumnWidth?: number;
  /**
   * 受管浏览器「你的」tab 的下载目录（绝对路径）。**缺席 = 系统下载文件夹**（主进程解析）。
   * 用户指定，agent 每轮被告知（TurnDirectories.browserDownloads）。
   */
  browserDownloadDir?: string;
  /**
   * 设置 › 模型服务的厂商卡片尺寸。缺席 = large。加的服务商多了卡片墙会很长，
   * small 只留 logo、名字与「已添加」角标；选了就记住，下次进来还是这一档。
   */
  providerCardSize?: ProviderCardSize;
}

export type ProviderCardSize = "large" | "small";

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  drawer: { width: 320, docked: [] },
};

/**
 * 写入补丁：顶层按键覆盖，`drawer` 内部再按键合并（见 SettingsStore.write）。
 * 渲染层各处只发自己改的键——整块回写会带上闭包里的旧值，先后覆盖有竞态。
 */
export type SettingsPatch = Partial<
  Omit<AppSettings, "drawer" | "lastUsed" | "choreModel" | "subSessionModel" | "subSessionThinking">
> & {
  drawer?: Partial<DrawerSettings>;
  lastUsed?: Partial<LastUsedIntent>;
  /**
   * `null` = 清除，退回「Same as session」。需要显式的 null 是因为 `undefined`
   * 在补丁语义里是「这个键没改」；两者不分的话用户就选不回默认。
   * store 的 `{...current, ...patch}` 经 parseSettings 自然丢掉 null。
   */
  choreModel?: ModelPair | null;
  /** 同 choreModel 的 null 语义：清除后退回「Same as parent」（子会话跟父会话的模型走） */
  subSessionModel?: ModelPair | null;
  /** 清除后退回所选子会话模型的默认档；subSessionModel 被清除时它随之失效（见 AppSettings） */
  subSessionThinking?: ThinkingLevel | null;
};

/** 抽屉宽度的合法区间（与渲染层拖拽钳制同一对数字）。 */
export const DRAWER_WIDTH = { min: 280, max: 560, default: 320 } as const;

/** 右侧面板宽度的默认值（双击热区复位的目标，会再按当前 pane 夹一次）。 */
export const RIGHT_PANEL_WIDTH_DEFAULT = 320;

/**
 * 左侧栏宽度的合法区间与默认值（与拖拽热区的夹取同源）。
 * 下界 240：再窄会话标题就只剩几个字；上界 400：再宽就在抢对话面的地方。
 * **固定像素**：左栏不参与「chat 的 1/3–2/3」那条比例规则。
 */
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 400;
export const SIDEBAR_WIDTH_DEFAULT = 288;

/**
 * 右栏宽度的硬地板（px）。小窗口保护：窗口再窄，右栏也不能收成一条看不出内容的缝。
 * 它会压过下面按比例算出的上限——挤到 chat 也比右栏消失好。
 */
const RIGHT_PANEL_WIDTH_FLOOR = 200;

/**
 * 把右栏宽度夹进合法区间。**区间是相对 pane 的比例，不是固定像素**——
 * 2026-09-22 wafo 裁决并于同日澄清：那条「1/3 与 2/3」说的是 **chat 主区与右栏**
 * 这一对（「我的 1/3 和 2/3 apply to chat 和右栏，和左栏没有关系。我说的左栏指的是
 * chat 被一分为二的左右」），左侧栏不在其内，仍走固定的 240–400。
 *
 * 设 P = `paneTotal` = chat 主区 + 右栏 的总宽（拖动中恒定：chat 主区是 flex:1，
 * 右栏拿多少它就让多少）。区间直接就是 **[P/3, 2P/3]**——这一对本身各占 pane 的
 * 三分之一到三分之二，不需要再换算。
 *
 * 地板与上限撞车（P 小到 2P/3 < 200）时**地板胜出**，见 RIGHT_PANEL_WIDTH_FLOOR。
 * `paneTotal` 量不到（元素未挂载，为 0 或非数）时只保地板——不拿一个假的 P 去夹。
 */
export function clampRightPanelWidth(width: number, paneTotal: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : RIGHT_PANEL_WIDTH_FLOOR;
  if (!Number.isFinite(paneTotal) || paneTotal <= 0) {
    return Math.max(RIGHT_PANEL_WIDTH_FLOOR, wanted);
  }
  const floor = Math.max(RIGHT_PANEL_WIDTH_FLOOR, Math.round(paneTotal / 3));
  const ceiling = Math.round((paneTotal * 2) / 3);
  return Math.max(floor, Math.min(ceiling, wanted));
}

/** 通道列宽度的默认值（双击热区复位的目标，会再按当前 chat 区宽度夹一次）。 */
export const CHANNEL_COLUMN_WIDTH_DEFAULT = 300;

/**
 * 通道列宽度的硬地板（px）。再窄消息正文每行只剩几个字——比右栏的地板（200）更紧，
 * 因为通道卡内部还要留出父左子右两栏气泡的横向余量，180 是两栏对话仍读得下去的下限。
 */
const CHANNEL_COLUMN_WIDTH_FLOOR = 180;

/**
 * 把通道列宽度夹进合法区间（用户 2026-09-23 裁决：通道列可拖宽，最小 = chat 区的
 * 1/6，最大 = chat 区的 1/3——「现在固定 300px，子会话 session 里只剩工具调用，
 * 反倒像陪衬」）。
 *
 * 设 C = `chatTotal` = **主槽（chat 主区）+ 通道列**的总宽（拖动中恒定：主槽是
 * flex:1，通道列拿多少它就让多少）——**不包含右栏**：右栏是另一块独立空间，
 * 用户说的「chatview」指的是主槽与通道列这一对，同 `clampRightPanelWidth` 只管
 * 「chat 主区与右栏」那一对、不含左侧栏的先例，这里对称地不含右栏。
 * 区间就是 **[C/6, C/3]**。
 *
 * 地板与上限撞车（C 小到 C/3 < 180）时**地板胜出**，见 `CHANNEL_COLUMN_WIDTH_FLOOR`。
 * `chatTotal` 量不到（元素未挂载，为 0 或非数）时只保地板——不拿一个假的 C 去夹。
 */
export function clampChannelColumnWidth(width: number, chatTotal: number): number {
  const wanted = Number.isFinite(width) ? Math.round(width) : CHANNEL_COLUMN_WIDTH_FLOOR;
  if (!Number.isFinite(chatTotal) || chatTotal <= 0) {
    return Math.max(CHANNEL_COLUMN_WIDTH_FLOOR, wanted);
  }
  const floor = Math.max(CHANNEL_COLUMN_WIDTH_FLOOR, Math.round(chatTotal / 6));
  const ceiling = Math.round(chatTotal / 3);
  return Math.max(floor, Math.min(ceiling, wanted));
}

function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value);
}

/**
 * "manuscript" 是 copybook 改名前的 id（同一档）：settings.json 里存着旧值的落回这一档，
 * 不退回 system。下次写设置时磁盘上就是新 id 了。"dark"（Warm）2026-09-27 退役，
 * 存量值落到 graphite——同为「不近黑的暗档」，继任关系最直。
 */
function parseTheme(value: unknown): ThemePreference {
  if (isThemePreference(value)) return value;
  if (value === "manuscript") return "copybook";
  if (value === "dark") return "graphite";
  return DEFAULT_SETTINGS.theme;
}

/** 只在区间内才认；钳制交给渲染层，这里不「猜」用户想要的宽度 */
function parseWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DRAWER_WIDTH.default;
  if (value < DRAWER_WIDTH.min || value > DRAWER_WIDTH.max) return DRAWER_WIDTH.default;
  return Math.round(value);
}

/**
 * 从磁盘上的任意 JSON 解出设置。
 *
 * **只认识的字段留下，别的一律丢掉**，坏值退回默认。理由是这个文件在用户目录里、
 * 手改得到：一个打错的主题名不该让应用起不来，也不该把 `theme` 变成一段任意字符串
 * 流进渲染层的 `data-theme`。
 */
export function parseSettings(raw: unknown): AppSettings {
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  const record = raw as {
    theme?: unknown;
    language?: unknown;
    drawer?: unknown;
    rightPanelWidth?: unknown;
    sidebarWidth?: unknown;
    compaction?: unknown;
    collapsePastedText?: unknown;
    gitAttribution?: unknown;
    choreModel?: unknown;
    /** 旧键（只管起名的时代）：choreModel 缺席时读它，选过的用户不用重选 */
    titleModel?: unknown;
    subSessionModel?: unknown;
    subSessionThinking?: unknown;
    lastUsed?: unknown;
    channelColumnWidth?: unknown;
    browserDownloadDir?: unknown;
    starredModels?: unknown;
    providerCardSize?: unknown;
  };
  const theme = parseTheme(record.theme);
  const width = record.rightPanelWidth;
  const sidebar = record.sidebarWidth;
  const channelColumnWidth = record.channelColumnWidth;
  const compaction = parseCompaction(record.compaction);
  // 旧键 titleModel 只在读这一层兼容：解析产物永远是 choreModel，任何一次写入
  // （parseSettings 白名单重建整个对象）都会把旧键从盘上带走
  const choreModel = parseModelPair(record.choreModel) ?? parseModelPair(record.titleModel);
  const subSessionModel = parseModelPair(record.subSessionModel);
  // 绑定 subSessionModel：模型是「同父」时单独一档思考没有意义，丢掉（见 AppSettings）
  const subSessionThinking =
    subSessionModel !== undefined && isThinkingLevel(record.subSessionThinking)
      ? record.subSessionThinking
      : undefined;
  const lastUsed = parseLastUsed(record.lastUsed);
  const starredModels = parseStarredModels(record.starredModels);
  return {
    theme,
    // 不认识的语言当作「没选过」丢掉，同 gitAttribution 的纪律
    ...((LANGUAGES as readonly unknown[]).includes(record.language) ? { language: record.language as Language } : {}),
    // 右栏只做 ≥ 地板的硬校验：上界随 pane 宽度变，存储层判不了，渲染层每次夹
    ...(typeof width === "number" && Number.isFinite(width) && width >= RIGHT_PANEL_WIDTH_FLOOR
      ? { rightPanelWidth: Math.round(width) }
      : {}),
    // 左栏的区间是固定像素，存储层判得了：越界直接丢，不「猜」用户想要的宽度
    ...(typeof sidebar === "number" &&
    Number.isFinite(sidebar) &&
    sidebar >= SIDEBAR_WIDTH_MIN &&
    sidebar <= SIDEBAR_WIDTH_MAX
      ? { sidebarWidth: Math.round(sidebar) }
      : {}),
    // 通道列同右栏的纪律：只做 ≥ 地板的硬校验，上界随 chat 区宽度变，渲染层每次夹
    ...(typeof channelColumnWidth === "number" &&
    Number.isFinite(channelColumnWidth) &&
    channelColumnWidth >= CHANNEL_COLUMN_WIDTH_FLOOR
      ? { channelColumnWidth: Math.round(channelColumnWidth) }
      : {}),
    drawer: parseDrawer(record.drawer),
    ...(starredModels === undefined ? {} : { starredModels }),
    ...(compaction === undefined ? {} : { compaction }),
    // 非布尔一律当作「没动过」丢掉：缺席与 true 是同一个行为，落一个坏值进来
    // 只会让设置面显示的状态和实际行为对不上
    ...(typeof record.gitAttribution === "boolean"
      ? { gitAttribution: record.gitAttribution }
      : {}),
    // 同 gitAttribution 的纪律：非布尔丢掉，缺席 = 折叠（现状）
    ...(typeof record.collapsePastedText === "boolean"
      ? { collapsePastedText: record.collapsePastedText }
      : {}),
    ...(choreModel === undefined ? {} : { choreModel }),
    ...(subSessionModel === undefined ? {} : { subSessionModel }),
    ...(subSessionThinking === undefined ? {} : { subSessionThinking }),
    ...(lastUsed === undefined ? {} : { lastUsed }),
    // 不认识的尺寸当没选过（缺席 = large）
    ...(record.providerCardSize === "large" || record.providerCardSize === "small"
      ? { providerCardSize: record.providerCardSize }
      : {}),
    // 只认绝对路径（POSIX 以 / 开头，Windows 盘符或 UNC）：相对路径会随 cwd 漂，当作没设
    ...(typeof record.browserDownloadDir === "string" && isAbsolutePath(record.browserDownloadDir)
      ? { browserDownloadDir: record.browserDownloadDir }
      : {}),
  };
}

function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
}

/**
 * 成对模型 id 校验：**两个都是非空字符串才认**。存半截的没意义——光有 modelId
 * 定位不到密钥，光有 providerId 不知道叫哪个模型，两种残形都只会让对应功能
 * 静默失败（choreModel 退会话模型，subSessionModel 退同父）。
 * 缺席或坏值 = 没指定（返回 undefined，消费侧各自兜底）。
 */
function parseModelPair(raw: unknown): ModelPair | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { providerId?: unknown; modelId?: unknown };
  if (typeof record.providerId !== "string" || record.providerId === "") return undefined;
  if (typeof record.modelId !== "string" || record.modelId === "") return undefined;
  return { providerId: record.providerId, modelId: record.modelId };
}

/**
 * 星标模型列表：逐项校验 + **按 (providerId, modelId) 去重**。
 *
 * 去重不是洁癖：星标是个开关，重复项会让「点亮 / 取消」算错（取消一条还剩一条，
 * 星星看起来关不掉）。校验不过的项直接丢，坏值不落库（同其它字段的纪律）。
 * 全部无效或本来就是空数组时返回 undefined——「没有星标」与「这个键不在」
 * 行为完全一样，不为此在盘上留一个空数组。
 */
function parseStarredModels(raw: unknown): ModelPair[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ModelPair[] = [];
  for (const entry of raw) {
    const pair = parseModelPair(entry);
    if (pair === undefined) continue;
    const key = `${pair.providerId}:${pair.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pair);
  }
  return out.length === 0 ? undefined : out;
}

/**
 * lastUsed 逐字段校验：mode 必须在三档里，id 必须是非空字符串。
 * 整段缺席或三个键全无效 = 用户从没动过它（返回 undefined，不落盘）。
 */
function parseLastUsed(raw: unknown): LastUsedIntent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { mode?: unknown; providerId?: unknown; modelId?: unknown };
  const out: LastUsedIntent = {};
  if ((PERMISSION_MODES as readonly unknown[]).includes(record.mode)) {
    out.mode = record.mode as PermissionMode;
  }
  if (typeof record.providerId === "string" && record.providerId !== "") {
    out.providerId = record.providerId;
  }
  if (typeof record.modelId === "string" && record.modelId !== "") {
    out.modelId = record.modelId;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function parseDrawer(raw: unknown): DrawerSettings {
  const fallback = DEFAULT_SETTINGS.drawer;
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as { width?: unknown; docked?: unknown };
  return {
    width: parseWidth(record.width),
    docked: Array.isArray(record.docked)
      ? record.docked.filter((id): id is string => typeof id === "string")
      : fallback.docked,
  };
}

/**
 * 压缩偏好逐字段校验：百分比只在区间内才认，enabled 非布尔回 true——
 * 手改出一个 `reservePercent: 200` 等于「上限的 2 倍才开始留余量」，比坏主题更危险。
 * 整段缺席 = 用户从没动过它（返回 undefined，消费侧兜 COMPACTION_DEFAULT）。
 */
function parseCompaction(raw: unknown): CompactionSetting | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const percent = (raw as { reservePercent?: unknown }).reservePercent;
  const enabled = (raw as { enabled?: unknown }).enabled;
  return {
    reservePercent:
      typeof percent === "number" && Number.isFinite(percent) && percent >= COMPACTION_PERCENT.min && percent <= COMPACTION_PERCENT.max
        ? percent
        : COMPACTION_DEFAULT.reservePercent,
    enabled: enabled === false ? false : true,
  };
}
