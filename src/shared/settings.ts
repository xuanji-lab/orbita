/**
 * 应用设置契约 —— IPC 四层的第 1 层。
 *
 * 范围刻意只有主题一项。设置面从极少的 tab 起步、但 UI 第一天就落（guideline §六）；
 * 字段等有真实消费者再加，不提前占位。
 */
import { PERMISSION_MODES, type PermissionMode } from "./permission.ts";
import { isThinkingLevel, type ThinkingLevel } from "./thinking.ts";

/**
 * 主题偏好。**四态**——"system" 是真正的默认，不是「light 的别名」：
 * 用户没表态时应用要跟着系统深浅走。system 的深色落点是 **"black"**（Ink，
 * 2026-09-03 用户指定）；"dark"（Warm）与 "black" 从此都是手动档。
 */
export const THEME_PREFERENCES = ["system", "light", "dark", "black"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

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
 * 缺席 = 应用默认（第一档 plan、第一个可用模型）。
 */
export interface LastUsedIntent {
  mode?: PermissionMode;
  providerId?: string;
  modelId?: string;
  /** 上次用的思考档：新任务的起点（同 mode 的语义，可缺席 = 退 medium） */
  thinkingLevel?: ThinkingLevel;
}

/**
 * 给会话自动命名用的模型。标题是一次独立的小调用，用不着主力模型——
 * 指一个小而快的，标题来得更快也更便宜。
 * 两个 id 必须成对：光有 modelId 无法定位到哪家的密钥。
 */
export interface TitleModel {
  providerId: string;
  modelId: string;
}

export interface AppSettings {
  theme: ThemePreference;
  /**
   * 右侧分屏面板的宽度（4-0 拖宽）。缺席 = 默认 320；合法区间 280–560，
   * 越界或非数丢掉——这个文件用户手改得到，一个坏值不该把面板拖成一条线。
   * 拖动中不落盘，松手才写（避免写风暴）。
   */
  rightPanelWidth?: number;
  drawer: DrawerSettings;
  /**
   * 自动压缩偏好（A-1）。缺席 = COMPACTION_DEFAULT（主进程装配开轮命令时兜底）。
   * 改动**下一轮对话即生效**：pi 的压缩判定每次现读设置，runtime 每轮重新覆盖。
   */
  compaction?: CompactionSetting;
  /**
   * 代用户提交时在 commit / PR 里留下 Orbita 标识。**缺席 = 开启**：默认署名，
   * 不想要的人关一次就够；默认关则绝大多数人不会知道有这件事。
   * 只认布尔——这个文件手改得到，`"yes"` 该被丢掉而不是当成真。
   * 改动下一轮对话即生效（主进程每轮现读，同 compaction）。
   */
  gitAttribution?: boolean;
  /**
   * 会话自动命名专用的模型。**缺席 = 用会话当前的模型**（原有行为）。
   * 主进程在发标题命令前把它解成带密钥的 provider 载荷；指的 provider 被删了
   * 不拦标题，退回会话模型。
   */
  titleModel?: TitleModel;
  /** 上次使用的权限档与模型；缺席 = 应用默认。 */
  lastUsed?: LastUsedIntent;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  drawer: { width: 320, docked: [] },
};

/**
 * 写入补丁：顶层按键覆盖，`drawer` 内部再按键合并（见 SettingsStore.write）。
 * 渲染层各处只发自己改的键——整块回写会带上闭包里的旧值，先后覆盖有竞态。
 */
export type SettingsPatch = Partial<Omit<AppSettings, "drawer" | "lastUsed" | "titleModel">> & {
  drawer?: Partial<DrawerSettings>;
  lastUsed?: Partial<LastUsedIntent>;
  /**
   * `null` = 清除，退回「Same as session」。需要显式的 null 是因为 `undefined`
   * 在补丁语义里是「这个键没改」；两者不分的话用户就选不回默认。
   * store 的 `{...current, ...patch}` 经 parseSettings 自然丢掉 null。
   */
  titleModel?: TitleModel | null;
};

/** 抽屉宽度的合法区间（与渲染层拖拽钳制同一对数字）。 */
export const DRAWER_WIDTH = { min: 280, max: 560, default: 320 } as const;

/** 右侧面板宽度的合法区间与默认值（与拖拽热区的夹取同源）。 */
export const RIGHT_PANEL_WIDTH_MIN = 280;
export const RIGHT_PANEL_WIDTH_MAX = 560;
export const RIGHT_PANEL_WIDTH_DEFAULT = 320;

function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value);
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
    drawer?: unknown;
    rightPanelWidth?: unknown;
    compaction?: unknown;
    gitAttribution?: unknown;
    titleModel?: unknown;
    lastUsed?: unknown;
  };
  const theme = isThemePreference(record.theme) ? record.theme : DEFAULT_SETTINGS.theme;
  const width = record.rightPanelWidth;
  const compaction = parseCompaction(record.compaction);
  const titleModel = parseTitleModel(record.titleModel);
  const lastUsed = parseLastUsed(record.lastUsed);
  return {
    theme,
    ...(typeof width === "number" &&
    Number.isFinite(width) &&
    width >= RIGHT_PANEL_WIDTH_MIN &&
    width <= RIGHT_PANEL_WIDTH_MAX
      ? { rightPanelWidth: Math.round(width) }
      : {}),
    drawer: parseDrawer(record.drawer),
    ...(compaction === undefined ? {} : { compaction }),
    // 非布尔一律当作「没动过」丢掉：缺席与 true 是同一个行为，落一个坏值进来
    // 只会让设置面显示的状态和实际行为对不上
    ...(typeof record.gitAttribution === "boolean"
      ? { gitAttribution: record.gitAttribution }
      : {}),
    ...(titleModel === undefined ? {} : { titleModel }),
    ...(lastUsed === undefined ? {} : { lastUsed }),
  };
}

/**
 * 标题模型校验：**两个都是非空字符串才认**。存半截的没意义——光有 modelId
 * 定位不到密钥，光有 providerId 不知道叫哪个模型，两种残形都只会让标题静默失败。
 * 缺席或坏值 = 没指定（返回 undefined，消费侧退会话模型）。
 */
function parseTitleModel(raw: unknown): TitleModel | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { providerId?: unknown; modelId?: unknown };
  if (typeof record.providerId !== "string" || record.providerId === "") return undefined;
  if (typeof record.modelId !== "string" || record.modelId === "") return undefined;
  return { providerId: record.providerId, modelId: record.modelId };
}

/**
 * lastUsed 逐字段校验：mode 必须在三档里，id 必须是非空字符串。
 * 整段缺席或三个键全无效 = 用户从没动过它（返回 undefined，不落盘）。
 */
function parseLastUsed(raw: unknown): LastUsedIntent | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as { mode?: unknown; providerId?: unknown; modelId?: unknown; thinkingLevel?: unknown };
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
  if (isThinkingLevel(record.thinkingLevel)) {
    out.thinkingLevel = record.thinkingLevel;
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
