/**
 * 插件存储：安装记录、副本目录、暂存、卸载归档、启用范围、配置值、开轮装配。
 *
 * **内置插件**（BUILTIN_PLUGIN_NAMES，如 plugin-creator）：内容在安装包的资源目录里（`builtinRoot`），
 * 随应用版本更新、不复制进 userData。没有记录时按默认（对所有工作区启用）合成一条，用户停用 /
 * 改范围时才写进 plugins.json；可停用、不可卸载。
 *
 * 目录布局（都在 userData 下，**不写进用户自己的 skills 目录和 mcp.json**）：
 *
 *   plugins.json                      安装记录（原子写）
 *   plugins/<name>/                   复制 / git 安装的副本（链接安装没有，记录里只有源路径）
 *   plugin-data/<name>/               `${CLAUDE_PLUGIN_DATA}`：插件自己的数据，卸载也留着
 *   plugins-archive/<name>-<时间戳>/    卸载 = 归档不是删除：副本整个挪到这里，旁边一个同名 .json 存记录
 *   plugins-staging/<id>/             预览期的暂存副本（启动时清空）
 *
 * **链接安装永远不碰用户的源文件夹**：不写、不挪、不删；卸载只归档记录。
 *
 * 所有改记录的操作排同一条 Promise 链：两次并发安装 / 改范围各自从旧文件读起，后写的会整条
 * 覆盖先写的（同 McpStore.mutate 吃过的亏）。
 */
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import type { SecretsPort } from "../provider/store.ts";
import { isHttpServer, type McpServer, type McpWorkspace } from "../../shared/mcp.ts";
import {
  BUILTIN_PLUGIN_NAMES,
  isBlockingMcpProblem,
  pluginViewId,
  scopeApplies,
  type PluginArchiveEntry,
  type PluginConfigField,
  type PluginConfigState,
  type PluginConfigValue,
  type PluginInstallRequest,
  type PluginInstallResult,
  type PluginMcpInfo,
  type PluginMcpProblem,
  type PluginPreview,
  type PluginPreviewRequest,
  type PluginPreviewResult,
  type PluginProblem,
  type PluginPlacement,
  type PluginScope,
  type PluginSource,
  type PluginSkillFile,
  type PluginSourceRecord,
  type PluginView,
} from "../../shared/plugin.ts";
import { EMPTY_PLUGIN_IO } from "../../shared/plugin-board.ts";
import type { SkillMeta } from "../../shared/skill.ts";
import { findConflicts, skillsCollide, type OtherPlugin, type SkillIdentity } from "./conflicts.ts";
import { checkGitUrl, repoNameOf, runGit, stageCopy, stageGit, type GitRunner } from "./install.ts";
import { scanPlugin, type ScannedPlugin } from "./manifest.ts";
import { qualifiedPluginServerName } from "./names.ts";
import { parseArchiveEntry, parseScope, readPluginRecords, serializePluginRecords, type PluginRecord } from "./records.ts";
import { formatCommandLine, substituteServer, type VarContext } from "./vars.ts";

/** 详情页只读查看技能时的大小上限。 */
const SKILL_FILE_MAX_BYTES = 256 * 1024;

/** 暂存超过这么久没人确认就当放弃（对话框开着不动一小时的人很少，留着只占盘）。 */
const STAGED_TTL_MS = 30 * 60 * 1000;

export interface PluginStoreDeps {
  configDir: string;
  secrets: SecretsPort;
  /** 用户自己的技能（中心存储里每一条）：冲突检测与开轮装配都要避开它们 */
  userSkills: () => Promise<SkillIdentity[]>;
  /** 内置插件的内容目录（`<它>/<插件名>/`）；缺席 = 没有内置插件（测试夹具、没带资源的开发环境） */
  builtinRoot?: string;
  /** git 执行器；测试注入假的 */
  git?: GitRunner;
  now?: () => number;
}

interface StagedPreview {
  dir: string;
  source: PluginSource;
  mode: "copy" | "git";
  commit: string | null;
  createdAt: number;
}

/** 开轮装配的结果：skill 目录、MCP 服务、给 `/skill:` 点名查路径用的技能表。 */
export interface PluginAssembly {
  /** 传给 pi 的 additionalSkillPaths：每条技能一个目录，按（插件名, slug）排序，顺序稳定 */
  skillDirs: string[];
  skills: { slug: string; name: string; file: string; plugin: string }[];
  /** 已变量替换、键是 `plugin_<插件>_<服务>` 的 MCP 配置（还没过工作区白名单与 `${workspaceFolder}`） */
  mcpServers: Record<string, McpServer>;
}

export class PluginStore {
  private readonly configDir: string;
  private readonly secrets: SecretsPort;
  private readonly userSkills: () => Promise<SkillIdentity[]>;
  private readonly builtinRoot: string | null;
  private readonly git: GitRunner;
  private readonly now: () => number;
  private readonly file: string;
  private readonly pluginsDir: string;
  private readonly dataRoot: string;
  private readonly archiveDir: string;
  private readonly stagingDir: string;
  private readonly staged = new Map<string, StagedPreview>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: PluginStoreDeps) {
    this.configDir = deps.configDir;
    this.secrets = deps.secrets;
    this.userSkills = deps.userSkills;
    this.builtinRoot = deps.builtinRoot ?? null;
    this.git = deps.git ?? runGit;
    this.now = deps.now ?? Date.now;
    this.file = join(deps.configDir, "plugins.json");
    this.pluginsDir = join(deps.configDir, "plugins");
    this.dataRoot = join(deps.configDir, "plugin-data");
    this.archiveDir = join(deps.configDir, "plugins-archive");
    this.stagingDir = join(deps.configDir, "plugins-staging");
  }

  /** 启动时清掉上次没收尾的暂存目录（崩溃或关窗时对话框没来得及 discard）。 */
  async init(): Promise<void> {
    await rm(this.stagingDir, { recursive: true, force: true });
  }

  rootOf(record: PluginRecord): string {
    if (record.source.kind === "link") return record.source.path;
    if (record.source.kind === "builtin") return join(this.builtinRoot ?? "", record.name);
    return join(this.pluginsDir, record.name);
  }

  dataDirOf(name: string): string {
    return join(this.dataRoot, name);
  }

  /** 串行化：改记录的操作一个接一个，失败不拖死后续。 */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 全部安装记录：磁盘上的 + 内置插件（磁盘上没有它的记录就合成默认的：对所有工作区启用）。 */
  async records(): Promise<PluginRecord[]> {
    return this.withBuiltins(await readPluginRecords(this.file));
  }

  /**
   * 内置插件并进记录表。内容目录不在了（这一版应用不再带它 / 开发环境没资源）的内置记录丢掉，
   * 不留一条读不出内容的僵尸；没有记录的补默认——所以新版本新增的内置插件，老用户升级后自动出现。
   */
  private async withBuiltins(stored: PluginRecord[]): Promise<PluginRecord[]> {
    const rest = stored.filter((record) => record.source.kind !== "builtin");
    const out: PluginRecord[] = [...rest];
    const root = this.builtinRoot;
    if (root === null) return out.sort(byName);
    for (const name of BUILTIN_PLUGIN_NAMES) {
      if (!(await isDirectory(join(root, name)))) continue;
      const own = stored.find((record) => record.name === name && record.source.kind === "builtin");
      // 同名的非内置记录（旧版本里用户自己装过同名插件）占着名字：不再合成，免得两条同名
      if (own === undefined && rest.some((record) => record.name === name)) continue;
      out.push(own ?? defaultBuiltinRecord(name));
    }
    return out.sort(byName);
  }

  private async writeRecords(records: readonly PluginRecord[]): Promise<void> {
    await writeJsonAtomic(this.file, serializePluginRecords(records));
  }

  // ---------- 预览与安装 ----------

  async preview(request: PluginPreviewRequest): Promise<PluginPreviewResult> {
    await this.pruneStaged();
    const { source } = request;
    if (source.kind === "git") {
      const url = checkGitUrl(source.url);
      if (url === null) return { ok: false, error: { kind: "git-url-rejected", url: source.url } };
      const id = randomUUID();
      const dir = join(this.stagingDir, id);
      await mkdir(this.stagingDir, { recursive: true });
      const cloned = await stageGit(url, dir, this.git);
      if (!cloned.ok) return { ok: false, error: cloned.error };
      return this.finishPreview({
        scanDir: dir,
        fallbackName: repoNameOf(url),
        source: { kind: "git", url },
        mode: "git",
        previewId: id,
        stage: { dir, source: { kind: "git", url }, mode: "git", commit: cloned.commit, createdAt: this.now() },
      });
    }
    if (!isAbsolute(source.path)) return { ok: false, error: { kind: "read-failed", message: `${source.path}: an absolute path is required` } };
    const path = resolve(source.path);
    if (request.mode === "link") {
      const exists = await stat(path).then((info) => info.isDirectory(), () => false);
      if (!exists) return { ok: false, error: { kind: "read-failed", message: `${path}: not a folder or not found` } };
      return this.finishPreview({ scanDir: path, fallbackName: basename(path), source: { kind: "folder", path }, mode: "link", previewId: null });
    }
    const id = randomUUID();
    const dir = join(this.stagingDir, id);
    await mkdir(this.stagingDir, { recursive: true });
    const copied = await stageCopy(path, dir);
    if (!copied.ok) return { ok: false, error: copied.error };
    return this.finishPreview({
      scanDir: dir,
      fallbackName: basename(path),
      source: { kind: "folder", path },
      mode: "copy",
      previewId: id,
      stage: { dir, source: { kind: "folder", path }, mode: "copy", commit: null, createdAt: this.now() },
    });
  }

  private async finishPreview(input: {
    scanDir: string;
    fallbackName: string;
    source: PluginSource;
    mode: "copy" | "link" | "git";
    previewId: string | null;
    stage?: StagedPreview;
  }): Promise<PluginPreviewResult> {
    const dropStage = async (): Promise<void> => {
      if (input.stage !== undefined) await rm(input.stage.dir, { recursive: true, force: true });
    };
    let scanned: ScannedPlugin;
    try {
      scanned = await scanPlugin(input.scanDir, input.fallbackName);
    } catch (error) {
      await dropStage();
      return { ok: false, error: { kind: "read-failed", message: error instanceof Error ? error.message : String(error) } };
    }
    if (!scanned.foundAnything) {
      await dropStage();
      return { ok: false, error: { kind: "not-a-plugin" } };
    }
    if (!scanned.nameValid) {
      await dropStage();
      return { ok: false, error: { kind: "invalid-name", name: scanned.name } };
    }
    const root = input.mode === "link" ? input.scanDir : join(this.pluginsDir, scanned.name);
    const context: VarContext = { root, dataDir: this.dataDirOf(scanned.name), fields: scanned.config, values: {}, mask: true };
    const mcp = await Promise.all(scanned.mcpServers.map((entry) => this.mcpInfoOf(scanned.name, entry, context)));
    const conflicts = findConflicts({
      name: scanned.name,
      skills: scanned.skills,
      serverNames: scanned.mcpServers.map((entry) => entry.name),
      userSkills: await this.userSkills(),
      others: await this.installedPlugins(),
      checkExists: true,
    });
    if (input.stage !== undefined && input.previewId !== null) this.staged.set(input.previewId, input.stage);
    const preview: PluginPreview = {
      previewId: input.previewId,
      name: scanned.name,
      displayName: scanned.displayName,
      version: scanned.version,
      description: scanned.description,
      author: scanned.author,
      license: scanned.license,
      source: input.source,
      mode: input.mode,
      manifestFile: scanned.manifestFile,
      root,
      hasScripts: scanned.hasScripts,
      skills: scanned.skills.map(({ slug, name, description }) => ({ slug, name, description })),
      workflow: scanned.workflow,
      io: scanned.io,
      external: scanned.external,
      board: scanned.board,
      tuned: scanned.tuned,
      mcp,
      unsupported: scanned.unsupported,
      config: scanned.config,
      conflicts,
      problems: scanned.problems,
    };
    return { ok: true, preview };
  }

  /** 放弃一次预览：清暂存。不认识的 id 静默（对话框关两次不该报错）。 */
  async discard(previewId: string): Promise<void> {
    const staged = this.staged.get(previewId);
    this.staged.delete(previewId);
    if (staged !== undefined) await rm(staged.dir, { recursive: true, force: true });
  }

  private async pruneStaged(): Promise<void> {
    const cutoff = this.now() - STAGED_TTL_MS;
    for (const [id, staged] of [...this.staged]) {
      if (staged.createdAt < cutoff) await this.discard(id);
    }
  }

  install(request: PluginInstallRequest): Promise<PluginInstallResult> {
    return this.serial(async () => {
      const { source, mode } = request.preview;
      const linking = source.kind === "folder" && mode === "link";
      let scanDir: string;
      let staged: StagedPreview | undefined;
      let fallbackName: string;
      let recordSource: PluginSourceRecord;
      if (linking) {
        scanDir = resolve(source.path);
        fallbackName = basename(scanDir);
        recordSource = { kind: "link", path: scanDir };
      } else {
        staged = request.previewId === null ? undefined : this.staged.get(request.previewId);
        // 暂存要和请求对得上（同一来源）：拿别的预览的句柄来装等于装了用户没确认过的东西
        if (staged === undefined || !sameSource(staged.source, source)) return { ok: false, error: { kind: "stale-preview" } };
        scanDir = staged.dir;
        fallbackName = source.kind === "git" ? repoNameOf(source.url) : basename(source.path);
        recordSource =
          staged.mode === "git" && staged.commit !== null && source.kind === "git"
            ? { kind: "git", url: source.url, commit: staged.commit }
            : { kind: "copy", from: source.kind === "folder" ? source.path : "" };
      }
      let scanned: ScannedPlugin;
      try {
        scanned = await scanPlugin(scanDir, fallbackName);
      } catch (error) {
        return { ok: false, error: { kind: "read-failed", message: error instanceof Error ? error.message : String(error) } };
      }
      if (!scanned.foundAnything) return { ok: false, error: { kind: "not-a-plugin" } };
      if (!scanned.nameValid) return { ok: false, error: { kind: "invalid-name", name: scanned.name } };

      // 权威的冲突复查：预览之后用户可能又建了同名技能
      const conflicts = findConflicts({
        name: scanned.name,
        skills: scanned.skills,
        serverNames: scanned.mcpServers.map((entry) => entry.name),
        userSkills: await this.userSkills(),
        others: await this.installedPlugins(),
        checkExists: true,
      });
      if (conflicts.length > 0) return { ok: false, error: { kind: "conflict", conflicts } };

      const scope = normalizeScope(request.scope);
      const records = await this.records();
      if (staged !== undefined) {
        await mkdir(this.pluginsDir, { recursive: true });
        const target = join(this.pluginsDir, scanned.name);
        // 目录在、记录不在 = 上次卸载只挪了一半留下的孤儿：归档它，不覆盖不删
        if (await exists(target)) await this.archiveDirectory(target, `${scanned.name}-orphan`);
        await rename(staged.dir, target);
        this.staged.delete(request.previewId ?? "");
      }
      const now = this.now();
      const record: PluginRecord = {
        name: scanned.name,
        source: recordSource,
        version: scanned.version,
        installedAt: now,
        updatedAt: now,
        scope,
        placement: scope.kind === "off" ? { kind: "global" } : scope,
        config: {},
        secretKeys: [],
      };
      await this.writeRecords([...records, record]);
      await mkdir(this.dataDirOf(scanned.name), { recursive: true });
      return { ok: true, id: pluginViewId("plugin", scanned.name) };
    });
  }

  // ---------- 卸载（归档不是删除） ----------

  uninstall(name: string): Promise<void> {
    return this.serial(async () => {
      const records = await this.records();
      const record = records.find((each) => each.name === name);
      if (record === undefined) throw new Error(`No such plugin: ${name}`);
      if (record.source.kind === "builtin") throw new Error(`${name} is built into Orbita and cannot be uninstalled; turn it off instead`);
      // 先把记录拿掉（装配只认记录，之后即使挪目录失败也不会再叠进会话），再挪副本
      await this.writeRecords(records.filter((each) => each.name !== name));
      const stamp = timestamp(this.now());
      const folder = `${name}-${stamp}`;
      await mkdir(this.archiveDir, { recursive: true });
      await writeJsonAtomic(join(this.archiveDir, `${folder}.json`), { archivedAt: this.now(), record });
      // 链接安装：只归档记录。绝不碰用户的源文件夹
      if (record.source.kind !== "link") await this.archiveDirectory(this.rootOf(record), folder);
      // 密钥不随归档带走：归档目录是明文文件，而系统密钥库里的值留着没有回头路可用
      for (const key of record.secretKeys) await this.secrets.delete(secretAccount(name, key)).catch(() => undefined);
    });
  }

  /**
   * 卸载归档的只读清单：扫 plugins-archive 下的 `*.json`，新的在前。坏文件跳过并留日志，
   * 目录不存在 = 没有归档。**只读**：恢复插件另有说法，不在这里。
   */
  async listArchived(): Promise<PluginArchiveEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.archiveDir);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const entries: PluginArchiveEntry[] = [];
    for (const fileName of names) {
      if (!fileName.endsWith(".json")) continue;
      const id = fileName.slice(0, -".json".length);
      try {
        const entry = parseArchiveEntry(id, JSON.parse(await readFile(join(this.archiveDir, fileName), "utf8")));
        if (entry !== null) entries.push(entry);
        else console.error(`[plugin] 归档记录「${fileName}」读不了，已跳过`);
      } catch (error) {
        console.error(`[plugin] 归档记录「${fileName}」读不了，已跳过`, error);
      }
    }
    return entries.sort((a, b) => b.archivedAt - a.archivedAt || a.id.localeCompare(b.id));
  }

  private async archiveDirectory(from: string, folder: string): Promise<void> {
    await mkdir(this.archiveDir, { recursive: true });
    let to = join(this.archiveDir, folder);
    if (await exists(to)) to = `${to}-${randomUUID().slice(0, 4)}`;
    try {
      await rename(from, to);
    } catch (error) {
      // 同卷 rename 不会跨设备；万一（用户把 userData 做了符号链接）退回复制再删
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(from, to, { recursive: true, verbatimSymlinks: true });
      await rm(from, { recursive: true, force: true });
    }
  }

  // ---------- 范围与配置 ----------

  setScope(name: string, scope: PluginScope): Promise<void> {
    return this.serial(async () => {
      const next = normalizeScope(scope);
      await this.mutate(name, (record) => ({
        ...record,
        scope: next,
        // 停用不改位置记忆；启用 / 换范围就是新的位置
        placement: next.kind === "off" ? record.placement : next,
        updatedAt: this.now(),
      }));
    });
  }

  /**
   * 工作区被移除：从所有插件的范围与位置里摘掉它（同 SkillStore.removeWorkspace 的连带清理）。
   * 「只在这些工作区」摘空了就转成停用——不能留一个名单为空却显示「启用」的插件；
   * 位置名单摘空回到「所有工作区」（停用的行总要有个落脚的组）。
   */
  removeWorkspace(id: string): Promise<void> {
    return this.serial(async () => {
      const records = await this.records();
      const touched = records.filter(
        (record) =>
          (record.scope.kind === "workspaces" && record.scope.ids.includes(id)) ||
          (record.placement.kind === "workspaces" && record.placement.ids.includes(id)),
      );
      if (touched.length === 0) return;
      const without = (ids: readonly string[]): string[] => ids.filter((each) => each !== id);
      await this.writeRecords(
        records.map((record) => {
          if (!touched.includes(record)) return record;
          const placement: PluginPlacement =
            record.placement.kind === "workspaces"
              ? without(record.placement.ids).length > 0
                ? { kind: "workspaces", ids: without(record.placement.ids) }
                : { kind: "global" }
              : record.placement;
          const scope: PluginScope =
            record.scope.kind === "workspaces"
              ? without(record.scope.ids).length > 0
                ? { kind: "workspaces", ids: without(record.scope.ids) }
                : { kind: "off" }
              : record.scope;
          return { ...record, scope, placement, updatedAt: this.now() };
        }),
      );
    });
  }

  /**
   * 改一个配置项（value=null 清除）。校验按清单声明的类型来：数字要有限且在 min / max 内，
   * 固定选项只认选项里的，布尔只认布尔。敏感值进系统密钥库，记录里只留键名。
   */
  setConfig(name: string, key: string, value: PluginConfigValue | null): Promise<void> {
    return this.serial(async () => {
      const record = (await this.records()).find((each) => each.name === name);
      if (record === undefined) throw new Error(`No such plugin: ${name}`);
      const scanned = await scanPlugin(this.rootOf(record), record.name);
      const field = scanned.config.find((each) => each.key === key);
      if (field === undefined) throw new Error(`Unknown config key: ${key}`);
      const checked = value === null ? null : validateConfigValue(field, value);
      if (field.sensitive) {
        if (checked === null) await this.secrets.delete(secretAccount(name, key));
        else await this.secrets.set(secretAccount(name, key), String(checked));
        await this.mutate(name, (current) => ({
          ...current,
          secretKeys: checked === null ? current.secretKeys.filter((each) => each !== key) : [...new Set([...current.secretKeys, key])],
          updatedAt: this.now(),
        }));
        return;
      }
      await this.mutate(name, (current) => {
        const config = { ...current.config };
        if (checked === null) delete config[key];
        else config[key] = checked;
        return { ...current, config, updatedAt: this.now() };
      });
    });
  }

  private async mutate(name: string, change: (record: PluginRecord) => PluginRecord): Promise<void> {
    const records = await this.records();
    if (!records.some((each) => each.name === name)) throw new Error(`No such plugin: ${name}`);
    await this.writeRecords(records.map((each) => (each.name === name ? change(each) : each)));
  }

  // ---------- 视图 ----------

  async listViews(): Promise<PluginView[]> {
    const records = await this.records();
    const userSkills = await this.userSkills();
    const inspected = await Promise.all(records.map((record) => this.inspect(record)));
    const others: OtherPlugin[] = inspected.map((each) => otherOf(each.record, each.scanned));
    return Promise.all(inspected.map((each) => this.viewOf(each.record, each.scanned, each.problem, userSkills, others)));
  }

  private async inspect(record: PluginRecord): Promise<{ record: PluginRecord; scanned: ScannedPlugin | null; problem: PluginProblem | null }> {
    const root = this.rootOf(record);
    try {
      return { record, scanned: await scanPlugin(root, record.name), problem: null };
    } catch (error) {
      if (isNotFound(error)) return { record, scanned: null, problem: { kind: "root-missing", detail: root } };
      return { record, scanned: null, problem: { kind: "manifest-unreadable", detail: `${root}: ${error instanceof Error ? error.message : String(error)}` } };
    }
  }

  private async viewOf(
    record: PluginRecord,
    scanned: ScannedPlugin | null,
    rootProblem: PluginProblem | null,
    userSkills: readonly SkillIdentity[],
    others: readonly OtherPlugin[],
  ): Promise<PluginView> {
    const root = this.rootOf(record);
    const fields = scanned?.config ?? [];
    const values = await this.valuesOf(record);
    const context: VarContext = { root, dataDir: this.dataDirOf(record.name), fields, values, mask: true };
    const mcp = scanned === null ? [] : await Promise.all(scanned.mcpServers.map((entry) => this.mcpInfoOf(record.name, entry, context)));
    const config: PluginConfigState[] = fields.map((field) => {
      const isSecret = field.sensitive;
      const stored = isSecret ? undefined : record.config[field.key];
      return {
        field,
        value: stored ?? null,
        isSet: isSecret ? record.secretKeys.includes(field.key) : stored !== undefined,
      };
    });
    const skills = scanned?.skills.map(({ slug, name, description }) => ({ slug, name, description })) ?? [];
    return {
      id: pluginViewId("plugin", record.name),
      origin: "plugin",
      name: scanned?.displayName ?? record.name,
      description: scanned?.description ?? "",
      author: scanned?.author ?? null,
      version: scanned?.version ?? record.version,
      license: scanned?.license ?? null,
      scope: record.scope,
      placement: record.placement,
      contents: { skills: skills.length, mcp: mcp.length, scripts: scanned?.hasScripts ?? false },
      skills,
      workflow: scanned?.workflow ?? [],
      io: scanned?.io ?? EMPTY_PLUGIN_IO,
      external: scanned?.external ?? [],
      board: scanned?.board ?? null,
      tuned: scanned?.tuned ?? false,
      mcp,
      unsupported: scanned?.unsupported ?? [],
      config,
      conflicts: findConflicts({
        name: record.name,
        skills,
        serverNames: scanned?.mcpServers.map((entry) => entry.name) ?? [],
        userSkills,
        others,
        checkExists: false,
      }),
      problems: [...(rootProblem === null ? [] : [rootProblem]), ...(scanned?.problems ?? [])],
      install: {
        source: record.source,
        root,
        dataDir: this.dataDirOf(record.name),
        installedAt: record.installedAt,
        updatedAt: record.updatedAt,
      },
      location: root,
    };
  }

  private async mcpInfoOf(plugin: string, entry: ScannedPlugin["mcpServers"][number], context: VarContext): Promise<PluginMcpInfo> {
    const qualified = qualifiedPluginServerName(plugin, entry.name);
    if (entry.server === null) {
      return { name: entry.name, qualified, transport: "stdio", commandLine: "", problem: { kind: "invalid", reason: entry.invalid ?? "unsupported-shape" } };
    }
    const { server, problem } = substituteServer(entry.server, context);
    return {
      name: entry.name,
      qualified,
      transport: isHttpServer(server) ? "http" : "stdio",
      commandLine: formatCommandLine(server),
      problem: problem ?? (await missingCommand(server)),
    };
  }

  /** 非敏感值 + 密钥库里的敏感值（取不到的键当没填）。 */
  private async valuesOf(record: PluginRecord): Promise<Record<string, PluginConfigValue>> {
    const values: Record<string, PluginConfigValue> = { ...record.config };
    for (const key of record.secretKeys) {
      const secret = await this.secrets.get(secretAccount(record.name, key)).catch(() => null);
      if (secret !== null) values[key] = secret;
    }
    return values;
  }

  /** 已装的全部插件（含与新来者同名的：plugin-exists 要靠它认出来，技能 / MCP 比对时 findConflicts 自己排除同名）。 */
  private async installedPlugins(): Promise<OtherPlugin[]> {
    const records = await this.records();
    const inspected = await Promise.all(records.map((record) => this.inspect(record)));
    return inspected.map((each) => otherOf(each.record, each.scanned));
  }

  /**
   * 一条插件技能的 SKILL.md 原文（详情页「工作流」里点技能只读查看）。入参从 renderer 来，不可信：
   * 只认已装插件扫出来的技能，并再确认文件的真实路径还在插件根之内（SKILL.md 本身是指到根外的
   * 符号链接就拒）；超过 256 KB 不读（技能正文没有那么大，大的多半不是它）。
   */
  async skillFile(name: string, slug: string): Promise<PluginSkillFile> {
    const record = (await this.records()).find((each) => each.name === name);
    if (record === undefined) throw new Error(`No such plugin: ${name}`);
    const root = this.rootOf(record);
    const skill = (await scanPlugin(root, record.name)).skills.find((each) => each.slug === slug);
    if (skill === undefined) throw new Error(`No such skill in ${name}: ${slug}`);
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(skill.file)]);
    const inside = relative(realRoot, realFile);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${slug}: SKILL.md is outside the plugin folder`);
    if ((await stat(realFile)).size > SKILL_FILE_MAX_BYTES) throw new Error(`${slug}: SKILL.md is too large to show`);
    return { slug, path: skill.file, content: await readFile(realFile, "utf8") };
  }

  // ---------- 开轮装配 ----------

  /**
   * 这一条会话该叠进去的插件内容（`workspace` 为 null = Home 会话）。读盘现扫：改了源文件夹、
   * 清单，下一轮就生效；扫不动的插件跳过并留日志，不拦开轮（同「一台坏的 MCP 不该把会话堵死」）。
   *
   * 技能：与用户技能、更早的插件技能撞名的那条不叠（pi 先到先得，它会悄悄丢后者；这里先丢，
   * 并且详情页能看到冲突——用户技能永远排在插件前面，所以赢的是用户的）。
   * MCP：有阻断问题（未知变量、必填配置没填）的那台不叠；其余替换变量、补上
   * `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` 环境变量（规格里 stdio 子进程会收到它们）。
   */
  async assemble(workspace: McpWorkspace | null): Promise<PluginAssembly> {
    const records = (await this.records()).filter((record) => scopeApplies(record.scope, workspace?.id ?? null));
    const userSkills = await this.userSkills();
    const taken: SkillIdentity[] = [...userSkills];
    const skillDirs: string[] = [];
    const skills: PluginAssembly["skills"] = [];
    const mcpServers: Record<string, McpServer> = {};
    for (const record of records) {
      const root = this.rootOf(record);
      let scanned: ScannedPlugin;
      try {
        scanned = await scanPlugin(root, record.name);
      } catch (error) {
        console.error(`[plugin] ${record.name} 读不了，这一轮不叠它`, error);
        continue;
      }
      for (const skill of scanned.skills) {
        if (taken.some((each) => skillsCollide(skill, each))) continue;
        taken.push(skill);
        skillDirs.push(skill.dir);
        skills.push({ slug: skill.slug, name: skill.name, file: skill.file, plugin: record.name });
      }
      if (scanned.mcpServers.length === 0) continue;
      const dataDir = this.dataDirOf(record.name);
      const context: VarContext = { root, dataDir, fields: scanned.config, values: await this.valuesOf(record), mask: false };
      let wantsData = false;
      for (const entry of scanned.mcpServers) {
        if (entry.server === null) continue;
        const { server, problem } = substituteServer(entry.server, context);
        if (isBlockingMcpProblem(problem)) continue;
        wantsData = true;
        mcpServers[qualifiedPluginServerName(record.name, entry.name)] = withPluginEnv(server, root, dataDir);
      }
      // 数据目录按需建：插件的脚本期望它存在（规格：首次引用时创建）
      if (wantsData) await mkdir(dataDir, { recursive: true }).catch(() => undefined);
    }
    return { skillDirs, skills, mcpServers };
  }

  /** 右栏选取与聊天徽标认的插件技能（SkillMeta 形状；`isSkillAvailable` 原样可用）。 */
  async skillMetas(): Promise<SkillMeta[]> {
    const records = await this.records();
    const userSkills = await this.userSkills();
    const out: SkillMeta[] = [];
    for (const record of records) {
      let scanned: ScannedPlugin;
      try {
        scanned = await scanPlugin(this.rootOf(record), record.name);
      } catch {
        continue;
      }
      for (const skill of scanned.skills) {
        if (userSkills.some((each) => skillsCollide(skill, each))) continue;
        out.push({
          slug: skill.slug,
          name: skill.name,
          description: skill.description,
          global: record.scope.kind === "global",
          workspaces: record.scope.kind === "workspaces" ? [...record.scope.ids].sort() : [],
          missing: false,
          linkedPath: null,
        });
      }
    }
    return out;
  }
}

// ---------- 小工具 ----------

function byName(a: PluginRecord, b: PluginRecord): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** 内置插件没有磁盘记录时的默认：对所有工作区启用。installedAt 取 0——界面对内置插件不显示安装日期。 */
function defaultBuiltinRecord(name: string): PluginRecord {
  return {
    name,
    source: { kind: "builtin" },
    version: null,
    installedAt: 0,
    updatedAt: 0,
    scope: { kind: "global" },
    placement: { kind: "global" },
    config: {},
    secretKeys: [],
  };
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory(), () => false);
}

function otherOf(record: PluginRecord, scanned: ScannedPlugin | null): OtherPlugin {
  return {
    name: record.name,
    skills: scanned?.skills ?? [],
    qualifiedServers: scanned?.mcpServers.map((entry) => qualifiedPluginServerName(record.name, entry.name)) ?? [],
  };
}

function secretAccount(plugin: string, key: string): string {
  return `plugin:${plugin}:${key}`;
}

function sameSource(a: PluginSource, b: PluginSource): boolean {
  return a.kind === "git" ? b.kind === "git" && a.url === b.url : b.kind === "folder" && resolve(a.path) === resolve(b.path);
}

/** 范围入参的规整：去重、丢空 id；形状不对当停用（宁可不生效也不要意外全开）。 */
function normalizeScope(scope: PluginScope): PluginScope {
  return parseScope(scope) ?? { kind: "off" };
}

/** `20261105-133559`（本地时间）：归档目录名，同名插件多次卸载不撞。 */
function timestamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** 绝对路径的命令在本机找不到：提醒（ZCode 官方插件的命令写死了 /Applications/ZCode.app）。 */
async function missingCommand(server: McpServer): Promise<PluginMcpProblem | null> {
  if (isHttpServer(server)) return null;
  if (!isAbsolute(server.command) || server.command.includes("${")) return null;
  return (await exists(server.command)) ? null : { kind: "command-missing", command: server.command };
}

/** stdio 子进程收到 `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`（规格）；清单自己写了同名变量的不覆盖。 */
function withPluginEnv(server: McpServer, root: string, dataDir: string): McpServer {
  if (isHttpServer(server)) return server;
  return { ...server, env: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir, ...server.env } };
}

function validateConfigValue(field: PluginConfigField, value: PluginConfigValue): PluginConfigValue {
  switch (field.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field.key} must be a number`);
      if (field.min !== null && value < field.min) throw new Error(`${field.key} must be ≥ ${field.min}`);
      if (field.max !== null && value > field.max) throw new Error(`${field.key} must be ≤ ${field.max}`);
      return value;
    }
    case "boolean": {
      if (typeof value !== "boolean") throw new Error(`${field.key} must be a boolean`);
      return value;
    }
    default: {
      const options = field.options;
      if (field.multiple) {
        if (!Array.isArray(value)) throw new Error(`${field.key} must be a list`);
        if (options !== null && value.some((item) => !options.includes(item))) throw new Error(`${field.key} has a value outside its options`);
        return value;
      }
      if (typeof value !== "string") throw new Error(`${field.key} must be a string`);
      if (options !== null && !options.includes(value)) throw new Error(`${field.key} must be one of: ${options.join(", ")}`);
      return value;
    }
  }
}
