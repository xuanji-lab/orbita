/**
 * 登录状态导入：Chrome 等 Chromium 系浏览器 → 受管浏览器 partition（macOS only）。
 *
 * 范围裁决（2026-10 刀次）：只做 macOS、只做与 Chrome 存储格式相同的五种浏览器；
 * 只导入用户勾选的网站——浏览器是 agent 的工具，把 Chrome 的 cookie 全量导进来
 * 等于把邮箱、银行登录都交给 agent。所以读取之后 renderer 只拿「网站 + 条数」，
 * cookie 值与钥匙串密钥都只留在主进程内存里（不进日志、不过 IPC），挂在一个
 * pending id 下，导入、取消或 10 分钟后丢弃。
 *
 * 钥匙串授权是整体语义：用户对弹框说「不」（拒绝 / 取消 / 没人理超时），整个读取
 * 终止、一条也不写——拒绝不是某一条 cookie 的失败。
 *
 * 结构：解密、时间换算、映射、网站分组、profile 发现的解析都是无 IO 的导出函数
 * （chrome-import.test.ts 直测）；钥匙串、快照、写入集中在 LoginImporter，依赖
 * 注入——本模块不 import electron，`node --test` 才能直接加载它。
 */
import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BrowserImportCommitResult,
  BrowserImportedSite,
  BrowserImportReadResult,
  BrowserImportSite,
  BrowserImportSource,
  BrowserImportSummary,
} from "../../shared/browser.ts";
import { readImportLedger, recordImports, writeImportLedger, type ImportLedgerEntry } from "./import-ledger.ts";

// ── 浏览器表 ────────────────────────────────────────────────────────

export interface ImportableBrowser {
  id: BrowserImportSource["browserId"];
  /** 给人看的名字（IPC 传给 renderer 展示） */
  name: string;
  /** 相对 ~/Library/Application Support 的用户数据目录；Arc 例外，多一层 User Data */
  userDataDir: string;
  /** macOS 钥匙串里的服务名（"<浏览器> Safe Storage"；Arc 的已在真机钥匙串核实） */
  keychainService: string;
}

/** 只做与 Chrome 存储格式相同的五种 Chromium 系浏览器，顺序即下拉顺序 */
export const IMPORTABLE_BROWSERS: readonly ImportableBrowser[] = [
  { id: "chrome", name: "Google Chrome", userDataDir: "Google/Chrome", keychainService: "Chrome Safe Storage" },
  { id: "edge", name: "Microsoft Edge", userDataDir: "Microsoft Edge", keychainService: "Microsoft Edge Safe Storage" },
  { id: "brave", name: "Brave", userDataDir: "BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage" },
  { id: "arc", name: "Arc", userDataDir: "Arc/User Data", keychainService: "Arc Safe Storage" },
  { id: "chromium", name: "Chromium", userDataDir: "Chromium", keychainService: "Chromium Safe Storage" },
];

/** renderer 传来的 profileId 进路径前先过这一关：首字符字母/数字，其余只许空格点下划线连字符 */
export function isSafeProfileId(profileId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(profileId) && profileId !== "." && profileId !== "..";
}

// ── 纯函数：Local State 解析 / 网站分组 / 时间与映射 ─────────────────

export interface LocalStateProfiles {
  /** profile 目录名 → 显示名（info_cache 的 name 字段） */
  names: ReadonlyMap<string, string>;
  /** profile.last_used；没有为 null */
  lastUsed: string | null;
}

const EMPTY_LOCAL_STATE: LocalStateProfiles = { names: new Map(), lastUsed: null };

/** Local State（JSON 文本）里我们关心的两件事：profile 清单与显示名、last_used。
 * 坏 JSON / 缺键都回空——发现流程会退回扫目录，不值得把整个浏览器判没 */
export function parseLocalState(content: string): LocalStateProfiles {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return EMPTY_LOCAL_STATE;
  }
  if (parsed === null || typeof parsed !== "object") return EMPTY_LOCAL_STATE;
  const profile = (parsed as { profile?: unknown }).profile;
  if (profile === null || typeof profile !== "object") return EMPTY_LOCAL_STATE;
  const infoCache = (profile as { info_cache?: unknown }).info_cache;
  const names = new Map<string, string>();
  if (infoCache !== null && typeof infoCache === "object") {
    for (const [id, entry] of Object.entries(infoCache as Record<string, unknown>)) {
      if (entry !== null && typeof entry === "object") {
        const name = (entry as { name?: unknown }).name;
        if (typeof name === "string" && name !== "") names.set(id, name);
      }
    }
  }
  const lastUsed = (profile as { last_used?: unknown }).last_used;
  return { names, lastUsed: typeof lastUsed === "string" ? lastUsed : null };
}

/** profile 排序：Default 第一，Profile N 按号升序，其余按名字——下拉顺序稳定不随 JSON 键序漂 */
export function compareProfileIds(a: string, b: string): number {
  const key = (id: string): [number, number, string] => {
    if (id === "Default") return [0, 0, id];
    const match = /^Profile (\d+)$/.exec(id);
    return match !== null ? [1, Number(match[1]), id] : [2, 0, id];
  };
  const [ax, an, aName] = key(a);
  const [bx, bn, bName] = key(b);
  return ax - bx || an - bn || (aName < bName ? -1 : aName > bName ? 1 : 0);
}

/** 默认选中：last_used 在列表里就用它；没有就 Default；再没有就第一个 */
export function pickRecommendedProfile(profileIds: readonly string[], lastUsed: string | null): string | null {
  if (profileIds.length === 0) return null;
  if (lastUsed !== null && profileIds.includes(lastUsed)) return lastUsed;
  if (profileIds.includes("Default")) return "Default";
  return profileIds[0] ?? null;
}

/** 近似 eTLD+1（网站分组的键）：去前导点取最后两段；倒数第二段是 co/com/edu/gov/ac/org/net
 *  之一、且顶级域恰好两个字母时取最后三段（nus.edu.sg、bbc.co.uk）。单段 / IPv4 原样返回。 */
const SECOND_LEVEL_SUFFIXES = new Set(["co", "com", "edu", "gov", "ac", "org", "net"]);

export function siteGroupKey(hostKey: string): string {
  const host = hostKey.replace(/^\./, "");
  if (/^\d+(\.\d+){0,3}$/.test(host)) return host; // IPv4，段位数不是域层级
  const labels = host.split(".");
  if (labels.length < 2) return host;
  const second = labels[labels.length - 2] ?? "";
  const top = labels[labels.length - 1] ?? "";
  if (labels.length >= 3 && SECOND_LEVEL_SUFFIXES.has(second) && /^[A-Za-z]{2}$/.test(top)) {
    return labels.slice(-3).join(".");
  }
  return labels.slice(-2).join(".");
}

/** cookies 表一行。node:sqlite `setReadBigInts(true)` 后整数列都是 bigint */
export interface ChromeCookieRow {
  host_key: string;
  name: string;
  path: string;
  /** 自 1601-01-01 起的微秒；0 = 会话 cookie */
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  /** -1 未指定 / 0 no_restriction / 1 lax / 2 strict */
  samesite: bigint;
  value: string;
  encrypted_value: Uint8Array;
}

/** 钥匙串密钥 → AES 密钥：PBKDF2-SHA1(secret, "saltysalt", 1003, 16)。macOS 固定参数 */
export function deriveSafeStorageKey(secret: string): Buffer {
  return pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
}

export type CookieDecryptOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: "unsupported" | "corrupt" };

/**
 * v10 解密：AES-128-CBC，IV 16×0x20，自动去 PKCS7 填充。schema ≥ 24 时明文前
 * 32 字节是 SHA-256(host_key)——先校验再剥：不等说明这行跟这个库不配套，按失败计
 * （直接剥会把 digest 当 cookie 值的前缀导进去，「看起来成功」的乱码）。
 */
export function decryptChromeCookie(
  encrypted: Uint8Array,
  key: Buffer,
  hostKey: string,
  schemaVersion: number,
): CookieDecryptOutcome {
  if (encrypted.length < 3 || Buffer.from(encrypted.subarray(0, 3)).toString("ascii") !== "v10") {
    return { ok: false, reason: "unsupported" };
  }
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([decipher.update(Buffer.from(encrypted.subarray(3))), decipher.final()]);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (schemaVersion >= 24) {
    if (plaintext.length < 32) return { ok: false, reason: "corrupt" };
    const digest = createHash("sha256").update(hostKey).digest();
    if (!digest.equals(plaintext.subarray(0, 32))) return { ok: false, reason: "corrupt" };
    plaintext = plaintext.subarray(32);
  }
  return { ok: true, value: plaintext.toString("utf8") };
}

/** Chrome epoch（1601-01-01 起的微秒）→ unix 秒 */
const CHROME_EPOCH_OFFSET_US = 11_644_473_600_000_000n;
/** 会话 cookie 导入时补的保质期：Chrome 自己的 cookie 上限（Electron 的会话 cookie 随进程退出就没了） */
const SESSION_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

export type CookieExpiry = { kind: "session" } | { kind: "date"; at: number } | { kind: "expired" };

export function chromeExpiry(expiresUtc: bigint, nowSeconds: number): CookieExpiry {
  if (expiresUtc === 0n) return { kind: "session" };
  const unixSeconds = Number((expiresUtc - CHROME_EPOCH_OFFSET_US) / 1_000_000n);
  return unixSeconds <= nowSeconds ? { kind: "expired" } : { kind: "date", at: unixSeconds };
}

/** 写入目标的 cookie 形状——与 Electron 的 CookiesSetDetails 结构兼容。本模块不 import
 *  electron（node --test 要能直接加载），ipc.ts 里把它交给 session.cookies.set */
export interface ImportCookieDetails {
  url: string;
  name: string;
  value: string;
  /** 缺席 = host-only；'.example.com' 这类域 cookie 才传 */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
  expirationDate: number;
}

/** sameSite 列的取值 → Electron 枚举。-1 未指定 / 0 no_restriction / 1 lax / 2 strict */
function toSameSite(value: bigint): ImportCookieDetails["sameSite"] {
  if (value === 0n) return "no_restriction";
  if (value === 1n) return "lax";
  if (value === 2n) return "strict";
  return "unspecified";
}

/** 一行 → 待写 cookie。url 是 `http(s)://<去点 host><path>`，secure 决定协议。
 *  host_key 带前导点的是域 cookie（传 domain）；`__Host-` 前缀按规范必须 host-only，不传。
 *  已过期回 null（调用方计入跳过）。 */
export function toImportCookie(row: ChromeCookieRow, value: string, nowSeconds: number): ImportCookieDetails | null {
  const expiry = chromeExpiry(row.expires_utc, nowSeconds);
  if (expiry.kind === "expired") return null;
  const secure = row.is_secure === 1n;
  const host = row.host_key.replace(/^\./, "");
  const path = row.path || "/";
  const wantsDomain = row.host_key.startsWith(".") && !row.name.startsWith("__Host-");
  return {
    url: `${secure ? "https" : "http"}://${host}${path}`,
    name: row.name,
    value,
    ...(wantsDomain ? { domain: row.host_key } : {}),
    path,
    secure,
    httpOnly: row.is_httponly === 1n,
    sameSite: toSameSite(row.samesite),
    expirationDate: expiry.kind === "session" ? nowSeconds + SESSION_COOKIE_MAX_AGE_SECONDS : expiry.at,
  };
}

// ── 纯函数：钥匙串失败分类 ──────────────────────────────────────────

/** 读取钥匙串要给用户留出看框、输密码的时间，不能照常规超时掐死 */
export const KEYCHAIN_TIMEOUT_MS = 60_000;
/**
 * macOS `security` 把 OSStatus 压成 8 位进程退出码：errSecInteractionNotAllowed(-25308)→36、
 * errSecAuthFailed(-25293)→51、errSecUserCanceled(-128)→128。三个加上超时被杀，都表示
 * 「用户没有完成授权」——是整个导入的终止信号，不是单条失败。
 */
const KEYCHAIN_DENIED_EXIT_CODES = new Set([36, 51, 128]);

export function isKeychainDenied(failure: { code?: number | string; killed?: boolean }): boolean {
  if (failure.killed === true) return true;
  return typeof failure.code === "number" && KEYCHAIN_DENIED_EXIT_CODES.has(failure.code);
}

// ── IO：钥匙串 / 快照 / 发现 / 导入服务 ─────────────────────────────

function execFileText(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: timeoutMs }, (error, stdout) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

/** 读一次钥匙串密钥（错误分类在调用方：拒绝是读取流程的整体终止信号）。密钥只在内存里用于解密，不进日志、不过 IPC */
export async function readSafeStorageSecret(service: string): Promise<string> {
  return execFileText("security", ["find-generic-password", "-w", "-s", service], KEYCHAIN_TIMEOUT_MS);
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** cookie 库位置：Chrome 96 起 <profile>/Network/Cookies，旧版 <profile>/Cookies */
export function cookieDatabaseCandidates(profileDir: string): string[] {
  return [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")];
}

async function openSnapshot(snapshotPath: string): Promise<{ rows: ChromeCookieRow[]; schemaVersion: number }> {
  const database = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const versionRow = database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
      | { value?: string }
      | undefined;
    const statement = database.prepare(
      "SELECT host_key, name, path, expires_utc, is_secure, is_httponly, samesite, value, encrypted_value FROM cookies",
    );
    statement.setReadBigInts(true);
    return {
      rows: statement.all() as unknown as ChromeCookieRow[],
      schemaVersion: Number(versionRow?.value ?? 0),
    };
  } finally {
    database.close();
  }
}

/**
 * 读一个 cookie 库：先连同 -wal / -journal 一起复制进临时目录（库可能正被浏览器占着），
 * 只读打开、读完、删临时目录。第一遍复制可能撞上浏览器的 checkpoint 撕裂，失败整体重试一次。
 */
export async function readCookieRows(databasePath: string): Promise<{ rows: ChromeCookieRow[]; schemaVersion: number }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tempDir = await mkdtemp(join(tmpdir(), "orbita-login-import-"));
    try {
      const snapshotPath = join(tempDir, "Cookies");
      await copyFile(databasePath, snapshotPath);
      for (const suffix of ["-wal", "-journal"]) {
        if (await pathExists(`${databasePath}${suffix}`)) {
          await copyFile(`${databasePath}${suffix}`, `${snapshotPath}${suffix}`);
        }
      }
      return await openSnapshot(snapshotPath);
    } catch (error) {
      lastError = error;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  throw lastError;
}

/** 发现可导入来源：表里的浏览器 × 有 cookie 库的 profile。profile 名读 Local State，
 *  Local State 不在 / 坏了就退回扫 Default / Profile N 目录。没 profile 的浏览器不出现。 */
export async function discoverImportSources(
  appSupportDir: string = join(homedir(), "Library", "Application Support"),
): Promise<BrowserImportSource[]> {
  const sources: BrowserImportSource[] = [];
  for (const browser of IMPORTABLE_BROWSERS) {
    const userDataDir = join(appSupportDir, browser.userDataDir);
    if (!(await pathExists(userDataDir))) continue;
    let localState = EMPTY_LOCAL_STATE;
    try {
      localState = parseLocalState(await readFile(join(userDataDir, "Local State"), "utf8"));
    } catch {
      // Local State 不在或读不了：退回扫目录
    }
    const entries = await readdir(userDataDir, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    let candidates = [...localState.names.keys()].filter((name) => dirs.includes(name));
    if (candidates.length === 0) candidates = dirs.filter((name) => /^(Default|Profile \d+)$/.test(name));
    const withCookies: string[] = [];
    for (const profileId of candidates) {
      const databases = cookieDatabaseCandidates(join(userDataDir, profileId));
      if (await Promise.all(databases.map(pathExists)).then((found) => found.some(Boolean))) {
        withCookies.push(profileId);
      }
    }
    if (withCookies.length === 0) continue;
    withCookies.sort(compareProfileIds);
    const recommended = pickRecommendedProfile(withCookies, localState.lastUsed);
    for (const profileId of withCookies) {
      sources.push({
        browserId: browser.id,
        browserName: browser.name,
        profileId,
        profileName: localState.names.get(profileId) ?? profileId,
        recommended: profileId === recommended,
      });
    }
  }
  return sources;
}

/** 受管浏览器 cookie 库里已有的一条（Electron Cookie 里我们用得上的字段） */
export interface StoredCookie {
  name: string;
  /** host-only 是主机名，域 cookie 带前导点 */
  domain?: string;
  path?: string;
  secure?: boolean;
}

/** cookie 写入目标（受管浏览器 partition），由 ipc.ts 注入 */
export interface CookieWriteTarget {
  cookies: {
    set(details: ImportCookieDetails): Promise<void>;
    /** 只用 `get({})` 取全部——已导入清单要按网站现查「还在不在」 */
    get(filter: Record<string, never>): Promise<StoredCookie[]>;
    remove(url: string, name: string): Promise<void>;
    flushStore(): Promise<void>;
  };
}

/** 删一条已存 cookie 要给的 url：协议随 secure，主机去掉前导点，路径用它自己的（路径不匹配删不掉） */
export function storedCookieUrl(cookie: StoredCookie): string {
  const host = (cookie.domain ?? "").replace(/^\./, "");
  return `${cookie.secure === true ? "https" : "http"}://${host}${cookie.path ?? "/"}`;
}

export interface LoginImporterDeps {
  cookieTarget: () => CookieWriteTarget;
  /** 导入账本（import-ledger.ts）的落盘路径：userData/browser-imports.json */
  ledgerPath: string;
  /** 覆盖浏览器数据根目录（测试用）；默认 ~/Library/Application Support */
  appSupportDir?: string;
  /** 覆盖钥匙串读取（测试用） */
  readSecret?: (service: string) => Promise<string>;
  /**
   * 覆盖时钟（测试用）。**单位是 unix 秒**——cookie 的过期时间、Electron 的 expirationDate 都是秒；
   * 默认值曾误用 Date.now（毫秒），单测注入的是秒所以没抓到，结果是真实导入里每条带日期的
   * cookie 都被判为已过期。名字带上单位，防止再犯
   */
  nowSeconds?: () => number;
}

/** pending 的网站分组：待写 cookie 与读取时已跳过的条数（结果行的「跳过」要能对上） */
interface PendingSite {
  cookies: ImportCookieDetails[];
  skipped: number;
}

interface PendingImport {
  id: string;
  /** 来源的显示名，导入成功后记进账本 */
  source: { browserName: string; profileName: string };
  sites: Map<string, PendingSite>;
  timer: ReturnType<typeof setTimeout>;
}

/** 未选中任何有效网站时 toWrite 为空，直接跳过写入与 flush */
const WRITE_CONCURRENCY = 16;
const PENDING_TTL_MS = 10 * 60_000;

/**
 * 登录状态导入的服务对象（ipc.ts 持有，一个应用一个）。cookie 值只在本实例的
 * pending 里，10 分钟无操作自动丢弃；新一次读取替换旧 pending。
 */
export class LoginImporter {
  private readonly deps: LoginImporterDeps;
  private pending: PendingImport | null = null;
  /** 账本的读-改-写串行化：导入与移除交错时后写的不能覆盖先写的 */
  private ledgerQueue: Promise<unknown> = Promise.resolve();

  constructor(deps: LoginImporterDeps) {
    this.deps = deps;
  }

  /** 非 macOS 不发现（UI 不显示这一组；IPC 也不开口子） */
  sources(): Promise<BrowserImportSource[]> {
    if (process.platform !== "darwin") return Promise.resolve([]);
    return discoverImportSources(this.deps.appSupportDir);
  }

  async read(browserId: string, profileId: string): Promise<BrowserImportReadResult> {
    if (process.platform !== "darwin") return { ok: false, error: "not-supported" };
    const browser = IMPORTABLE_BROWSERS.find((candidate) => candidate.id === browserId);
    if (browser === undefined || !isSafeProfileId(profileId)) return { ok: false, error: "profile-not-found" };
    const profileDir = join(this.appSupportDir(), browser.userDataDir, profileId);
    if (!(await pathExists(profileDir))) return { ok: false, error: "profile-not-found" };
    let databasePath: string | null = null;
    for (const candidate of cookieDatabaseCandidates(profileDir)) {
      if (await pathExists(candidate)) {
        databasePath = candidate;
        break;
      }
    }
    if (databasePath === null) return { ok: false, error: "no-cookie-db" };

    let snapshot: { rows: ChromeCookieRow[]; schemaVersion: number };
    try {
      snapshot = await readCookieRows(databasePath);
    } catch (error) {
      console.warn("[browser-import] cookie 库读取失败", browserId, profileId, error instanceof Error ? error.message : error);
      return { ok: false, error: "read-failed" };
    }

    // 只有库里真有加密行才去碰钥匙串——空库 / 纯明文库不该无谓地弹授权框
    let key: Buffer | null = null;
    if (snapshot.rows.some((row) => row.value === "" && row.encrypted_value.length > 0)) {
      try {
        key = deriveSafeStorageKey(await this.readSecret(browser.keychainService));
      } catch (error) {
        // 拒绝 / 取消 / 超时：整个读取终止，一条也不导
        if (isKeychainDenied(error as { code?: number | string; killed?: boolean })) {
          return { ok: false, error: "keychain-denied" };
        }
        console.warn("[browser-import] 钥匙串密钥读取失败", browserId, error instanceof Error ? error.message : error);
        return { ok: false, error: "read-failed" };
      }
    }

    const now = this.nowSeconds();
    const sites = new Map<string, PendingSite>();
    for (const row of snapshot.rows) {
      let value = row.value;
      if (value === "") {
        if (key === null || row.encrypted_value.length === 0) continue; // 没有密钥也解不了，按跳过
        const decrypted = decryptChromeCookie(row.encrypted_value, key, row.host_key, snapshot.schemaVersion);
        if (!decrypted.ok) continue;
        value = decrypted.value;
      }
      const site = siteGroupKey(row.host_key);
      const cookie = toImportCookie(row, value, now);
      if (cookie === null) {
        // 已过期：只在网站已有别的可导 cookie 时计入它的跳过数，否则这个网站整个不出现
        const existing = sites.get(site);
        if (existing !== undefined) existing.skipped += 1;
        continue;
      }
      const group = sites.get(site) ?? { cookies: [], skipped: 0 };
      group.cookies.push(cookie);
      sites.set(site, group);
    }

    const source = { browserName: browser.name, profileName: await this.profileName(browser, profileId) };
    const pendingId = randomUUID();
    this.replacePending({ id: pendingId, source, sites, timer: this.armTtl(pendingId) });
    const list: BrowserImportSite[] = [...sites.entries()]
      .map(([site, group]) => ({ site, count: group.cookies.length }))
      .sort((a, b) => (a.site < b.site ? -1 : a.site > b.site ? 1 : 0));
    return { ok: true, pendingId, sites: list };
  }

  async commit(pendingId: string, selectedSites: string[]): Promise<BrowserImportCommitResult> {
    const pending = this.pending;
    if (pending === null || pending.id !== pendingId) return { ok: false, error: "no-pending" };

    const now = this.nowSeconds();
    const toWrite: { site: string; cookie: ImportCookieDetails }[] = [];
    let siteCount = 0;
    let skipped = 0;
    for (const site of selectedSites) {
      const group = pending.sites.get(site);
      if (group === undefined) continue; // 不认识的网站名直接忽略（前端只该传读取时拿到的）
      siteCount += 1;
      skipped += group.skipped;
      for (const cookie of group.cookies) {
        // 读取与导入之间可能隔了几分钟：恰好到期的按跳过
        if (cookie.expirationDate <= now) skipped += 1;
        else toWrite.push({ site, cookie });
      }
    }

    let imported = 0;
    /** 至少写进一条的网站才记账——一条都没写进去的，说「已导入」就是假话 */
    const landed = new Set<string>();
    if (toWrite.length > 0) {
      const target = this.deps.cookieTarget();
      for (let offset = 0; offset < toWrite.length; offset += WRITE_CONCURRENCY) {
        const batch = toWrite.slice(offset, offset + WRITE_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map((item) => target.cookies.set(item.cookie)));
        settled.forEach((outcome, index) => {
          if (outcome.status === "fulfilled") {
            imported += 1;
            const item = batch[index];
            if (item !== undefined) landed.add(item.site);
          } else skipped += 1;
        });
      }
      await target.cookies.flushStore();
    }
    this.discardPending(pending.id);
    if (landed.size > 0) {
      const importedAt = now * 1000;
      // 记账失败不改写导入结果：cookie 已经写进去了，报「导入失败」是假话；丢的只是清单里的一行
      await this.updateLedger((entries) => recordImports(entries, [...landed], pending.source, importedAt)).catch(
        (error: unknown) => console.warn("[browser-import] 导入账本写入失败", error instanceof Error ? error.message : error),
      );
    }
    const summary: BrowserImportSummary = { imported, sites: siteCount, skipped };
    return { ok: true, summary };
  }

  /** 取消导入：丢弃 pending。pendingId 不认识 = 已经过期/取消过，幂等 */
  cancel(pendingId: string): void {
    this.discardPending(pendingId);
  }

  /**
   * 已导入清单：账本里的网站 + 受管浏览器此刻还有没有它的 cookie（按 siteGroupKey 同一套
   * 分组现查）。cookie 全过期、被网站清掉，账本还在，present 为 false——设置页据此提示重新导入。
   */
  async imported(): Promise<BrowserImportedSite[]> {
    if (process.platform !== "darwin") return [];
    const entries = await this.ledgerSnapshot();
    if (entries.length === 0) return [];
    const stored = await this.deps.cookieTarget().cookies.get({});
    const sitesWithCookies = new Set(stored.map((cookie) => siteGroupKey(cookie.domain ?? "")));
    return entries.map((entry) => ({ ...entry, present: sitesWithCookies.has(entry.site) }));
  }

  /**
   * 移除一个已导入的网站：删掉受管浏览器里这个网站的**全部** cookie（分不出导入的与浏览时
   * 种的——要的效果就是「内置浏览器退出这个网站」），再从账本销掉。回新清单。
   */
  async removeImported(site: string): Promise<BrowserImportedSite[]> {
    const target = this.deps.cookieTarget();
    const stored = await target.cookies.get({});
    const doomed = stored.filter((cookie) => siteGroupKey(cookie.domain ?? "") === site);
    await Promise.all(doomed.map((cookie) => target.cookies.remove(storedCookieUrl(cookie), cookie.name)));
    if (doomed.length > 0) await target.cookies.flushStore();
    await this.updateLedger((entries) => entries.filter((entry) => entry.site !== site));
    return this.imported();
  }

  /** 清除全部浏览器数据之后：cookie 已经全没了，账本跟着清空 */
  async forgetImported(): Promise<void> {
    await this.updateLedger(() => []);
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private appSupportDir(): string {
    return this.deps.appSupportDir ?? join(homedir(), "Library", "Application Support");
  }

  /** profile 的显示名（Local State 的 info_cache）；读不出回落目录名，同下拉里的规则 */
  private async profileName(browser: ImportableBrowser, profileId: string): Promise<string> {
    try {
      const localState = parseLocalState(await readFile(join(this.appSupportDir(), browser.userDataDir, "Local State"), "utf8"));
      return localState.names.get(profileId) ?? profileId;
    } catch {
      return profileId;
    }
  }

  /** 读账本也排进队列：正在写的那一笔落盘之后再读，清单不会少刚导入的网站 */
  private ledgerSnapshot(): Promise<ImportLedgerEntry[]> {
    const next = this.ledgerQueue.then(() => readImportLedger(this.deps.ledgerPath));
    this.ledgerQueue = next.catch(() => undefined);
    return next;
  }

  private updateLedger(change: (entries: ImportLedgerEntry[]) => ImportLedgerEntry[]): Promise<void> {
    const next = this.ledgerQueue.then(async () => {
      const entries = await readImportLedger(this.deps.ledgerPath);
      await writeImportLedger(this.deps.ledgerPath, change(entries));
    });
    this.ledgerQueue = next.catch(() => undefined);
    return next;
  }

  private readSecret(service: string): Promise<string> {
    return (this.deps.readSecret ?? readSafeStorageSecret)(service);
  }

  private nowSeconds(): number {
    return this.deps.nowSeconds !== undefined ? this.deps.nowSeconds() : Math.floor(Date.now() / 1000);
  }

  /** 10 分钟没人来导入就丢弃——cookie 不能在内存里过夜。unref：计时器不拦着进程退出 */
  private armTtl(pendingId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => this.discardPending(pendingId), PENDING_TTL_MS);
    timer.unref();
    return timer;
  }

  private replacePending(next: PendingImport): void {
    this.clearPending();
    this.pending = next;
  }

  private discardPending(pendingId: string): void {
    if (this.pending?.id !== pendingId) return;
    this.clearPending();
  }

  private clearPending(): void {
    if (this.pending === null) return;
    clearTimeout(this.pending.timer);
    this.pending = null;
  }
}
