/**
 * 插件面板契约 —— IPC 四层的第 1 层（面板这一半；插件本体的契约在 plugin.ts）。
 *
 * **面板 = 插件自带的一份 HTML 模板 + 一个 JSON 数据文件**，和用户商量好样子后显示在插件页里
 * （插件详情的「面板」页签；做插件的过程中是「正在做」的草稿预览），与对话并排。
 * 清单写法（`.claude-plugin/plugin.json` 顶层的 `orbita.panel`）：
 *
 *   "orbita": { "panel": { "title": "文献追踪", "template": "./panel/index.html",
 *                          "data": "${CLAUDE_PLUGIN_DATA}/panel.json",
 *                          "spec": "./panel/spec.md", "sample": "./panel/sample.json" } }
 *
 * `spec`（可选）：模板说明——显示哪些字段、怎么排、数据从哪来，给人看的短 markdown，由宿主渲染（不进 iframe）。
 * `sample`（可选）：样例数据；`data` 文件不存在 / 为空时用它渲染，界面标「样例」。
 * 两者的路径规则同 `template`（插件根内、拒逃逸）。
 *
 * **模板当不可信代码**（agent 生成，或第三方插件带来）：它在 `sandbox="allow-scripts"`（不给
 * allow-same-origin）的 iframe 里跑，页面由主进程经自定义协议 `orbita-panel://` 给出，CSP 走响应头
 * （见 main/plugin/panel-frame.ts）；它只有两条路和外界说话——收宿主的 `postMessage`，向宿主发
 * `orbita:ready` / `orbita:action`。动作只会被追加进 `<plugin-data>/actions.jsonl`，宿主不据此做
 * 任何别的事；插件自己的脚本下一轮去读它。
 *
 * 这里放：清单字段规格、各种上限、IPC 的请求 / 响应形状、宿主与模板之间的消息，以及两端共用的
 * 纯校验函数（renderer 收 iframe 消息时校验，主进程落盘前再校验一遍——renderer 的入参不是信任边界）。
 */

// ---------- 常量 ----------

/** iframe 的协议名与固定主机段；完整地址 `orbita-panel://doc/<一次性 token>`。 */
export const PANEL_FRAME_SCHEME = "orbita-panel";
export const PANEL_FRAME_HOST = "doc";

/** 动作名最长字符数、载荷序列化后最大字节数（约定写死，模板作者按它写）。 */
export const PANEL_ACTION_MAX_CHARS = 64;
export const PANEL_PAYLOAD_MAX_BYTES = 16 * 1024;

/** 数据文件上限：JSON 没法安全截断，超了拒绝并提示（宿主不把它发给模板）。 */
export const PANEL_DATA_MAX_BYTES = 2 * 1024 * 1024;
/** 模板文件上限（里面可以内联字体 / 图片的 data URI，所以比数据宽松不了太多）。 */
export const PANEL_TEMPLATE_MAX_BYTES = 1024 * 1024;
/** 模板说明（spec）上限：它是给人看的短文，超了就是写错了地方。样例数据的上限同 PANEL_DATA_MAX_BYTES。 */
export const PANEL_SPEC_MAX_BYTES = 64 * 1024;

/** 动作日志：文件名、整份上限、限速（窗口内最多几条）。模板失控地狂发动作时挡住磁盘被写满。 */
export const PANEL_ACTIONS_FILE = "actions.jsonl";
export const PANEL_ACTIONS_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const PANEL_ACTIONS_MAX_PER_WINDOW = 20;
export const PANEL_ACTIONS_WINDOW_MS = 10_000;

/** 模板 5 秒内没发 ready 也要看得到数据：宿主 load 后主动发一次，之后以这个时间复查。 */
export const PANEL_READY_GRACE_MS = 5000;

/**
 * 主题变量下发的名字（模板 `var(--…)` 直接用）。宿主从自己根节点读当前主题的**计算值**发进去，
 * 所以浅 / 暗 / 黛 / 纸面各档自然不同；改了这张表要同步告诉写模板的 agent。
 */
export const PANEL_THEME_VARS = [
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-bg-panel",
  "--color-bg-muted",
  "--color-chat-card-bg",
  "--color-border-subtle",
  "--color-border-default",
  "--color-border-strong",
  "--color-accent",
  "--color-accent-soft",
  "--color-accent-fg",
  "--color-success",
  "--color-warning",
  "--color-danger",
  "--color-info",
  "--font-family-base",
  "--font-family-mono",
  "--font-size-xl",
  "--font-size-lg",
  "--font-size-base",
  "--font-size-sm",
  "--font-size-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--line-height-ui",
  "--line-height-tight",
] as const;

// ---------- 清单解析出的问题 ----------

/**
 * 面板解析 / 路径替换的问题。`detail` 是路径、变量名、键名（语言中立）；说明它的句子由界面按语言出。
 * 在详情页「问题」里列出——解析失败不能只是「面板没出来」。
 */
export type PluginPanelProblem =
  /** `orbita.panel` 不是对象，或缺必填字段（detail = 字段名） */
  | { kind: "shape"; detail: string }
  | { kind: "template-escape"; detail: string }
  | { kind: "template-missing"; detail: string }
  | { kind: "template-unreadable"; detail: string }
  | { kind: "template-too-large"; detail: string }
  /** data 路径替换后落在允许的目录之外（detail = 替换后的路径） */
  | { kind: "data-escape"; detail: string }
  /** data 里有认不得的变量（detail = 变量名） */
  | { kind: "data-variable"; detail: string }
  /** data 引用的 `${user_config.KEY}` 必填没填（detail = 键名） */
  | { kind: "data-config-missing"; detail: string }
  /** data 引用了敏感配置项：拒绝（路径会出现在界面与日志里） */
  | { kind: "data-sensitive"; detail: string }
  /** data 用了 `${workspaceFolder}`，而当前会话不在任何工作区里 */
  | { kind: "data-needs-workspace"; detail: string }
  /**
   * `spec` / `sample` 的问题（不拦面板：面板照常出，缺的那块不出）。detail = 清单里写的原文路径，
   * too-large 为字节数。escape = 路径逃出插件根；missing = 文件不存在；unreadable = 不是文件 / 读不出来。
   */
  | { kind: "spec-escape" | "spec-missing" | "spec-unreadable" | "spec-too-large"; detail: string }
  | { kind: "sample-escape" | "sample-missing" | "sample-unreadable" | "sample-too-large"; detail: string }
  /** 样例文件不是合法 JSON（detail = 解析器的话） */
  | { kind: "sample-invalid"; detail: string };

/** 数据文件读出来之后的问题（运行时，随文件变）。 */
export type PluginPanelDataProblem =
  | { kind: "too-large"; bytes: number }
  | { kind: "invalid-json"; message: string }
  | { kind: "unreadable"; message: string };

// ---------- IPC：载入 / 草稿预览 / 动作 / 详情 ----------

/** 数据文件的此刻内容：有值（附文件 mtime）、空（不存在 / 空文件）、或读不出来。 */
export type PluginPanelData =
  | { kind: "ready"; value: unknown; updatedAt: number }
  | { kind: "empty" }
  | { kind: "problem"; problem: PluginPanelDataProblem };

export interface PluginPanelLoadRequest {
  name: string;
  /** 当前会话所在的工作区 id；Home 会话为 null */
  workspaceId: string | null;
  /** 上一次拿到的 stamp；没变就回 unchanged（面板可见时轮询，一次只是 stat） */
  stamp: string | null;
}

export type PluginPanelUnavailable =
  | "not-installed"
  | "not-enabled"
  | "no-panel"
  | "invalid"
  /** 草稿预览专用：路径不存在 / 不是插件文件夹 */
  | "not-found"
  /** 草稿预览专用：路径不在该工作区根之内（或会话不在任何工作区里） */
  | "outside-workspace";

/**
 * 草稿预览（还没安装的插件文件夹，`plugin:draft-load`）。入参一律当不可信：`path` 绝对或相对工作区根，
 * 主进程校验它落在 `workspaceId` 对应的工作区根之内（词法 + realpath 两关），工作区外一律拒。
 * 返回与 `plugin:panel-load` 同形的快照（含 `spec` / `usingSample`）；草稿没有「启用范围」，
 * 所以不会出现 not-installed / not-enabled。
 */
export interface PluginDraftLoadRequest {
  path: string;
  /** 会话所在的工作区 id；Home 会话为 null（Home 没有工作区根，草稿一律拒） */
  workspaceId: string | null;
  stamp: string | null;
}

export type PluginPanelSnapshot =
  | { kind: "unchanged" }
  | { kind: "unavailable"; stamp: string; reason: PluginPanelUnavailable; problems: PluginPanelProblem[] }
  | {
      kind: "ready";
      stamp: string;
      title: string;
      /**
       * iframe 的 src，**一次性**（主进程只给第一次取它的 iframe 文档）。非 null = 模板是新的 / 你第一次来，
       * 换上它重载 iframe；null = 模板没变，保留手里的 iframe，只更新数据。
       */
      frameUrl: string | null;
      data: PluginPanelData;
      /**
       * `data` 是不是样例：数据文件不存在 / 为空、而清单给了 `sample` 且样例读得出来。界面据此标「样例」。
       * 数据文件读不出来（坏 JSON / 超限）**不**退回样例——那是要让人看到的错误。
       */
      usingSample: boolean;
      /** 清单里 `spec` 指的 markdown 原文；没写 / 读不出来为 null（读不出来的原因在 problems） */
      spec: string | null;
      /** 不拦面板的问题：spec / sample 读不出来之类 */
      problems: PluginPanelProblem[];
    };

export interface PluginPanelActionRequest {
  name: string;
  action: string;
  payload: unknown;
}

export type PluginPanelActionFailure =
  | "invalid"
  | "action-too-long"
  | "payload-too-large"
  | "too-fast"
  | "file-full"
  | "unavailable"
  | "failed";

export type PluginPanelActionResult = { ok: true } | { ok: false; reason: PluginPanelActionFailure; message?: string };

/** 详情页「面板」与「最近产出」两块要的一切；插件没声明面板为 null。 */
export interface PluginPanelInfo {
  /** 清单里写的原文（解析失败时 title 为空串） */
  title: string;
  template: string;
  /** `spec` / `sample` 在清单里写的原文；没写为空串 */
  spec: string;
  sample: string;
  dataRaw: string;
  /** 变量替换后的绝对路径；替换 / 校验失败为 null（原因在 problems） */
  dataPath: string | null;
  /** 数据文件此刻的状态；dataPath 为 null 时 null */
  data: {
    exists: boolean;
    updatedAt: number | null;
    bytes: number | null;
    /** 最长的那个数组有几项（顶层数组或顶层对象里最长的数组属性）；不是 JSON / 没有数组为 null */
    items: number | null;
    problem: PluginPanelDataProblem | null;
  } | null;
  /** 动作日志：最后修改时间；条数（非空行，文件超 8 MB 不数为 null） */
  actions: { path: string; updatedAt: number | null; count: number | null };
  problems: PluginPanelProblem[];
  /** 插件在当前工作区启用、面板可解析：详情页的「面板」页签才有东西可看 */
  openable: boolean;
}

// ---------- 宿主 ↔ 模板的消息 ----------

export interface PanelTheme {
  /** `data-theme` 的值（light / black / graphite / copybook / typescript…） */
  name: string;
  scheme: "light" | "dark";
  vars: Record<string, string>;
}

/** 宿主 → 模板。数据为空（文件不存在 / 空）时 `data: null, state: "empty"`。 */
export interface PanelDataMessage {
  type: "orbita:data";
  data: unknown;
  state: "ready" | "empty";
  /** 数据文件 mtime（毫秒）；没有为 null */
  updatedAt: number | null;
  theme: PanelTheme;
}

/** 模板 → 宿主，校验后的形状。 */
export type PanelInbound =
  /** `emptyState`：模板自己画了空态，宿主不必再盖一行「还没有产出」 */
  | { kind: "ready"; emptyState: boolean }
  | { kind: "action"; action: string; payload: unknown }
  | { kind: "ignored" };

// ---------- 纯校验 ----------

export type PanelActionRejection = "invalid" | "action-too-long" | "payload-too-large";

export type PanelActionCheck =
  | { ok: true; action: string; payload: unknown; json: string }
  | { ok: false; reason: PanelActionRejection };

/**
 * 动作名与载荷校验。动作名：非空字符串、不含控制字符、≤ 64 字符（按 UTF-16 码元数，约定里说的「字符」）；
 * 载荷：缺省当 null，必须能 JSON 序列化（循环引用 / BigInt / 函数都拒），序列化后 ≤ 16 KB（UTF-8 字节）。
 * 返回的 `payload` 是 JSON 往返后的值——落盘的就是它，不会带着 structured clone 才有的东西进来。
 */
export function checkPanelAction(action: unknown, payload: unknown): PanelActionCheck {
  if (typeof action !== "string" || action.trim() === "") return { ok: false, reason: "invalid" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(action)) return { ok: false, reason: "invalid" };
  if (action.length > PANEL_ACTION_MAX_CHARS) return { ok: false, reason: "action-too-long" };
  let json: string | undefined;
  try {
    json = JSON.stringify(payload === undefined ? null : payload);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // 函数 / symbol 序列化成 undefined；这样的载荷不是数据
  if (json === undefined) return { ok: false, reason: "invalid" };
  if (new TextEncoder().encode(json).length > PANEL_PAYLOAD_MAX_BYTES) return { ok: false, reason: "payload-too-large" };
  return { ok: true, action, payload: JSON.parse(json) as unknown, json };
}

/**
 * 从 iframe 收到的 `message` 事件的 `data`：认 `orbita:ready` 与 `orbita:action`，别的一律忽略
 * （不抛、不回显——iframe 里的人想试探宿主，什么都看不到）。动作的校验不通过按 ignored 处理，
 * 需要告诉用户「没记下」的由调用方对 `checkPanelAction` 的结果自己处理，所以这里只做形状识别。
 */
export function parsePanelMessage(raw: unknown): PanelInbound {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "ignored" };
  const message = raw as Record<string, unknown>;
  if (message["type"] === "orbita:ready") return { kind: "ready", emptyState: message["emptyState"] === true };
  if (message["type"] === "orbita:action") return { kind: "action", action: String(message["action"] ?? ""), payload: message["payload"] };
  return { kind: "ignored" };
}

/** 数据变成「宿主 → 模板」消息要的两个字段。 */
export function dataMessageParts(data: PluginPanelData): { data: unknown; state: "ready" | "empty"; updatedAt: number | null } {
  if (data.kind === "ready") return { data: data.value, state: "ready", updatedAt: data.updatedAt };
  return { data: null, state: "empty", updatedAt: null };
}
