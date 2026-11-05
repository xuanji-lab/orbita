/**
 * 插件看板卡的宿主契约 —— IPC 四层的第 1 层（卡的沙箱、协议、消息与 IPC 这一半；
 * 清单与视图类型在 plugin-board.ts，插件本体的契约在 plugin.ts）。
 *
 * **一张卡 = 插件自带的一份 HTML 模板 + 一个 JSON 数据文件**，由宿主按固定尺寸画在看板里
 * （清单写法与尺寸见 plugin-board.ts：`orbita.board.cards[]`）。每张卡**各自一个沙箱 iframe**，
 * 外框（四档尺寸、圆角、overflow）与卡外的标题行、「样例」标由宿主画，模板只管框里。
 * `orbita.panel`（旧的单面板）已作废，不再渲染。
 *
 * **模板当不可信代码**（agent 生成，或第三方插件带来）：它在 `sandbox="allow-scripts"`（不给
 * allow-same-origin）的 iframe 里跑，页面由主进程经自定义协议 `orbita-panel://` 给出，CSP 走响应头
 * （见 main/plugin/panel-frame.ts）；它只有两条路和外界说话——收宿主的 `postMessage`，向宿主发
 * `orbita:ready` / `orbita:action`。动作只会被追加进 `<plugin-data>/actions.jsonl`（多记一个 `card` 字段），
 * 宿主不据此做任何别的事；插件自己的脚本下一轮去读它。
 *
 * 这里放：各种上限、IPC 的请求 / 响应形状、宿主与模板之间的消息，以及两端共用的
 * 纯校验函数（renderer 收 iframe 消息时校验，主进程落盘前再校验一遍——renderer 的入参不是信任边界）。
 */
import type { BoardCardSize } from "./plugin-board.ts";

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

// ---------- 载入时的问题 ----------

/**
 * 看板 / 卡的路径解析与载入问题（清单本身的写法问题在 `PluginProblem`）。`detail` 是路径、变量名、键名
 * （语言中立）；说明它的句子由界面按语言出。出在哪张卡上就挂在那张卡的 `problems` 里，看板级的挂在快照上。
 */
export type PluginPanelProblem =
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
   * `spec` / `sample` 的问题（不拦卡：卡照常出，缺的那块不出）。detail = 清单里写的原文路径，
   * too-large 为字节数。escape = 路径逃出插件根；missing = 文件不存在；unreadable = 不是文件 / 读不出来。
   */
  | { kind: "spec-escape" | "spec-missing" | "spec-unreadable" | "spec-too-large"; detail: string }
  | { kind: "sample-escape" | "sample-missing" | "sample-unreadable" | "sample-too-large"; detail: string }
  /** 样例文件不是合法 JSON（detail = 解析器的话） */
  | { kind: "sample-invalid"; detail: string }
  /** `repeat` 指的属性在数据里不是数组（detail = 属性名）：这一块声明不出卡 */
  | { kind: "repeat-not-array"; detail: string }
  /** `repeat` 展开后超过整块看板的卡数上限，多出的丢掉（detail = 上限） */
  | { kind: "repeat-limit"; detail: string };

/** 数据文件读出来之后的问题（运行时，随文件变）。 */
export type PluginPanelDataProblem =
  | { kind: "too-large"; bytes: number }
  | { kind: "invalid-json"; message: string }
  | { kind: "unreadable"; message: string };

// ---------- IPC：载入 / 草稿 / 动作 ----------

/** 数据文件的此刻内容：有值（附文件 mtime）、空（不存在 / 空文件）、或读不出来。 */
export type PluginPanelData =
  | { kind: "ready"; value: unknown; updatedAt: number }
  | { kind: "empty" }
  | { kind: "problem"; problem: PluginPanelDataProblem };

export interface PluginBoardLoadRequest {
  name: string;
  /** 当前会话所在的工作区 id；Home 会话为 null */
  workspaceId: string | null;
  /** 上一次拿到的 stamp；没变就回 unchanged（看板可见时轮询，一次只是几次 stat） */
  stamp: string | null;
}

export type PluginPanelUnavailable =
  | "not-installed"
  | "not-enabled"
  /** 插件没有声明看板（或整块写坏了：原因在详情页的问题里） */
  | "no-board"
  /** 草稿预览专用：路径不存在 / 不是插件文件夹 */
  | "not-found"
  /** 草稿预览专用：路径不在该工作区根之内（或会话不在任何工作区里） */
  | "outside-workspace";

/**
 * 草稿预览（还没安装的插件文件夹，`plugin:draft-load` 取扫描、`plugin:draft-board-load` 取看板）。
 * 入参一律当不可信：`path` 绝对或相对工作区根，主进程校验它落在 `workspaceId` 对应的工作区根之内
 * （词法 + realpath 两关），工作区外一律拒。草稿没有「启用范围」，所以不会出现 not-installed / not-enabled。
 */
export interface PluginDraftLoadRequest {
  path: string;
  /** 会话所在的工作区 id；Home 会话为 null（Home 没有工作区根，草稿一律拒） */
  workspaceId: string | null;
  stamp: string | null;
}

/** 看板里的一张活卡（`repeat` 已展开）。 */
export interface PluginBoardCardLive {
  /** 展开后整块看板内唯一：普通卡 = id；repeat 的第 n 项 = `id#n` */
  key: string;
  id: string;
  title: string;
  size: BoardCardSize;
  /** repeat 的第几项；普通卡 0 */
  index: number;
  /** 这张卡的问题（模板读不出来 / 数据路径越界）：有 `broken` 才拦这张卡，其余只是提醒 */
  problems: PluginPanelProblem[];
  /**
   * iframe 的 src，**一次性**（主进程只给第一次取它的 iframe 文档）。非 null = 模板是新的 / 你第一次来，
   * 换上它重载 iframe；null = 模板没变，保留手里的 iframe，只更新数据。`broken` 的卡为 null 且 `broken = true`。
   */
  frameUrl: string | null;
  /** 这张卡出不来（模板路径越界 / 缺失 / 读不出来 / 数据路径越界）：宿主在框里写原因，不渲染 iframe */
  broken: boolean;
  data: PluginPanelData;
  /** `data` 是不是样例：数据文件不存在 / 为空、而声明给了 `sample` 且样例读得出来。界面据此在卡外标「样例」 */
  usingSample: boolean;
}

export type PluginBoardSnapshot =
  | { kind: "unchanged" }
  | { kind: "unavailable"; stamp: string; reason: PluginPanelUnavailable; problems: PluginPanelProblem[] }
  | {
      kind: "ready";
      stamp: string;
      title: string;
      /** 清单里 `spec` 指的 markdown 原文；没写 / 读不出来为 null（读不出来的原因在 problems） */
      spec: string | null;
      cards: PluginBoardCardLive[];
      /** 看板级的问题：spec 读不出来、repeat 不是数组、超限 */
      problems: PluginPanelProblem[];
    };

/** 动作所属的卡（和 `orbita:data` 里的 `card` 对应；落进 actions.jsonl 的 `card` 字段）。 */
export interface PluginBoardCardRef {
  id: string;
  index: number;
}

export interface PluginPanelActionRequest {
  name: string;
  action: string;
  payload: unknown;
  /** 哪张卡点的；不给（旧调用方）就不记 */
  card?: PluginBoardCardRef;
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

// ---------- 宿主 ↔ 模板的消息 ----------

export interface PanelTheme {
  /** `data-theme` 的值（light / black / graphite / copybook / typescript…） */
  name: string;
  scheme: "light" | "dark";
  vars: Record<string, string>;
}

/**
 * 宿主 → 模板。数据为空（文件不存在 / 空）时 `data: null, state: "empty"`。
 * repeat 的卡收到的 `data` 是那一项。`card` 说这是哪张卡、第几项；`unit` 是**一格**的像素宽高
 * （2x2 卡的框是 2 倍多一点），模板可据此等比取字号——窗口放大缩小时宿主会重发。
 */
export interface PanelDataMessage {
  type: "orbita:data";
  data: unknown;
  state: "ready" | "empty";
  /** 数据文件 mtime（毫秒）；没有为 null */
  updatedAt: number | null;
  theme: PanelTheme;
  card: { id: string; size: BoardCardSize; index: number };
  unit: { width: number; height: number };
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

/** 数据变成「宿主 → 模板」消息要的三个字段。 */
export function dataMessageParts(data: PluginPanelData): { data: unknown; state: "ready" | "empty"; updatedAt: number | null } {
  if (data.kind === "ready") return { data: data.value, state: "ready", updatedAt: data.updatedAt };
  return { data: null, state: "empty", updatedAt: null };
}
