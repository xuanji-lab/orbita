/**
 * 插件面板的服务端：右栏要加哪些页签、一个面板此刻的模板与数据、模板回传的动作、详情页要看的信息。
 * 四个 IPC 各对一个方法（plugin/ipc.ts 薄薄一层校验入参），逻辑与可测性都在这里。
 *
 * 面板的**状态不另存**：哪个插件在哪个工作区启用来自 plugins.json 的范围（与开轮装配、已装页同一份
 * `scopeApplies`），面板声明来自清单，数据来自数据文件。每次现读——改了模板、改了数据、改了配置，
 * 下一次轮询就生效。
 */
import { join } from "node:path";
import { scopeApplies, type PluginConfigField } from "../../shared/plugin.ts";
import {
  PANEL_ACTIONS_FILE,
  PANEL_ACTIONS_MAX_PER_WINDOW,
  PANEL_ACTIONS_WINDOW_MS,
  checkPanelAction,
  type PluginPanelActionRequest,
  type PluginPanelActionResult,
  type PluginPanelData,
  type PluginPanelInfo,
  type PluginPanelLoadRequest,
  type PluginPanelProblem,
  type PluginPanelSnapshot,
  type PluginPanelTab,
  type PluginPanelUnavailable,
} from "../../shared/plugin-panel.ts";
import { parseUserConfig, readManifest } from "./manifest.ts";
import {
  ActionLimiter,
  appendActionLine,
  itemCountOf,
  locatePanelTemplate,
  parsePanelSpec,
  readActionsInfo,
  readPanelData,
  readPanelTemplate,
  resolveDataPath,
  statDataFile,
  type PanelParse,
  type PanelSpec,
} from "./panel.ts";
import type { PanelFrames } from "./panel-frame.ts";
import type { PluginRecord } from "./records.ts";

/** PluginStore 里面板要用的那一小块（测试注入假的）。 */
export interface PanelPluginSource {
  records(): Promise<PluginRecord[]>;
  rootOf(record: PluginRecord): string;
  dataDirOf(name: string): string;
}

export interface PluginPanelsDeps {
  plugins: PanelPluginSource;
  /** 工作区 id → 根目录；Home（null）或找不到为 null */
  workspaceRoot: (workspaceId: string | null) => Promise<string | null>;
  frames: PanelFrames;
  now?: () => number;
}

interface Inspected {
  record: PluginRecord;
  root: string;
  displayName: string;
  fields: PluginConfigField[];
  parse: PanelParse;
}

/** stamp 是 `[标题, 模板签名, 数据签名]` 的 JSON：renderer 原样带回来，这里拆出模板那一段判断要不要换 iframe。 */
function stampOf(title: string, template: string, data: string): string {
  return JSON.stringify([title, template, data]);
}

function templatePartOf(stamp: string | null): string | null {
  if (stamp === null) return null;
  try {
    const parsed: unknown = JSON.parse(stamp);
    if (Array.isArray(parsed) && parsed.length === 3 && typeof parsed[1] === "string") return parsed[1];
  } catch {
    // 不是我们发的 stamp：当没有
  }
  return null;
}

export class PluginPanels {
  private readonly plugins: PanelPluginSource;
  private readonly workspaceRoot: PluginPanelsDeps["workspaceRoot"];
  private readonly frames: PanelFrames;
  private readonly now: () => number;
  private readonly limiter: ActionLimiter;
  /** 同一个插件的动作排队：保证落盘顺序 = 到达顺序，也避免两次并发各自「读尺寸 → 写」互相穿插 */
  private readonly appendQueue = new Map<string, Promise<unknown>>();

  constructor(deps: PluginPanelsDeps) {
    this.plugins = deps.plugins;
    this.workspaceRoot = deps.workspaceRoot;
    this.frames = deps.frames;
    this.now = deps.now ?? Date.now;
    this.limiter = new ActionLimiter(PANEL_ACTIONS_MAX_PER_WINDOW, PANEL_ACTIONS_WINDOW_MS, this.now);
  }

  // ---------- 右栏页签 ----------

  /** 这个工作区里已启用、声明了面板且模板可解析的插件，各一个页签；没有就是空数组。 */
  async tabs(workspaceId: string | null): Promise<PluginPanelTab[]> {
    const records = (await this.plugins.records()).filter((record) => scopeApplies(record.scope, workspaceId));
    const tabs: PluginPanelTab[] = [];
    for (const record of records) {
      const inspected = await this.inspect(record);
      const spec = inspected.parse.spec;
      if (spec === null) continue;
      // 模板都找不到就不加死页签：原因在详情页「问题」里
      if (!(await locatePanelTemplate(inspected.root, spec.template)).ok) continue;
      tabs.push({ name: record.name, title: spec.title, displayName: inspected.displayName });
    }
    return tabs;
  }

  // ---------- 载入 / 轮询 ----------

  async load(request: PluginPanelLoadRequest): Promise<PluginPanelSnapshot> {
    const record = (await this.plugins.records()).find((each) => each.name === request.name);
    if (record === undefined) return this.unavailable(request.stamp, "not-installed", []);
    if (!scopeApplies(record.scope, request.workspaceId)) return this.unavailable(request.stamp, "not-enabled", []);
    const inspected = await this.inspect(record);
    const spec = inspected.parse.spec;
    if (spec === null) {
      return this.unavailable(request.stamp, inspected.parse.declared ? "invalid" : "no-panel", inspected.parse.problems);
    }
    const located = await locatePanelTemplate(inspected.root, spec.template);
    if (!located.ok) return this.unavailable(request.stamp, "invalid", [located.problem]);
    const path = await this.dataPathOf(inspected, spec, request.workspaceId);
    if (!path.ok) return this.unavailable(request.stamp, "invalid", [path.problem]);

    const stamp = stampOf(spec.title, located.stamp, (await statDataFile(path.path)).signature);
    if (stamp === request.stamp) return { kind: "unchanged" };

    // 模板没变（stamp 里模板那段一样）就不再读、不再换 iframe；你第一次来（stamp 为 null）总是给一份新的
    let frameUrl: string | null = null;
    if (templatePartOf(request.stamp) !== located.stamp) {
      const template = await readPanelTemplate(located.abs);
      if (!template.ok) return this.unavailable(request.stamp, "invalid", [template.problem]);
      frameUrl = this.frames.register(template.html);
    }
    const data: PluginPanelData = await readPanelData(path.path);
    return { kind: "ready", stamp, title: spec.title, frameUrl, data };
  }

  /** 不可用的 stamp 也要稳定：同一原因同一问题连着轮询回 unchanged，不让 renderer 反复重画。 */
  private unavailable(previous: string | null, reason: PluginPanelUnavailable, problems: PluginPanelProblem[]): PluginPanelSnapshot {
    const stamp = JSON.stringify(["unavailable", reason, JSON.stringify(problems)]);
    if (stamp === previous) return { kind: "unchanged" };
    return { kind: "unavailable", stamp, reason, problems };
  }

  // ---------- 动作 ----------

  /**
   * 模板里点按钮的回传：再校验一遍（renderer 的入参不是信任边界）→ 限速 → 追加一行
   * `{at, action, payload}` 到 `<plugin-data>/actions.jsonl`。**只做这一件事**。
   */
  async action(request: PluginPanelActionRequest): Promise<PluginPanelActionResult> {
    const checked = checkPanelAction(request.action, request.payload);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    // 按插件排队，**从查记录那一步就排**：IPC 的处理器是并发跑的，各自 await 记录读取的耗时不同，
    // 不排的话先点的动作可能后落盘（先点「有用」再点「不相关」，日志里顺序却反了，插件按日志重放就错了）
    return this.enqueue(`action:${request.name}`, async () => {
      const record = (await this.plugins.records()).find((each) => each.name === request.name);
      if (record === undefined || record.scope.kind === "off") return { ok: false, reason: "unavailable" };
      if (!this.limiter.allow(record.name)) return { ok: false, reason: "too-fast" };
      const file = join(this.plugins.dataDirOf(record.name), PANEL_ACTIONS_FILE);
      // at 用 ISO 8601 UTC 字符串：插件的脚本（Python / jq）直接读得懂
      const line = JSON.stringify({ at: new Date(this.now()).toISOString(), action: checked.action, payload: checked.payload });
      try {
        return (await appendActionLine(file, line)) === "ok" ? { ok: true } : { ok: false, reason: "file-full" };
      } catch (error) {
        return { ok: false, reason: "failed", message: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.appendQueue.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.appendQueue.set(key, tail);
    void tail.then(() => {
      if (this.appendQueue.get(key) === tail) this.appendQueue.delete(key);
    });
    return run;
  }

  // ---------- 详情页 ----------

  async info(name: string, workspaceId: string | null): Promise<PluginPanelInfo | null> {
    const record = (await this.plugins.records()).find((each) => each.name === name);
    if (record === undefined) return null;
    const inspected = await this.inspect(record);
    if (!inspected.parse.declared) return null;
    const actionsFile = join(this.plugins.dataDirOf(name), PANEL_ACTIONS_FILE);
    const actionsInfo = await readActionsInfo(actionsFile).catch(() => ({ updatedAt: null, count: null }));
    const actions = { path: actionsFile, updatedAt: actionsInfo.updatedAt, count: actionsInfo.count };
    const spec = inspected.parse.spec;
    if (spec === null) {
      return { title: "", template: "", dataRaw: "", dataPath: null, data: null, actions, problems: inspected.parse.problems, openable: false };
    }
    const problems: PluginPanelProblem[] = [];
    const located = await locatePanelTemplate(inspected.root, spec.template);
    if (!located.ok) problems.push(located.problem);
    const path = await this.dataPathOf(inspected, spec, workspaceId);
    if (!path.ok) problems.push(path.problem);

    let data: PluginPanelInfo["data"] = null;
    if (path.ok) {
      const stat = await statDataFile(path.path);
      const read = await readPanelData(path.path);
      data = {
        exists: stat.exists,
        updatedAt: stat.updatedAt,
        bytes: stat.bytes,
        items: read.kind === "ready" ? itemCountOf(read.value) : null,
        problem: read.kind === "problem" ? read.problem : null,
      };
    }
    return {
      title: spec.title,
      template: spec.template,
      dataRaw: spec.data,
      dataPath: path.ok ? path.path : null,
      data,
      actions,
      problems,
      openable: located.ok && scopeApplies(record.scope, workspaceId),
    };
  }

  // ---------- 内部 ----------

  private async inspect(record: PluginRecord): Promise<Inspected> {
    const root = this.plugins.rootOf(record);
    // 清单本身的问题（读不了 / 写坏）由 scanPlugin 在详情页报，这里只要它能读出的那部分
    const { manifest } = await readManifest(root, []).catch(() => ({ manifest: {} as Record<string, unknown> }));
    const displayName =
      typeof manifest["displayName"] === "string" && manifest["displayName"] !== "" ? manifest["displayName"] : record.name;
    return {
      record,
      root,
      displayName,
      fields: parseUserConfig(manifest["userConfig"]),
      parse: parsePanelSpec(manifest, displayName),
    };
  }

  private async dataPathOf(inspected: Inspected, spec: PanelSpec, workspaceId: string | null) {
    return resolveDataPath(spec.data, {
      root: inspected.root,
      dataDir: this.plugins.dataDirOf(inspected.record.name),
      fields: inspected.fields,
      values: inspected.record.config,
      workspaceRoot: await this.workspaceRoot(workspaceId),
    });
  }
}
