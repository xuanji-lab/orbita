/**
 * 插件面板的服务端：右栏要加哪些页签、一个面板此刻的模板与数据、模板回传的动作、详情页要看的信息。
 * 四个 IPC 各对一个方法（plugin/ipc.ts 薄薄一层校验入参），逻辑与可测性都在这里。
 *
 * 面板的**状态不另存**：哪个插件在哪个工作区启用来自 plugins.json 的范围（与开轮装配、已装页同一份
 * `scopeApplies`），面板声明来自清单，数据来自数据文件。每次现读——改了模板、改了数据、改了配置，
 * 下一次轮询就生效。
 */
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isPluginName, scopeApplies, type PluginConfigField, type PluginConfigValue } from "../../shared/plugin.ts";
import {
  PANEL_ACTIONS_FILE,
  PANEL_ACTIONS_MAX_PER_WINDOW,
  PANEL_ACTIONS_WINDOW_MS,
  checkPanelAction,
  type PluginDraftLoadRequest,
  type PluginPanelActionRequest,
  type PluginPanelActionResult,
  type PluginPanelData,
  type PluginPanelInfo,
  type PluginPanelLoadRequest,
  type PluginPanelProblem,
  type PluginPanelSnapshot,
  type PluginPanelUnavailable,
} from "../../shared/plugin-panel.ts";
import { parseUserConfig, readManifest } from "./manifest.ts";
import {
  ActionLimiter,
  appendActionLine,
  itemCountOf,
  locatePanelFile,
  locatePanelTemplate,
  parsePanelSpec,
  readActionsInfo,
  readPanelData,
  readPanelSample,
  readPanelSpec,
  readPanelTemplate,
  resolveDataPath,
  statDataFile,
  type PanelParse,
  type PanelSpec,
} from "./panel.ts";
import { isNotFound } from "../fs-errors.ts";
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

/**
 * 渲染一个面板要的一切输入：已装插件与草稿预览都归到这一个形状，载入逻辑只写一份。
 * 草稿没有配置值（`values` 为空）、没有启用范围；它的数据目录按清单里的名字算（装上之后就是那个目录）。
 */
interface PanelSource {
  root: string;
  dataDir: string;
  fields: readonly PluginConfigField[];
  values: Readonly<Record<string, PluginConfigValue>>;
  workspaceRoot: string | null;
  parse: PanelParse;
}

/**
 * stamp 是 `[标题, 模板签名, 数据签名, 样例签名, 说明签名]` 的 JSON：renderer 原样带回来，
 * 这里拆出模板那一段判断要不要换 iframe；其余各段只用来判断「有没有变」。
 */
function stampOf(title: string, template: string, data: string, sample: string, spec: string): string {
  return JSON.stringify([title, template, data, sample, spec]);
}

function templatePartOf(stamp: string | null): string | null {
  if (stamp === null) return null;
  try {
    const parsed: unknown = JSON.parse(stamp);
    if (Array.isArray(parsed) && parsed.length === 5 && typeof parsed[1] === "string") return parsed[1];
  } catch {
    // 不是我们发的 stamp：当没有
  }
  return null;
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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

  // ---------- 载入 / 轮询 ----------

  async load(request: PluginPanelLoadRequest): Promise<PluginPanelSnapshot> {
    const record = (await this.plugins.records()).find((each) => each.name === request.name);
    if (record === undefined) return this.unavailable(request.stamp, "not-installed", []);
    if (!scopeApplies(record.scope, request.workspaceId)) return this.unavailable(request.stamp, "not-enabled", []);
    const inspected = await this.inspect(record);
    return this.render(
      {
        root: inspected.root,
        dataDir: this.plugins.dataDirOf(record.name),
        fields: inspected.fields,
        values: record.config,
        workspaceRoot: await this.workspaceRoot(request.workspaceId),
        parse: inspected.parse,
      },
      request.stamp,
    );
  }

  /**
   * 草稿预览：工作区里还没安装的插件文件夹。**入参不可信**（renderer 给的路径）：
   * 必须落在这个会话所在工作区的根之内（词法一关 + realpath 一关，符号链接指到外面的也拒），
   * 工作区之外一律回 outside-workspace——不论那个路径存不存在，不给探测外部文件系统的口子。
   * 之后与已装面板走同一条渲染（模板、数据、样例、说明、CSP、iframe 协议）。
   */
  async loadDraft(request: PluginDraftLoadRequest): Promise<PluginPanelSnapshot> {
    const wsRoot = await this.workspaceRoot(request.workspaceId);
    if (wsRoot === null || request.path.includes("\u0000")) return this.unavailable(request.stamp, "outside-workspace", []);
    const draftRoot = resolve(wsRoot, request.path);
    if (!isInside(resolve(wsRoot), draftRoot)) return this.unavailable(request.stamp, "outside-workspace", []);
    let real: string;
    let realWs: string;
    try {
      realWs = await realpath(wsRoot);
      real = await realpath(draftRoot);
    } catch (error) {
      // 工作区根自己读不了也按「不在里面」：宁可拒也不放行
      return this.unavailable(request.stamp, isNotFound(error) ? "not-found" : "outside-workspace", []);
    }
    if (!isInside(realWs, real)) return this.unavailable(request.stamp, "outside-workspace", []);
    try {
      if (!(await stat(real)).isDirectory()) return this.unavailable(request.stamp, "not-found", []);
    } catch {
      return this.unavailable(request.stamp, "not-found", []);
    }
    // 清单本身的问题这里不报：草稿还在写，写到一半的清单就是「还没有面板」
    const { manifest } = await readManifest(draftRoot, []).catch(() => ({ manifest: {} as Record<string, unknown> }));
    const displayName = manifestDisplayName(manifest, basename(draftRoot));
    // 数据目录按清单里的名字（没写 / 不合规就按文件夹名）：装上之后它就是那个目录。两个都不合规就退回草稿自己的 data/
    const manifestName = manifest["name"];
    const name = [manifestName, basename(draftRoot)].find((candidate): candidate is string => typeof candidate === "string" && isPluginName(candidate));
    return this.render(
      {
        root: draftRoot,
        dataDir: name === undefined ? join(draftRoot, "data") : this.plugins.dataDirOf(name),
        fields: parseUserConfig(manifest["userConfig"]),
        values: {},
        workspaceRoot: wsRoot,
        parse: parsePanelSpec(manifest, displayName),
      },
      request.stamp,
    );
  }

  /** 已装与草稿共用：把一个面板来源渲染成快照（或说明它为什么出不来）。 */
  private async render(source: PanelSource, previous: string | null): Promise<PluginPanelSnapshot> {
    const spec = source.parse.spec;
    if (spec === null) {
      return this.unavailable(previous, source.parse.declared ? "invalid" : "no-panel", source.parse.problems);
    }
    const located = await locatePanelTemplate(source.root, spec.template);
    if (!located.ok) return this.unavailable(previous, "invalid", [located.problem]);
    const path = await this.dataPathOf(source, spec);
    if (!path.ok) return this.unavailable(previous, "invalid", [path.problem]);
    const sampleFile = spec.sample === null ? null : await locatePanelFile(source.root, spec.sample, "sample");
    const specFile = spec.spec === null ? null : await locatePanelFile(source.root, spec.spec, "spec");

    const stamp = stampOf(
      spec.title,
      located.stamp,
      (await statDataFile(path.path)).signature,
      fileSignature(sampleFile),
      fileSignature(specFile),
    );
    if (stamp === previous) return { kind: "unchanged" };

    // 模板没变（stamp 里模板那段一样）就不再读、不再换 iframe；你第一次来（stamp 为 null）总是给一份新的
    let frameUrl: string | null = null;
    if (templatePartOf(previous) !== located.stamp) {
      const template = await readPanelTemplate(located.abs);
      if (!template.ok) return this.unavailable(previous, "invalid", [template.problem]);
      frameUrl = this.frames.register(template.html);
    }
    // 不拦面板的问题：清单里 spec / sample 写歪了、文件读不出来
    const problems: PluginPanelProblem[] = [...source.parse.notices];
    if (sampleFile !== null && !sampleFile.ok) problems.push(sampleFile.problem);
    if (specFile !== null && !specFile.ok) problems.push(specFile.problem);

    let data: PluginPanelData = await readPanelData(path.path);
    let usingSample = false;
    // 只有「没有数据」才退回样例；数据文件坏了（坏 JSON / 超限）是要让人看到的错误，不拿样例盖过去
    if (data.kind === "empty" && sampleFile !== null && sampleFile.ok) {
      const sample = await readPanelSample(sampleFile.abs);
      if (!sample.ok) problems.push(sample.problem);
      else if (sample.data.kind === "ready") {
        data = sample.data;
        usingSample = true;
      }
    }
    let specText: string | null = null;
    if (specFile !== null && specFile.ok) {
      const text = await readPanelSpec(specFile.abs);
      if (text.ok) specText = text.text;
      else problems.push(text.problem);
    }
    return { kind: "ready", stamp, title: spec.title, frameUrl, data, usingSample, spec: specText, problems };
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
      return { title: "", template: "", spec: "", sample: "", dataRaw: "", dataPath: null, data: null, actions, problems: inspected.parse.problems, openable: false };
    }
    const problems: PluginPanelProblem[] = [...inspected.parse.notices];
    const located = await locatePanelTemplate(inspected.root, spec.template);
    if (!located.ok) problems.push(located.problem);
    const source = await this.sourceOf(inspected, workspaceId);
    const path = await this.dataPathOf(source, spec);
    if (!path.ok) problems.push(path.problem);
    // spec / sample 只看定位（逃逸 / 缺失 / 超限），不在这里读内容：详情页每 4 秒问一次，样例可达 2 MB
    for (const [raw, field] of [[spec.spec, "spec"], [spec.sample, "sample"]] as const) {
      if (raw === null) continue;
      const file = await locatePanelFile(inspected.root, raw, field);
      if (!file.ok) problems.push(file.problem);
    }

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
      spec: spec.spec ?? "",
      sample: spec.sample ?? "",
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
    const displayName = manifestDisplayName(manifest, record.name);
    return {
      record,
      root,
      displayName,
      fields: parseUserConfig(manifest["userConfig"]),
      parse: parsePanelSpec(manifest, displayName),
    };
  }

  private async sourceOf(inspected: Inspected, workspaceId: string | null): Promise<PanelSource> {
    return {
      root: inspected.root,
      dataDir: this.plugins.dataDirOf(inspected.record.name),
      fields: inspected.fields,
      values: inspected.record.config,
      workspaceRoot: await this.workspaceRoot(workspaceId),
      parse: inspected.parse,
    };
  }

  private async dataPathOf(source: PanelSource, spec: PanelSpec) {
    return resolveDataPath(spec.data, {
      root: source.root,
      dataDir: source.dataDir,
      fields: source.fields,
      values: source.values,
      workspaceRoot: source.workspaceRoot,
    });
  }
}

/** 清单的 displayName（非空字符串）优先，否则退回给定的名字。 */
function manifestDisplayName(manifest: Record<string, unknown>, fallback: string): string {
  const value = manifest["displayName"];
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** 面板辅助文件（样例 / 说明）进 stamp 的签名：没写 `none`；读得到用 mtime:size；有问题带上问题分类（问题变了也要刷新）。 */
function fileSignature(file: { ok: true; stamp: string } | { ok: false; problem: PluginPanelProblem } | null): string {
  if (file === null) return "none";
  return file.ok ? file.stamp : `problem:${file.problem.kind}:${file.problem.detail}`;
}
