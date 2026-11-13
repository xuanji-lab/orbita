/**
 * 插件看板的快照（agent 工具 show_plugin_board 在主进程的落地）与模板仓库。
 *
 * **纯逻辑模块**（不 import electron；插件记录、会话、工作区都是注入的端口），可被 `node --test` 直测。
 *
 * 一次 show_plugin_board：
 *   1. 开关 / 会话归属；
 *   2. 找插件：已装且在这条会话的工作区启用的（按名字）；否则本会话工作区 / 工作目录里的草稿
 *      （给路径，或 `<根>/plugins/<名字>/`）——草稿路径走 `locateInside`（realpath 后必须在根内）；
 *   3. 读清单 `orbita.board` 的卡（只读这条线要用的字段）；
 *   4. 每张卡：模板走面板同一条路径规则（`locatePanelFile`：插件根内、拒逃逸、PANEL_TEMPLATE_MAX_BYTES）；
 *      数据走 `resolveDataPath`（变量替换 + 允许目录 + realpath）与 `readPanelData`（≤ 2 MB、合法 JSON）；
 *      数据为空退回 `sample`；`repeat` 把数组每项展开成一张同尺寸卡；
 *   5. 上限：单张卡数据 ≤ 256 KB、整份 ≤ 1 MB、展开后 ≤ 24 张——放不下的列进 `skipped` 并说明；
 *   6. 放进结果的卡的模板按 sha256 存进 `<userData>/board-templates/`（已有就不写），快照只记哈希。
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeTextAtomic } from "../atomic-write.ts";
import { errorCode, isNotFound } from "../fs-errors.ts";
import { isPluginName, scopeApplies } from "../../shared/plugin.ts";
import type { PluginPanelData } from "../../shared/plugin-panel.ts";
import {
  BOARD_MAX_EXPANDED_CARDS,
  BOARD_SNAPSHOT_CARD_MAX_BYTES,
  BOARD_SNAPSHOT_TOTAL_MAX_BYTES,
  BOARD_TEMPLATE_HASH_PATTERN,
  type BoardCardSnapshot,
  type BoardFrameResult,
  type BoardSkippedCard,
  type PluginBoardOutcome,
  type PluginBoardCardDecl,
  type PluginBoardInfo,
  type PluginBoardResult,
} from "../../shared/plugin-board.ts";
import { locateInside } from "./agent-requests.ts";
import { parseBoard } from "./board.ts";
import { parseTuned } from "./extras.ts";
import { manifestDisplayName, parseUserConfig, readManifest } from "./manifest.ts";
import {
  draftIdentity,
  expandRepeat,
  locatePanelFile,
  readPanelData,
  readPanelSample,
  readPanelTemplate,
  resolveDataPath,
  type BoardSource,
} from "./panel.ts";
import type { PluginRecord } from "./records.ts";

// ---------- 模板仓库 ----------

export function templateHash(html: string): string {
  return createHash("sha256").update(html, "utf8").digest("hex");
}

/**
 * `<userData>/board-templates/<sha256>.html`：按内容寻址，同一份模板只存一次。
 * 只增不删（旧会话的卡要靠它画；一份模板 ≤ 1 MB，插件模板改的次数有限）。
 */
export class BoardTemplateStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  pathOf(hash: string): string | null {
    return BOARD_TEMPLATE_HASH_PATTERN.test(hash) ? join(this.dir, `${hash}.html`) : null;
  }

  /** 存一份（已有同哈希的文件就不写），返回哈希 */
  async put(html: string): Promise<string> {
    const hash = templateHash(html);
    const path = join(this.dir, `${hash}.html`);
    const exists = await stat(path).then(
      (info) => info.isFile(),
      () => false,
    );
    if (!exists) await writeTextAtomic(path, html);
    return hash;
  }

  /** 读一份；哈希不合规 / 没有 / 内容对不上哈希（被人改过）都回 null */
  async read(hash: string): Promise<string | null> {
    const path = this.pathOf(hash);
    if (path === null) return null;
    let html: string;
    try {
      html = await readFile(path, "utf8");
    } catch (error) {
      if (isNotFound(error) || errorCode(error) === "ENOTDIR") return null;
      throw error;
    }
    return templateHash(html) === hash ? html : null;
  }
}

/**
 * `board:frame` 的处理：模板哈希 → 一次性 iframe 地址。入参不可信：不是 `{ hash: string }`、哈希不合规、
 * 仓库里没有、内容对不上哈希，都回 null。
 */
export async function boardFrameOf(
  deps: { templates: Pick<BoardTemplateStore, "read">; frames: { register(html: string): string } },
  raw: unknown,
): Promise<BoardFrameResult> {
  if (typeof raw !== "object" || raw === null) return null;
  const hash = (raw as Record<string, unknown>)["hash"];
  if (typeof hash !== "string") return null;
  const html = await deps.templates.read(hash).catch(() => null);
  return html === null ? null : { frameUrl: deps.frames.register(html) };
}

// ---------- 快照 ----------

/** PluginStore 里这里要用的那一小块（测试注入假的） */
export interface BoardPluginSource {
  records(): Promise<PluginRecord[]>;
  rootOf(record: PluginRecord): string;
  dataDirOf(name: string): string;
}

/**
 * 这个工作区（null = Home）此刻能用、且**带看板**的插件名：已装、范围覆盖它、清单里有 `orbita.board`。
 * 自动化的「选插件」下拉与校验用——自动化到点要调 show_plugin_board，没有看板的插件选了也没有东西可显示。
 */
export async function boardPluginsIn(plugins: BoardPluginSource, workspaceId: string | null): Promise<string[]> {
  const names: string[] = [];
  for (const record of await plugins.records()) {
    if (!scopeApplies(record.scope, workspaceId)) continue;
    const { manifest } = await readManifest(plugins.rootOf(record), []).catch(() => ({ manifest: {} as Record<string, unknown> }));
    if (parseBoard(manifest, record.name, []) !== null) names.push(record.name);
  }
  return names;
}

export interface PluginBoardsDeps {
  plugins: BoardPluginSource;
  templates: Pick<BoardTemplateStore, "put">;
  session: (sessionId: string) => Promise<{ cwd: string; workspaceId: string | null } | null>;
  /** 工作区 id → 根目录；找不到为 null */
  workspaceRoot: (workspaceId: string) => Promise<string | null>;
  now?: () => number;
}

/** 快照的来源：面板共用的 BoardSource（`board` 已解析）再加上结果里要写的名字、来源与草稿路径 */
interface SnapshotSource extends BoardSource {
  name: string;
  displayName: string;
  manifest: Record<string, unknown>;
  source: "installed" | "draft";
  draftPath: string | null;
}

function looksLikePath(raw: string): boolean {
  return raw.includes("/") || raw.includes("\\") || raw.startsWith(".") || raw.startsWith("~");
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

export class PluginBoards {
  private readonly deps: PluginBoardsDeps;
  private readonly now: () => number;

  constructor(deps: PluginBoardsDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async snapshot(request: { sessionId: string; plugin: string; cards: readonly string[] | null }): Promise<PluginBoardOutcome> {
    const session = await this.deps.session(request.sessionId);
    if (session === null) return { ok: false, error: "This session no longer exists." };
    const wanted = request.plugin.trim();
    if (wanted === "" || wanted.includes("\u0000")) return { ok: false, error: "show_plugin_board needs the plugin's name (or the path of the draft plugin folder)." };
    const workspaceRoot = session.workspaceId === null ? null : await this.deps.workspaceRoot(session.workspaceId);
    const found = await this.findSource(wanted, session, workspaceRoot);
    if (!found.ok) return found;
    const source = found.source;
    const board = source.board;
    if (board === null) {
      return {
        ok: false,
        error: `The plugin "${source.name}" has no "orbita.board" block in .claude-plugin/plugin.json, so there are no cards to show.`,
      };
    }
    return { ok: true, board: await this.render(source, board, request.cards) };
  }

  /** 已装（按名字、在会话工作区启用）优先；否则工作区里的草稿 */
  private async findSource(
    wanted: string,
    session: { cwd: string; workspaceId: string | null },
    workspaceRoot: string | null,
  ): Promise<{ ok: true; source: SnapshotSource } | { ok: false; error: string }> {
    const roots = [...new Set([workspaceRoot, session.cwd].filter((root): root is string => root !== null && root !== ""))];
    if (!looksLikePath(wanted)) {
      const record = (await this.deps.plugins.records()).find((each) => each.name === wanted);
      if (record !== undefined && scopeApplies(record.scope, session.workspaceId)) {
        const root = this.deps.plugins.rootOf(record);
        const { manifest } = await readManifest(root, []).catch(() => ({ manifest: {} as Record<string, unknown> }));
        const displayName = manifestDisplayName(manifest, record.name);
        return {
          ok: true,
          source: {
            name: record.name,
            displayName,
            board: parseBoard(manifest, displayName, []),
            root,
            dataDir: this.deps.plugins.dataDirOf(record.name),
            fields: parseUserConfig(manifest["userConfig"]),
            values: record.config,
            workspaceRoot,
            manifest,
            source: "installed",
            draftPath: null,
          },
        };
      }
      // 不是已装的：试 `<根>/plugins/<名字>/` 的草稿
      if (isPluginName(wanted)) {
        for (const root of roots) {
          const draft = await this.draftSource(join(root, "plugins", wanted), session.cwd, roots, workspaceRoot);
          if (draft !== null && draft.ok) return draft;
        }
      }
      const why = record !== undefined ? `is installed but not enabled in this workspace` : `is not installed`;
      return {
        ok: false,
        error:
          `The plugin "${wanted}" ${why}, and there is no draft at <workspace>/plugins/${wanted}/. ` +
          "Pass an installed plugin's name (list_plugins shows them) or the path of the plugin folder you are drafting.",
      };
    }
    const draft = await this.draftSource(wanted, session.cwd, roots, workspaceRoot);
    return draft ?? { ok: false, error: `${wanted} is not a plugin folder.` };
  }

  /** 草稿：路径必须在会话的工作区根 / 工作目录之内（realpath 后再比） */
  private async draftSource(
    raw: string,
    cwd: string,
    roots: readonly string[],
    workspaceRoot: string | null,
  ): Promise<{ ok: true; source: SnapshotSource } | { ok: false; error: string } | null> {
    const located = await locateInside(raw, cwd, roots);
    if (!located.ok) return { ok: false, error: located.error };
    const root = located.path;
    const { manifest, manifestFile } = await readManifest(root, []).catch(() => ({ manifest: {} as Record<string, unknown>, manifestFile: null }));
    if (manifestFile === null) return { ok: false, error: `${root} has no .claude-plugin/plugin.json.` };
    // 名字、显示名、数据目录与右栏草稿预览同一份公式（panel.ts 的 draftIdentity）
    const identity = draftIdentity(manifest, root, (name) => this.deps.plugins.dataDirOf(name));
    return {
      ok: true,
      source: {
        name: identity.name,
        displayName: identity.displayName,
        board: parseBoard(manifest, identity.displayName, []),
        root,
        dataDir: identity.dataDir,
        fields: parseUserConfig(manifest["userConfig"]),
        values: {},
        workspaceRoot,
        manifest,
        source: "draft",
        draftPath: root,
      },
    };
  }

  private async render(source: SnapshotSource, board: PluginBoardInfo, requested: readonly string[] | null): Promise<PluginBoardResult> {
    const skipped: BoardSkippedCard[] = [];
    const wantedIds = requested === null || requested.length === 0 ? null : new Set(requested);
    if (wantedIds !== null) {
      for (const id of wantedIds) if (!board.cards.some((card) => card.id === id)) skipped.push({ id, reason: "unknown-card", detail: id });
    }
    const cards: BoardCardSnapshot[] = [];
    let total = 0;
    for (const card of board.cards) {
      if (wantedIds !== null && !wantedIds.has(card.id)) continue;
      const located = await locatePanelFile(source.root, card.template, "template");
      if (!located.ok) {
        skipped.push({ id: card.id, reason: "template", detail: `${located.problem.kind}: ${located.problem.detail}` });
        continue;
      }
      const html = await readPanelTemplate(located.abs);
      if (!html.ok) {
        skipped.push({ id: card.id, reason: "template", detail: `${html.problem.kind}: ${html.problem.detail}` });
        continue;
      }
      const loaded = await this.cardData(source, card);
      if (!loaded.ok) {
        skipped.push({ id: card.id, reason: "data", detail: loaded.detail });
        continue;
      }
      // 展开（与右栏看板同一份 expandRepeat）：repeat 卡每项一张；数组是空的 / 没有数据画一张空态占位；其余一张
      const pieces: { data: unknown; state: "ready" | "empty" }[] = [];
      if (card.repeat !== null) {
        const expansion = expandRepeat(loaded.data, card.repeat);
        if (expansion.kind === "not-array") {
          skipped.push({ id: card.id, reason: "repeat", detail: `${card.repeat} is not an array` });
          continue;
        }
        if (expansion.kind === "none") pieces.push({ data: null, state: "empty" });
        else for (const item of expansion.items) pieces.push({ data: item, state: "ready" });
      } else {
        const value = loaded.data.kind === "ready" ? loaded.data.value : null;
        pieces.push(value === null ? { data: null, state: "empty" } : { data: value, state: "ready" });
      }
      let hash: string | null = null;
      for (const [index, piece] of pieces.entries()) {
        if (cards.length >= BOARD_MAX_EXPANDED_CARDS) {
          // repeat 卡说「还有几项」；前面的卡已经占满 24 张时，后面的非 repeat 卡不是「项太多」，算「超了整份的上限」
          if (card.repeat !== null) skipped.push({ id: card.id, reason: "repeat", detail: `${pieces.length - index} more item(s) after the ${BOARD_MAX_EXPANDED_CARDS}-card limit` });
          else skipped.push({ id: card.id, reason: "budget", detail: `over the ${BOARD_MAX_EXPANDED_CARDS}-card limit` });
          break;
        }
        const bytes = jsonBytes(piece.data);
        if (bytes > BOARD_SNAPSHOT_CARD_MAX_BYTES) {
          skipped.push({ id: card.id, reason: "too-large", detail: `${index}: ${bytes} bytes` });
          continue;
        }
        if (total + bytes > BOARD_SNAPSHOT_TOTAL_MAX_BYTES) {
          skipped.push({ id: card.id, reason: "budget", detail: `${index}: ${bytes} bytes` });
          continue;
        }
        // 模板只为真放进结果的卡存
        hash ??= await this.deps.templates.put(html.html);
        total += bytes;
        cards.push({
          id: card.id,
          title: card.title,
          size: card.size,
          index,
          template: hash,
          data: piece.data,
          state: piece.state,
          usingSample: loaded.usingSample,
          updatedAt: loaded.data.kind === "ready" && !loaded.usingSample ? loaded.data.updatedAt : null,
        });
      }
    }
    return {
      plugin: source.name,
      displayName: source.displayName,
      title: board.title,
      source: source.source,
      draftPath: source.draftPath,
      at: this.now(),
      tuned: parseTuned(source.manifest, []),
      cards,
      skipped,
    };
  }

  /** 一张卡此刻的数据：数据文件 → 空就退回样例；数据文件坏了是错误，不拿样例盖过去（同面板） */
  private async cardData(
    source: SnapshotSource,
    card: PluginBoardCardDecl,
  ): Promise<{ ok: true; data: PluginPanelData; usingSample: boolean } | { ok: false; detail: string }> {
    let data: PluginPanelData = { kind: "empty" };
    if (card.data !== null) {
      const path = await resolveDataPath(card.data, {
        root: source.root,
        dataDir: source.dataDir,
        fields: source.fields,
        values: source.values,
        workspaceRoot: source.workspaceRoot,
      });
      if (!path.ok) return { ok: false, detail: `${path.problem.kind}: ${path.problem.detail}` };
      data = await readPanelData(path.path);
      if (data.kind === "problem") {
        const problem = data.problem;
        return { ok: false, detail: problem.kind === "too-large" ? `too-large: ${problem.bytes}` : `${problem.kind}: ${problem.message}` };
      }
    }
    if (data.kind === "empty" && card.sample !== null) {
      const file = await locatePanelFile(source.root, card.sample, "sample");
      if (file.ok) {
        const sample = await readPanelSample(file.abs);
        if (sample.ok && sample.data.kind === "ready") return { ok: true, data: sample.data, usingSample: true };
      }
    }
    return { ok: true, data, usingSample: false };
  }
}
