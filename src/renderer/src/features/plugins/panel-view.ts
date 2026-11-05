/**
 * 看板卡宿主的纯逻辑：主题变量怎么读、数据怎么在「新读到的」与「上一份好的」之间取舍、
 * 宿主何时盖「还没有产出」、动作回传的反馈文案、原始数据怎么截。
 * 单独成文件只为可测——`node --test` 只加载 .ts，这些判定写在 .tsx 里就没法直接跑。
 */
import {
  PANEL_DATA_MAX_BYTES,
  PANEL_SPEC_MAX_BYTES,
  PANEL_THEME_VARS,
  type PanelTheme,
  type PluginPanelActionFailure,
  type PluginPanelData,
  type PluginPanelDataProblem,
  type PluginPanelProblem,
} from "../../../../shared/plugin-panel.ts";
import type { Messages } from "../../messages-en.ts";

type T = Messages["pluginPanel"];

// ---------- 主题 ----------

/**
 * 把当前主题的计算值打包成下发给模板的 `theme`。`read` 读一个 CSS 属性的计算值（自定义属性与 `color-scheme`），
 * 取不到（空串）的变量不发——模板的 `var(--x, 回退)` 自己有回退。纯函数：DOM 读取在调用方（readPanelTheme）。
 */
export function buildPanelTheme(read: (property: string) => string, themeName: string): PanelTheme {
  const vars: Record<string, string> = {};
  for (const name of PANEL_THEME_VARS) {
    const value = read(name).trim();
    if (value !== "") vars[name] = value;
  }
  return { name: themeName, scheme: read("color-scheme").includes("dark") ? "dark" : "light", vars };
}

/** 从文档根读此刻的主题（浅 / 暗 / 黛 / 纸面各档的计算值自然不同；字号基准改了 calc 也跟着变）。 */
export function readPanelTheme(root: HTMLElement): PanelTheme {
  const style = getComputedStyle(root);
  return buildPanelTheme((property) => (property === "color-scheme" ? style.colorScheme : style.getPropertyValue(property)), root.dataset["theme"] ?? "light");
}

/** 两份主题是否一样（变了才重发，避免属性抖动时反复 postMessage）。 */
export function sameTheme(a: PanelTheme | null, b: PanelTheme | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.name !== b.name || a.scheme !== b.scheme) return false;
  const keys = Object.keys(a.vars);
  return keys.length === Object.keys(b.vars).length && keys.every((key) => a.vars[key] === b.vars[key]);
}

// ---------- 数据 ----------

export interface ShownData {
  /** 发给模板的那份（有问题时是上一份好的，没有就空） */
  shown: PluginPanelData;
  /** 此刻读不出来的原因；null = 读得出来 */
  problem: PluginPanelDataProblem | null;
  /** 上一份读成功的（有值的）；文件被清空 / 删掉后清掉 */
  lastGood: Extract<PluginPanelData, { kind: "ready" }> | null;
}

/**
 * 新读到的数据与上一份好的怎么取舍：读成功就换；文件真的空了 / 没了就回到空态（不留旧数据，
 * 否则用户删了数据面板还显示着）；**读不出来（agent 非原子地写到一半、超 2 MB）时留着上一份好的**，
 * 只在面板上说明原因——一次写到一半的瞬间不该让面板闪成空白。
 */
export function reduceShownData(lastGood: ShownData["lastGood"], incoming: PluginPanelData): ShownData {
  if (incoming.kind === "ready") return { shown: incoming, problem: null, lastGood: incoming };
  if (incoming.kind === "empty") return { shown: incoming, problem: null, lastGood: null };
  return { shown: lastGood ?? { kind: "empty" }, problem: incoming.problem, lastGood };
}

/**
 * 宿主要不要盖一行「还没有产出」：数据为空、没有读取问题（有问题时问题条已经说明了）、
 * 模板没有声明自己画了空态，并且 load 后已过了宽限（给模板发 ready 留时间，别先闪一下宿主的行再被换掉）。
 */
export function showHostEmpty(args: { shown: PluginPanelData; problem: PluginPanelDataProblem | null; templateHandlesEmpty: boolean; graceOver: boolean }): boolean {
  return args.shown.kind === "empty" && args.problem === null && !args.templateHandlesEmpty && args.graceOver;
}

// ---------- 文案 ----------

/** 字节数说成人话（1.5 KB / 3.2 MB）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 「超限」那句话里的两个数：都用 KB 整数（向上取整），才不会写出「有 2.0 MB，超过 2.0 MB 的上限」这种
 * 自相矛盾的话（2 MB 零点几 KB 按一位小数取整就是 2.0）；很大时（≥ 10 MB）才换 MB。
 */
export function formatSizeVsLimit(bytes: number, limit: number): { size: string; limit: string } {
  if (bytes >= 10 * 1024 * 1024) return { size: formatBytes(bytes), limit: formatBytes(limit) };
  return { size: `${Math.ceil(bytes / 1024)} KB`, limit: `${Math.floor(limit / 1024)} KB` };
}

export function dataProblemText(t: T, problem: PluginPanelDataProblem, limit: number): string {
  switch (problem.kind) {
    case "too-large": {
      const pair = formatSizeVsLimit(problem.bytes, limit);
      return t.dataTooLarge(pair.size, pair.limit);
    }
    case "invalid-json":
      return t.dataInvalidJson(problem.message);
    case "unreadable":
      return t.dataUnreadable(problem.message);
  }
}

export function panelProblemText(t: T, problem: PluginPanelProblem): string {
  const detail = problem.detail;
  switch (problem.kind) {
    case "template-escape":
      return t.problem.templateEscape(detail);
    case "template-missing":
      return t.problem.templateMissing(detail);
    case "template-unreadable":
      return t.problem.templateUnreadable(detail);
    case "template-too-large":
      return t.problem.templateTooLarge(formatBytes(Number(detail) || 0));
    case "data-escape":
      return t.problem.dataEscape(detail);
    case "data-variable":
      return t.problem.dataVariable(detail);
    case "data-config-missing":
      return t.problem.dataConfigMissing(detail);
    case "data-sensitive":
      return t.problem.dataSensitive(detail);
    case "data-needs-workspace":
      return t.problem.dataNeedsWorkspace;
    case "spec-escape":
      return t.problem.specEscape(detail);
    case "spec-missing":
      return t.problem.specMissing(detail);
    case "spec-unreadable":
      return t.problem.specUnreadable(detail);
    case "spec-too-large":
      return t.problem.specTooLarge(formatBytes(Number(detail) || 0), formatBytes(PANEL_SPEC_MAX_BYTES));
    case "sample-escape":
      return t.problem.sampleEscape(detail);
    case "sample-missing":
      return t.problem.sampleMissing(detail);
    case "sample-unreadable":
      return t.problem.sampleUnreadable(detail);
    case "sample-too-large":
      return t.problem.sampleTooLarge(formatBytes(Number(detail) || 0), formatBytes(PANEL_DATA_MAX_BYTES));
    case "sample-invalid":
      return t.problem.sampleInvalid(detail);
    case "repeat-not-array":
      return t.problem.repeatNotArray(detail);
    case "repeat-limit":
      return t.problem.repeatLimit(detail);
  }
}

export function actionFailureText(t: T, reason: PluginPanelActionFailure): string {
  return t.actionFailure[reason];
}
