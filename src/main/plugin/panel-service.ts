/**
 * 插件看板的服务端：一块看板此刻每张卡的模板与数据、卡里回传的动作、草稿预览的扫描。
 * IPC 各对一个方法（plugin/ipc.ts 薄薄一层校验入参），逻辑与可测性都在这里。
 *
 * 看板的**状态不另存**：哪个插件在哪个工作区启用来自 plugins.json 的范围（与开轮装配、已装页同一份
 * `scopeApplies`），看板声明来自清单，数据来自数据文件。每次现读——改了模板、改了数据、改了配置，
 * 下一次轮询就生效。轮询只做几次 stat：数据 / 样例的内容按「路径 + 签名」缓存，签名没变不重读
 * （repeat 的卡要知道有几项，才读得到内容）。
 */
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isPluginName,
  scopeApplies,
  type PluginConfigField,
  type PluginConfigValue,
  type PluginDraftSnapshot,
  type PluginPreviewRequest,
  type PluginPreviewResult,
} from "../../shared/plugin.ts";
import {
  BOARD_CARD_ID_PATTERN,
  BOARD_MAX_EXPANDED_CARDS,
  type PluginBoardCardDecl,
  type PluginBoardInfo,
} from "../../shared/plugin-board.ts";
import {
  PANEL_ACTIONS_FILE,
  PANEL_ACTIONS_MAX_PER_WINDOW,
  PANEL_ACTIONS_WINDOW_MS,
  checkPanelAction,
  type PluginBoardCardLive,
  type PluginBoardLoadRequest,
  type PluginBoardSnapshot,
  type PluginDraftLoadRequest,
  type PluginPanelActionRequest,
  type PluginPanelActionResult,
  type PluginPanelData,
  type PluginPanelProblem,
  type PluginPanelUnavailable,
} from "../../shared/plugin-panel.ts";
import { draftViewOf, emptyDraftView } from "./draft-view.ts";
import { isNotFound } from "../fs-errors.ts";
import { parseBoard } from "./board.ts";
import { parseUserConfig, readManifest } from "./manifest.ts";
import {
  ActionLimiter,
  appendActionLine,
  expandRepeat,
  locatePanelFile,
  readPanelData,
  readPanelSpec,
  readPanelTemplate,
  resolveDataPath,
  sampleProblemOf,
  statDataFile,
  type DataStat,
  type PanelFileResult,
  type ResolvedDataPath,
} from "./panel.ts";
import type { PanelFrames } from "./panel-frame.ts";
import type { PluginRecord } from "./records.ts";

/** PluginStore 里看板要用的那一小块（测试注入假的）。 */
export interface PanelPluginSource {
  records(): Promise<PluginRecord[]>;
  rootOf(record: PluginRecord): string;
  dataDirOf(name: string): string;
  /** 草稿扫描用：与安装前预览同一份解析（链接模式，只读） */
  preview(request: PluginPreviewRequest): Promise<PluginPreviewResult>;
}

export interface PluginPanelsDeps {
  plugins: PanelPluginSource;
  /** 工作区 id → 根目录；Home（null）或找不到为 null */
  workspaceRoot: (workspaceId: string | null) => Promise<string | null>;
  frames: PanelFrames;
  now?: () => number;
}

/**
 * 渲染一块看板要的一切输入：已装插件与草稿预览都归到这一个形状，载入逻辑只写一份。
 * 草稿没有配置值（`values` 为空）、没有启用范围；它的数据目录按清单里的名字算（装上之后就是那个目录）。
 */
interface BoardSource {
  root: string;
  dataDir: string;
  fields: readonly PluginConfigField[];
  values: Readonly<Record<string, PluginConfigValue>>;
  workspaceRoot: string | null;
  board: PluginBoardInfo | null;
}

/** 一张声明在这一轮里的文件状态。 */
interface DeclState {
  decl: PluginBoardCardDecl;
  template: PanelFileResult;
  /** 声明没写 data 为 null */
  dataPath: ResolvedDataPath | null;
  dataStat: DataStat | null;
  sample: PanelFileResult | null;
}

/** 从上一份 stamp 里取回的：每个 id 的模板签名与当时出了几张卡（决定哪些卡可以沿用手里的 iframe）。 */
type PreviousDecls = ReadonlyMap<string, { template: string; count: number }>;

/** stamp = `[标题, 说明签名, [[id, 模板签名, 数据签名, 样例签名, 展开张数]…]]` 的 JSON。 */
function stampOf(title: string, spec: string, decls: ReadonlyArray<readonly [string, string, string, string, number]>): string {
  return JSON.stringify([title, spec, decls]);
}

function previousDeclsOf(stamp: string | null): PreviousDecls {
  const result = new Map<string, { template: string; count: number }>();
  if (stamp === null) return result;
  try {
    const parsed: unknown = JSON.parse(stamp);
    if (Array.isArray(parsed) && parsed.length === 3 && Array.isArray(parsed[2])) {
      for (const entry of parsed[2] as unknown[]) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" && typeof entry[4] === "number") {
          result.set(entry[0], { template: entry[1], count: entry[4] });
        }
      }
    }
  } catch {
    // 不是我们发的 stamp：当没有
  }
  return result;
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** 内容缓存最多放几份（每份最大 2 MB）。 */
const CACHE_MAX = 16;

type DraftLocation = { ok: true; draftRoot: string; real: string; wsRoot: string } | { ok: false; reason: "not-found" | "outside-workspace" };

export class PluginPanels {
  private readonly plugins: PanelPluginSource;
  private readonly workspaceRoot: PluginPanelsDeps["workspaceRoot"];
  private readonly frames: PanelFrames;
  private readonly now: () => number;
  private readonly limiter: ActionLimiter;
  /** 同一个插件的动作排队：保证落盘顺序 = 到达顺序，也避免两次并发各自「读尺寸 → 写」互相穿插 */
  private readonly appendQueue = new Map<string, Promise<unknown>>();
  /** 数据 / 样例文件的内容缓存：键 = 绝对路径 + 签名，签名变了就是另一份 */
  private readonly contents = new Map<string, PluginPanelData>();

  constructor(deps: PluginPanelsDeps) {
    this.plugins = deps.plugins;
    this.workspaceRoot = deps.workspaceRoot;
    this.frames = deps.frames;
    this.now = deps.now ?? Date.now;
    this.limiter = new ActionLimiter(PANEL_ACTIONS_MAX_PER_WINDOW, PANEL_ACTIONS_WINDOW_MS, this.now);
  }

  // ---------- 载入 / 轮询 ----------

  async load(request: PluginBoardLoadRequest): Promise<PluginBoardSnapshot> {
    const record = (await this.plugins.records()).find((each) => each.name === request.name);
    if (record === undefined) return this.unavailable(request.stamp, "not-installed", []);
    if (!scopeApplies(record.scope, request.workspaceId)) return this.unavailable(request.stamp, "not-enabled", []);
    const root = this.plugins.rootOf(record);
    // 清单本身的问题（读不了 / 写坏）由 scanPlugin 在详情页报，这里只要它能读出的那部分
    const { manifest } = await readManifest(root, []).catch(() => ({ manifest: {} as Record<string, unknown> }));
    return this.render(
      {
        root,
        dataDir: this.plugins.dataDirOf(record.name),
        fields: parseUserConfig(manifest["userConfig"]),
        values: record.config,
        workspaceRoot: await this.workspaceRoot(request.workspaceId),
        board: parseBoard(manifest, manifestDisplayName(manifest, record.name), []),
      },
      request.stamp,
    );
  }

  /**
   * 草稿预览：工作区里还没安装的插件文件夹。**入参不可信**（renderer 给的路径）：
   * 必须落在这个会话所在工作区的根之内（词法一关 + realpath 一关，符号链接指到外面的也拒），
   * 工作区之外一律回 outside-workspace——不论那个路径存不存在，不给探测外部文件系统的口子。
   */
  private async locateDraft(request: PluginDraftLoadRequest): Promise<DraftLocation> {
    const wsRoot = await this.workspaceRoot(request.workspaceId);
    if (wsRoot === null || request.path.includes("\u0000")) return { ok: false, reason: "outside-workspace" };
    const draftRoot = resolve(wsRoot, request.path);
    if (!isInside(resolve(wsRoot), draftRoot)) return { ok: false, reason: "outside-workspace" };
    let real: string;
    let realWs: string;
    try {
      realWs = await realpath(wsRoot);
      real = await realpath(draftRoot);
    } catch (error) {
      // 工作区根自己读不了也按「不在里面」：宁可拒也不放行
      return { ok: false, reason: isNotFound(error) ? "not-found" : "outside-workspace" };
    }
    if (!isInside(realWs, real)) return { ok: false, reason: "outside-workspace" };
    try {
      if (!(await stat(real)).isDirectory()) return { ok: false, reason: "not-found" };
    } catch {
      return { ok: false, reason: "not-found" };
    }
    return { ok: true, draftRoot, real, wsRoot };
  }

  /** 草稿的看板（与已装的 `load` 同形）。草稿没有启用范围，不会出现 not-installed / not-enabled。 */
  async loadDraftBoard(request: PluginDraftLoadRequest): Promise<PluginBoardSnapshot> {
    const located = await this.locateDraft(request);
    if (!located.ok) return this.unavailable(request.stamp, located.reason, []);
    // 清单本身的问题这里不报：草稿还在写，写到一半的清单就是「还没有看板」
    const { manifest } = await readManifest(located.draftRoot, []).catch(() => ({ manifest: {} as Record<string, unknown> }));
    const displayName = manifestDisplayName(manifest, basename(located.draftRoot));
    // 数据目录按清单里的名字（没写 / 不合规就按文件夹名）：装上之后它就是那个目录。两个都不合规就退回草稿自己的 data/
    const manifestName = manifest["name"];
    const name = [manifestName, basename(located.draftRoot)].find((candidate): candidate is string => typeof candidate === "string" && isPluginName(candidate));
    return this.render(
      {
        root: located.draftRoot,
        dataDir: name === undefined ? join(located.draftRoot, "data") : this.plugins.dataDirOf(name),
        fields: parseUserConfig(manifest["userConfig"]),
        values: {},
        workspaceRoot: located.wsRoot,
        board: parseBoard(manifest, displayName, []),
      },
      request.stamp,
    );
  }

  /** 草稿的扫描：与已装页同形的 PluginView（「正在做」就是同一张详情长页）。内容没变回 unchanged。 */
  async loadDraftView(request: PluginDraftLoadRequest): Promise<PluginDraftSnapshot> {
    const located = await this.locateDraft(request);
    if (!located.ok) {
      const stamp = JSON.stringify(["unavailable", located.reason]);
      return stamp === request.stamp ? { kind: "unchanged" } : { kind: "unavailable", stamp, reason: located.reason };
    }
    const previewed = await this.plugins.preview({ source: { kind: "folder", path: located.real }, mode: "link" });
    // 刚建的空文件夹（还没有清单也没有技能）不是错误：显示一张什么都没聊到的页
    const view = previewed.ok
      ? draftViewOf(previewed.preview)
      : emptyDraftView(previewed.error.kind === "invalid-name" ? previewed.error.name : basename(located.draftRoot), located.real);
    const stamp = JSON.stringify(view);
    return stamp === request.stamp ? { kind: "unchanged" } : { kind: "ready", stamp, view };
  }

  /** 已装与草稿共用：把一块看板渲染成快照（或说明它为什么出不来）。 */
  private async render(source: BoardSource, previous: string | null): Promise<PluginBoardSnapshot> {
    const { board } = source;
    if (board === null) return this.unavailable(previous, "no-board", []);

    // 说明（看板级）与每张声明的文件定位 / 签名
    const specFile = board.spec === null ? null : await locatePanelFile(source.root, board.spec, "spec");
    const states: DeclState[] = [];
    for (const decl of board.cards) states.push(await this.inspectDecl(source, decl));

    // 每张声明展开成几张卡（repeat 要知道数据里有几项；内容有缓存，签名没变不重读）
    const sources = new Map<string, DeclSource>();
    for (const state of states) sources.set(state.decl.id, await this.sourceOf(state));
    const expanded = states.map((state) => expandDecl(state, sources.get(state.decl.id)!));

    const stamp = stampOf(
      board.title,
      fileSignature(specFile),
      states.map((state, index) => [
        state.decl.id,
        fileSignature(state.template),
        state.dataPath === null ? "none" : state.dataPath.ok ? (state.dataStat?.signature ?? "none") : `problem:${state.dataPath.problem.kind}:${state.dataPath.problem.detail}`,
        fileSignature(state.sample),
        expanded[index]!.cards.length,
      ]),
    );
    if (stamp === previous) return { kind: "unchanged" };

    const known = previousDeclsOf(previous);
    const problems: PluginPanelProblem[] = [];
    let specText: string | null = null;
    if (specFile !== null) {
      if (!specFile.ok) problems.push(specFile.problem);
      else {
        const text = await readPanelSpec(specFile.abs);
        if (text.ok) specText = text.text;
        else problems.push(text.problem);
      }
    }

    const templates = new Map<string, Promise<{ ok: true; html: string } | { ok: false; problem: PluginPanelProblem }>>();
    const cards: PluginBoardCardLive[] = [];
    for (let at = 0; at < states.length; at += 1) {
      const state = states[at]!;
      const { decl } = state;
      const parts = expanded[at]!;
      problems.push(...parts.boardProblems);
      for (const piece of parts.cards) {
        if (cards.length >= BOARD_MAX_EXPANDED_CARDS) {
          if (!problems.some((problem) => problem.kind === "repeat-limit")) problems.push({ kind: "repeat-limit", detail: String(BOARD_MAX_EXPANDED_CARDS) });
          break;
        }
        const cardProblems: PluginPanelProblem[] = [...parts.cardProblems];
        let broken = !state.template.ok || (state.dataPath !== null && !state.dataPath.ok);
        if (!state.template.ok) cardProblems.push(state.template.problem);
        if (state.dataPath !== null && !state.dataPath.ok) cardProblems.push(state.dataPath.problem);
        // 模板没变（上一份 stamp 里这个 id 的模板签名一样、且这一项上一轮就有）就不再读、不再换 iframe；
        // 你第一次来（stamp 为 null）总是给一份新的
        let frameUrl: string | null = null;
        const before = known.get(decl.id);
        const reuse = before !== undefined && state.template.ok && before.template === fileSignature(state.template) && piece.index < before.count;
        if (state.template.ok && !reuse) {
          let pending = templates.get(state.template.abs);
          if (pending === undefined) {
            pending = readPanelTemplate(state.template.abs);
            templates.set(state.template.abs, pending);
          }
          const html = await pending;
          if (html.ok) frameUrl = this.frames.register(html.html);
          else {
            cardProblems.push(html.problem);
            broken = true;
          }
        }
        cards.push({
          key: piece.index === 0 && !decl.repeat ? decl.id : `${decl.id}#${piece.index}`,
          id: decl.id,
          title: decl.title,
          size: decl.size,
          index: piece.index,
          problems: cardProblems,
          frameUrl,
          broken,
          data: piece.data,
          usingSample: piece.usingSample,
        });
      }
    }
    return { kind: "ready", stamp, title: board.title, spec: specText, cards, problems };
  }

  private async inspectDecl(source: BoardSource, decl: PluginBoardCardDecl): Promise<DeclState> {
    const template = await locatePanelFile(source.root, decl.template, "template");
    let dataPath: ResolvedDataPath | null = null;
    let dataStat: DataStat | null = null;
    if (decl.data !== null) {
      dataPath = await resolveDataPath(decl.data, {
        root: source.root,
        dataDir: source.dataDir,
        fields: source.fields,
        values: source.values,
        workspaceRoot: source.workspaceRoot,
      });
      if (dataPath.ok) dataStat = await statDataFile(dataPath.path);
    }
    const sample = decl.sample === null ? null : await locatePanelFile(source.root, decl.sample, "sample");
    return { decl, template, dataPath, dataStat, sample };
  }

  /** 这张声明用的内容：数据文件（没有 / 为空时退回样例）。数据读不出来（坏 JSON / 超限）不拿样例盖过去。 */
  private async sourceOf(state: DeclState): Promise<DeclSource> {
    const problems: PluginPanelProblem[] = [];
    let data: PluginPanelData = { kind: "empty" };
    if (state.dataPath !== null && state.dataPath.ok && state.dataStat !== null) {
      data = await this.cached(state.dataPath.path, state.dataStat.signature);
    }
    let usingSample = false;
    if (state.sample !== null) {
      if (!state.sample.ok) problems.push(state.sample.problem);
      else if (data.kind === "empty") {
        const sample = await this.cached(state.sample.abs, state.sample.stamp);
        if (sample.kind === "problem") problems.push(sampleProblemOf(sample.problem));
        else if (sample.kind === "ready") {
          data = sample;
          usingSample = true;
        }
      }
    }
    return { data, usingSample, problems };
  }

  private async cached(path: string, signature: string): Promise<PluginPanelData> {
    const key = `${path}\u0000${signature}`;
    const hit = this.contents.get(key);
    if (hit !== undefined) return hit;
    const data = await readPanelData(path);
    // 同一路径旧签名的内容没用了
    for (const existing of this.contents.keys()) if (existing.startsWith(`${path}\u0000`)) this.contents.delete(existing);
    this.contents.set(key, data);
    while (this.contents.size > CACHE_MAX) {
      const oldest = this.contents.keys().next();
      if (oldest.done === true) break;
      this.contents.delete(oldest.value);
    }
    return data;
  }

  /** 不可用的 stamp 也要稳定：同一原因同一问题连着轮询回 unchanged，不让 renderer 反复重画。 */
  private unavailable(previous: string | null, reason: PluginPanelUnavailable, problems: PluginPanelProblem[]): PluginBoardSnapshot {
    const stamp = JSON.stringify(["unavailable", reason, JSON.stringify(problems)]);
    if (stamp === previous) return { kind: "unchanged" };
    return { kind: "unavailable", stamp, reason, problems };
  }

  // ---------- 动作 ----------

  /**
   * 卡里点按钮的回传：再校验一遍（renderer 的入参不是信任边界）→ 限速 → 追加一行
   * `{at, action, payload, card?}` 到 `<plugin-data>/actions.jsonl`。**只做这一件事**。
   */
  async action(request: PluginPanelActionRequest): Promise<PluginPanelActionResult> {
    const checked = checkPanelAction(request.action, request.payload);
    if (!checked.ok) return { ok: false, reason: checked.reason };
    const card = request.card;
    if (card !== undefined && !(typeof card.id === "string" && BOARD_CARD_ID_PATTERN.test(card.id) && Number.isInteger(card.index) && card.index >= 0 && card.index < 1000)) {
      return { ok: false, reason: "invalid" };
    }
    // 按插件排队，**从查记录那一步就排**：IPC 的处理器是并发跑的，各自 await 记录读取的耗时不同，
    // 不排的话先点的动作可能后落盘（先点「有用」再点「不相关」，日志里顺序却反了，插件按日志重放就错了）
    return this.enqueue(`action:${request.name}`, async () => {
      const record = (await this.plugins.records()).find((each) => each.name === request.name);
      if (record === undefined || record.scope.kind === "off") return { ok: false, reason: "unavailable" };
      if (!this.limiter.allow(record.name)) return { ok: false, reason: "too-fast" };
      const file = join(this.plugins.dataDirOf(record.name), PANEL_ACTIONS_FILE);
      // at 用 ISO 8601 UTC 字符串：插件的脚本（Python / jq）直接读得懂
      const line = JSON.stringify({
        at: new Date(this.now()).toISOString(),
        action: checked.action,
        payload: checked.payload,
        ...(card === undefined ? {} : { card: { id: card.id, index: card.index } }),
      });
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
}

interface DeclSource {
  data: PluginPanelData;
  usingSample: boolean;
  /** 样例读不出来之类，挂在这张声明的每张卡上 */
  problems: PluginPanelProblem[];
}

interface ExpandedPiece {
  index: number;
  data: PluginPanelData;
  usingSample: boolean;
}

/** 一张声明展开成几张卡（repeat 一项一张；没有项画一张占位卡；属性不是数组不出卡并报问题）。纯函数，带测试。 */
export function expandDecl(
  state: Pick<DeclState, "decl">,
  source: DeclSource,
): { cards: ExpandedPiece[]; cardProblems: PluginPanelProblem[]; boardProblems: PluginPanelProblem[] } {
  const { decl } = state;
  if (decl.repeat === null) {
    return { cards: [{ index: 0, data: source.data, usingSample: source.usingSample }], cardProblems: source.problems, boardProblems: [] };
  }
  const expansion = expandRepeat(source.data, decl.repeat);
  if (expansion.kind === "not-array") {
    return { cards: [], cardProblems: [], boardProblems: [{ kind: "repeat-not-array", detail: decl.repeat }, ...source.problems] };
  }
  if (expansion.kind === "none") {
    return { cards: [{ index: 0, data: source.data, usingSample: source.usingSample }], cardProblems: source.problems, boardProblems: [] };
  }
  const updatedAt = source.data.kind === "ready" ? source.data.updatedAt : 0;
  return {
    cards: expansion.items.map((item, index) => ({ index, data: { kind: "ready", value: item, updatedAt }, usingSample: source.usingSample })),
    cardProblems: source.problems,
    boardProblems: [],
  };
}

/** 清单的 displayName（非空字符串）优先，否则退回给定的名字。 */
function manifestDisplayName(manifest: Record<string, unknown>, fallback: string): string {
  const value = manifest["displayName"];
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** 文件进 stamp 的签名：没写 `none`；读得到用 mtime:size；有问题带上问题分类（问题变了也要刷新）。 */
function fileSignature(file: PanelFileResult | null): string {
  if (file === null) return "none";
  return file.ok ? file.stamp : `problem:${file.problem.kind}:${file.problem.detail}`;
}
