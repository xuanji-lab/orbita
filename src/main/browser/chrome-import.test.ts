/**
 * 登录状态导入（chrome-import.ts）的纯函数与流程测试。
 * 解密用已知密钥在测试里现造密文（v10 = AES-128-CBC + PBKDF2("saltysalt")，公开算法）；
 * cookie 库用 node:sqlite 造小库；LoginImporter 的钥匙串与写入目标全部注入替身。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { statSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LoginImporter,
  chromeExpiry,
  compareProfileIds,
  cookieDatabaseCandidates,
  decryptChromeCookie,
  deriveSafeStorageKey,
  discoverImportSources,
  isKeychainDenied,
  isSafeProfileId,
  parseLocalState,
  pickRecommendedProfile,
  readCookieRows,
  siteGroupKey,
  toImportCookie,
  type ChromeCookieRow,
  type ImportCookieDetails,
} from "./chrome-import.ts";

const SECRET = "test-secret";
const KEY = deriveSafeStorageKey(SECRET);

/** 造一条 v10 密文：明文前面可带 schema ≥ 24 的 SHA-256(host) digest */
function encryptV10(plaintext: string, hostKey: string, schemaVersion: number): Buffer {
  const body =
    schemaVersion >= 24
      ? Buffer.concat([createHash("sha256").update(hostKey).digest(), Buffer.from(plaintext, "utf8")])
      : Buffer.from(plaintext, "utf8");
  const cipher = createCipheriv("aes-128-cbc", KEY, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10", "ascii"), cipher.update(body), cipher.final()]);
}

function row(overrides: Partial<ChromeCookieRow> = {}): ChromeCookieRow {
  return {
    host_key: "example.com",
    name: "session",
    path: "/",
    expires_utc: 0n,
    is_secure: 0n,
    is_httponly: 0n,
    samesite: -1n,
    value: "",
    encrypted_value: new Uint8Array(),
    ...overrides,
  };
}

// ── 解密 ─────────────────────────────────────────────────────────────

test("decryptChromeCookie：v10 + schema 24 剥掉 host digest，解回原文", () => {
  const encrypted = encryptV10("token-value", "github.com", 24);
  assert.deepEqual(decryptChromeCookie(encrypted, KEY, "github.com", 24), { ok: true, value: "token-value" });
});

test("decryptChromeCookie：schema < 24 没有 digest，原文直接解出", () => {
  const encrypted = encryptV10("plain", "github.com", 23);
  assert.deepEqual(decryptChromeCookie(encrypted, KEY, "github.com", 23), { ok: true, value: "plain" });
});

test("decryptChromeCookie：digest 对不上（行与库不配套）算失败，不能剥出乱码", () => {
  const encrypted = encryptV10("token-value", "github.com", 24);
  assert.deepEqual(decryptChromeCookie(encrypted, KEY, "evil.com", 24), { ok: false, reason: "corrupt" });
});

test("decryptChromeCookie：非 v10 前缀与空密文算跳过", () => {
  assert.deepEqual(decryptChromeCookie(Buffer.from("v20xxxx"), KEY, "a.com", 24), { ok: false, reason: "unsupported" });
  assert.deepEqual(decryptChromeCookie(new Uint8Array(), KEY, "a.com", 24), { ok: false, reason: "unsupported" });
});

test("deriveSafeStorageKey：PBKDF2-SHA1(saltysalt, 1003) 与自算一致", () => {
  assert.deepEqual(KEY, pbkdf2Sync(SECRET, "saltysalt", 1003, 16, "sha1"));
});

// ── 时间换算 ────────────────────────────────────────────────────────

const CHROME_EPOCH_US = 11_644_473_600_000_000n;

/** unix 秒 → Chrome epoch 微秒 */
function chromeUs(unixSeconds: number): bigint {
  return BigInt(unixSeconds) * 1_000_000n + CHROME_EPOCH_US;
}

test("chromeExpiry：0 = 会话；过去 = 过期；未来换 unix 秒", () => {
  const now = 1_700_000_000;
  assert.deepEqual(chromeExpiry(0n, now), { kind: "session" });
  assert.deepEqual(chromeExpiry(chromeUs(now - 1), now), { kind: "expired" });
  assert.deepEqual(chromeExpiry(chromeUs(now + 60), now), { kind: "date", at: now + 60 });
});

// ── cookie 映射 ─────────────────────────────────────────────────────

const NOW = 1_700_000_000;
const SESSION_MAX_AGE = 400 * 24 * 60 * 60;

test("toImportCookie：host-only 不传 domain，url 协议随 is_secure", () => {
  const cookie = toImportCookie(row({ host_key: "example.com", is_secure: 1n, path: "/app" }), "v", NOW);
  assert.ok(cookie !== null);
  assert.equal(cookie.url, "https://example.com/app");
  assert.equal(cookie.domain, undefined);
  assert.equal(cookie.path, "/app");
  assert.equal(cookie.secure, true);
});

test("toImportCookie：前导点 = 域 cookie 传 domain；__Host- 不传", () => {
  const domainCookie = toImportCookie(row({ host_key: ".example.com" }), "v", NOW);
  assert.ok(domainCookie !== null);
  assert.equal(domainCookie.domain, ".example.com");
  assert.equal(domainCookie.url, "http://example.com/");

  const hostOnly = toImportCookie(row({ host_key: ".example.com", name: "__Host-id" }), "v", NOW);
  assert.ok(hostOnly !== null);
  assert.equal(hostOnly.domain, undefined);
});

test("toImportCookie：sameSite -1/0/1/2 → unspecified/no_restriction/lax/strict", () => {
  const map = (value: bigint) => {
    const cookie = toImportCookie(row({ samesite: value }), "v", NOW);
    return cookie !== null ? cookie.sameSite : null;
  };
  assert.deepEqual([map(-1n), map(0n), map(1n), map(2n)], ["unspecified", "no_restriction", "lax", "strict"]);
});

test("toImportCookie：会话 cookie 补 now+400 天；已过期回 null", () => {
  const session = toImportCookie(row({ expires_utc: 0n }), "v", NOW);
  assert.ok(session !== null);
  assert.equal(session.expirationDate, NOW + SESSION_MAX_AGE);

  const expired = toImportCookie(row({ expires_utc: chromeUs(NOW - 1) }), "v", NOW);
  assert.equal(expired, null);
});

// ── 网站分组 ────────────────────────────────────────────────────────

test("siteGroupKey：普通两段 / 前导点 / 三段后缀规则 / 单段 / IPv4", () => {
  assert.equal(siteGroupKey("www.example.com"), "example.com");
  assert.equal(siteGroupKey(".github.com"), "github.com");
  assert.equal(siteGroupKey("login.nus.edu.sg"), "nus.edu.sg");
  assert.equal(siteGroupKey("www.bbc.co.uk"), "bbc.co.uk");
  assert.equal(siteGroupKey("a.b.com"), "b.com"); // com 在倒数第二但总共只有两段，不套三段规则
  assert.equal(siteGroupKey("a.b.c.example.com"), "example.com"); // 倒数第二不是后缀词，回落两段
  assert.equal(siteGroupKey("localhost"), "localhost");
  assert.equal(siteGroupKey("192.168.1.4"), "192.168.1.4");
});

// ── Local State 解析 / profile 选择 ─────────────────────────────────

test("parseLocalState：info_cache 名字与 last_used；坏 JSON / 缺键回空", () => {
  const state = parseLocalState(
    JSON.stringify({
      profile: {
        info_cache: { Default: { name: "Person 1" }, "Profile 1": { name: "Work" } },
        last_used: "Profile 1",
      },
    }),
  );
  assert.equal(state.names.get("Default"), "Person 1");
  assert.equal(state.lastUsed, "Profile 1");
  assert.deepEqual(parseLocalState("{oops"), { names: new Map(), lastUsed: null });
  assert.deepEqual(parseLocalState("{}"), { names: new Map(), lastUsed: null });
});

test("compareProfileIds：Default 第一、Profile N 按号、其余按名", () => {
  const ids = ["Profile 10", "Beta", "Profile 2", "Default", "Profile 1"];
  assert.deepEqual([...ids].sort(compareProfileIds), ["Default", "Profile 1", "Profile 2", "Profile 10", "Beta"]);
});

test("pickRecommendedProfile：last_used 优先，其次 Default，再否则第一个", () => {
  assert.equal(pickRecommendedProfile(["Default", "Profile 1"], "Profile 1"), "Profile 1");
  assert.equal(pickRecommendedProfile(["Default", "Profile 1"], null), "Default");
  assert.equal(pickRecommendedProfile(["Profile 2", "Profile 1"], "Profile 9"), "Profile 2");
  assert.equal(pickRecommendedProfile([], "x"), null);
});

test("isSafeProfileId：拒绝路径逃逸，接受正常目录名", () => {
  assert.equal(isSafeProfileId("Default"), true);
  assert.equal(isSafeProfileId("Profile 1"), true);
  assert.equal(isSafeProfileId("../Chrome"), false);
  assert.equal(isSafeProfileId(".."), false);
  assert.equal(isSafeProfileId("a/b"), false);
});

test("cookieDatabaseCandidates：Chrome 96 的 Network/Cookies 优先于旧版位置", () => {
  assert.deepEqual(cookieDatabaseCandidates("/p"), ["/p/Network/Cookies", "/p/Cookies"]);
});

// ── 钥匙串失败分类 ──────────────────────────────────────────────────

test("isKeychainDenied：36 / 51 / 128 / 超时被杀是拒绝；其他退出码不是", () => {
  assert.equal(isKeychainDenied({ code: 36 }), true);
  assert.equal(isKeychainDenied({ code: 51 }), true);
  assert.equal(isKeychainDenied({ code: 128 }), true);
  assert.equal(isKeychainDenied({ killed: true }), true);
  assert.equal(isKeychainDenied({ code: 44 }), false); // 钥匙串里没有这条目
  assert.equal(isKeychainDenied({ code: "ENOENT" }), false);
});

// ── cookie 库快照读取（node:sqlite 造小库） ─────────────────────────

interface MiniCookie {
  host: string;
  name: string;
  /** unix 秒；0 = 会话 cookie */
  expiresUnix: number;
  value: string;
  encrypted: Buffer | null;
}

async function writeCookieDatabase(dir: string, cookies: MiniCookie[], schemaVersion: number): Promise<string> {
  const path = join(dir, "Cookies");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE cookies (host_key TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', value TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '/', expires_utc INTEGER NOT NULL DEFAULT 0, is_secure INTEGER NOT NULL DEFAULT 0, is_httponly INTEGER NOT NULL DEFAULT 0, samesite INTEGER NOT NULL DEFAULT -1, encrypted_value BLOB DEFAULT NULL)" +
      "; CREATE TABLE meta (key LONGTEXT PRIMARY KEY, value LONGTEXT)",
  );
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(schemaVersion));
  const insert = db.prepare(
    "INSERT INTO cookies (host_key, name, value, expires_utc, encrypted_value) VALUES (?, ?, ?, ?, ?)",
  );
  for (const cookie of cookies) {
    insert.run(cookie.host, cookie.name, cookie.value, cookie.expiresUnix === 0 ? 0n : chromeUs(cookie.expiresUnix), cookie.encrypted ?? null);
  }
  db.close();
  return path;
}

test("readCookieRows：快照读出行与 schema 版本，不动源库", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  try {
    const source = await writeCookieDatabase(
      dir,
      [{ host: "a.com", name: "k", expiresUnix: 0, value: "plain", encrypted: null }],
      24,
    );
    const before = statSync(source).mtimeMs;
    const { rows, schemaVersion } = await readCookieRows(source);
    const first = rows[0];
    assert.ok(first !== undefined);
    assert.equal(schemaVersion, 24);
    assert.equal(rows.length, 1);
    assert.equal(first.host_key, "a.com");
    assert.equal(first.value, "plain");
    assert.equal(typeof first.expires_utc, "bigint");
    assert.equal(statSync(source).mtimeMs, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── 来源发现 ────────────────────────────────────────────────────────

test("discoverImportSources：列出有 cookie 库的 profile，读 info_cache 名字，last_used 默认选中", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  try {
    const chrome = join(root, "Google", "Chrome");
    await mkdir(join(chrome, "Default", "Network"), { recursive: true });
    await mkdir(join(chrome, "Profile 1"), { recursive: true });
    await mkdir(join(chrome, "Profile 2"), { recursive: true }); // 没 cookie 库，不出现
    await mkdir(join(root, "Microsoft Edge"), { recursive: true }); // 没任何 profile，整个浏览器不出现
    await writeFile(
      join(chrome, "Local State"),
      JSON.stringify({
        profile: {
          info_cache: { Default: { name: "Person 1" }, "Profile 1": { name: "Work" }, "Profile 2": { name: "Empty" } },
          last_used: "Profile 1",
        },
      }),
    );
    await writeFile(join(chrome, "Default", "Network", "Cookies"), "x");
    await writeFile(join(chrome, "Profile 1", "Cookies"), "x");

    const sources = await discoverImportSources(root);
    assert.deepEqual(
      sources.map((source) => [source.browserId, source.profileId, source.profileName, source.recommended]),
      [
        ["chrome", "Default", "Person 1", false],
        ["chrome", "Profile 1", "Work", true],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("discoverImportSources：Local State 坏了退回扫 Default / Profile N，名字回落目录名", async () => {
  const root = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  try {
    const arc = join(root, "Arc", "User Data");
    await mkdir(join(arc, "Default"), { recursive: true });
    await writeFile(join(arc, "Local State"), "{broken");
    await writeFile(join(arc, "Default", "Cookies"), "x");
    assert.deepEqual(await discoverImportSources(root), [
      { browserId: "arc", browserName: "Arc", profileId: "Default", profileName: "Default", recommended: true },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ── LoginImporter 流程（钥匙串与写入目标注入替身；仅 macOS 走这条链路） ──

/** 写入目标替身：记录 set 调用，可按 cookie 名抛错模拟失败 */
function fakeTarget(failNames: ReadonlySet<string> = new Set()) {
  const written: ImportCookieDetails[] = [];
  let flushed = 0;
  return {
    written,
    flushCount: () => flushed,
    target: {
      cookies: {
        set: async (details: ImportCookieDetails) => {
          if (failNames.has(details.name)) throw new Error("set-failed");
          written.push(details);
        },
        flushStore: async () => {
          flushed += 1;
        },
      },
    },
  };
}

const THE_FUTURE = NOW + 3600;

test("LoginImporter：读取（解密 + 分组）→ 只导勾选的网站 → 统计成功与跳过", async (t) => {
  if (process.platform !== "darwin") return t.skip("仅 macOS");
  const root = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const profileDir = join(root, "Google", "Chrome", "Default");
  await mkdir(join(profileDir, "Network"), { recursive: true });
  await writeCookieDatabase(
    profileDir,
    [
      // github.com：一条加密 + 一条明文
      { host: "github.com", name: "enc", expiresUnix: THE_FUTURE, value: "", encrypted: encryptV10("secret-1", "github.com", 24) },
      { host: "github.com", name: "plain", expiresUnix: THE_FUTURE, value: "plain-1", encrypted: null },
      // nus.edu.sg 下的两台主机归同一个网站（域 cookie + 子域）
      { host: ".nus.edu.sg", name: "sso", expiresUnix: THE_FUTURE, value: "", encrypted: encryptV10("secret-2", ".nus.edu.sg", 24) },
      { host: "lib.nus.edu.sg", name: "sess", expiresUnix: THE_FUTURE, value: "", encrypted: encryptV10("secret-3", "lib.nus.edu.sg", 24) },
      // 会话 cookie
      { host: "example.org", name: "sid", expiresUnix: 0, value: "", encrypted: encryptV10("sid-value", "example.org", 24) },
      // 已过期：跳过
      { host: "expired.com", name: "old", expiresUnix: NOW - 10, value: "v", encrypted: null },
      // digest 校验失败（host 不配套）：跳过
      { host: "corrupt.com", name: "bad", expiresUnix: THE_FUTURE, value: "", encrypted: encryptV10("x", "other.com", 24) },
    ],
    24,
  );

  const fake = fakeTarget();
  const importer = new LoginImporter({
    cookieTarget: () => fake.target,
    appSupportDir: root,
    readSecret: async () => SECRET,
    nowSeconds: () => NOW,
  });

  const read = await importer.read("chrome", "Default");
  assert.ok(read.ok);
  // 只有「过期」「解不开」的网站不出现在列表里
  assert.deepEqual(
    read.sites.map((site) => [site.site, site.count]),
    [
      ["example.org", 1],
      ["github.com", 2],
      ["nus.edu.sg", 2],
    ],
  );

  // 只导 github + nus：expired / corrupt 不在所选网站里，不计入跳过
  const commit = await importer.commit(read.pendingId, ["github.com", "nus.edu.sg"]);
  assert.ok(commit.ok);
  assert.deepEqual(commit.summary, { imported: 4, sites: 2, skipped: 0 });
  assert.deepEqual(
    fake.written.map((cookie) => [cookie.name, cookie.value]),
    [
      ["enc", "secret-1"],
      ["plain", "plain-1"],
      ["sso", "secret-2"],
      ["sess", "secret-3"],
    ],
  );
  assert.equal(fake.flushCount(), 1);

  // 导入完 pending 即弃，再导同一个 id 报 no-pending
  const again = await importer.commit(read.pendingId, ["github.com"]);
  assert.deepEqual(again, { ok: false, error: "no-pending" });
});

test("LoginImporter：所选网站里解不开 / 过期的计入跳过；写入失败计入跳过；空选择不写不 flush", async (t) => {
  if (process.platform !== "darwin") return t.skip("仅 macOS");
  const root = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const profileDir = join(root, "Google", "Chrome", "Default");
  await mkdir(join(profileDir, "Network"), { recursive: true });
  await writeCookieDatabase(
    profileDir,
    [
      { host: "github.com", name: "ok", expiresUnix: THE_FUTURE, value: "a", encrypted: null },
      { host: "github.com", name: "doomed", expiresUnix: THE_FUTURE, value: "b", encrypted: null },
      // 同一个网站里混一条过期：列表 3 条，可导 2 条
      { host: "github.com", name: "old", expiresUnix: NOW - 10, value: "c", encrypted: null },
    ],
    24,
  );

  const fake = fakeTarget(new Set(["doomed"]));
  const importer = new LoginImporter({
    cookieTarget: () => fake.target,
    appSupportDir: root,
    readSecret: async () => SECRET,
    nowSeconds: () => NOW,
  });
  const read = await importer.read("chrome", "Default");
  assert.ok(read.ok);
  assert.deepEqual(read.sites, [{ site: "github.com", count: 2 }]);
  const commit = await importer.commit(read.pendingId, ["github.com"]);
  assert.ok(commit.ok);
  assert.deepEqual(commit.summary, { imported: 1, sites: 1, skipped: 2 });

  const second = await importer.read("chrome", "Default");
  assert.ok(second.ok);
  const empty = await importer.commit(second.pendingId, []);
  assert.ok(empty.ok);
  assert.deepEqual(empty.summary, { imported: 0, sites: 0, skipped: 0 });
  assert.equal(fake.flushCount(), 1);
});

test("LoginImporter：钥匙串拒绝整体终止；其他失败归 read-failed", async (t) => {
  if (process.platform !== "darwin") return t.skip("仅 macOS");
  const root = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const profileDir = join(root, "Google", "Chrome", "Default");
  await mkdir(join(profileDir, "Network"), { recursive: true });
  await writeCookieDatabase(
    profileDir,
    [{ host: "github.com", name: "enc", expiresUnix: THE_FUTURE, value: "", encrypted: encryptV10("v", "github.com", 24) }],
    24,
  );

  const base = {
    cookieTarget: () => fakeTarget().target,
    appSupportDir: root,
    nowSeconds: () => NOW,
  };
  const denied = await new LoginImporter({ ...base, readSecret: () => Promise.reject({ code: 51 }) }).read("chrome", "Default");
  assert.deepEqual(denied, { ok: false, error: "keychain-denied" });

  const cancelled = await new LoginImporter({ ...base, readSecret: () => Promise.reject({ code: 128 }) }).read("chrome", "Default");
  assert.deepEqual(cancelled, { ok: false, error: "keychain-denied" });

  const noItem = await new LoginImporter({ ...base, readSecret: () => Promise.reject({ code: 44 }) }).read("chrome", "Default");
  assert.deepEqual(noItem, { ok: false, error: "read-failed" });
});

test("LoginImporter：来源不存在 / 没 cookie 库 / 路径逃逸的错误码；纯明文库不碰钥匙串", async (t) => {
  if (process.platform !== "darwin") return t.skip("仅 macOS");
  const root = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const profileDir = join(root, "Google", "Chrome", "Default");
  await mkdir(join(profileDir, "Network"), { recursive: true });
  await writeCookieDatabase(profileDir, [{ host: "a.com", name: "k", expiresUnix: 0, value: "plain", encrypted: null }], 24);
  await mkdir(join(root, "Google", "Chrome", "Empty"), { recursive: true }); // 目录在但没有 cookie 库

  let secretReads = 0;
  const importer = new LoginImporter({
    cookieTarget: () => fakeTarget().target,
    appSupportDir: root,
    readSecret: async () => {
      secretReads += 1;
      return SECRET;
    },
    nowSeconds: () => NOW,
  });

  assert.deepEqual(await importer.read("firefox", "Default"), { ok: false, error: "profile-not-found" });
  assert.deepEqual(await importer.read("chrome", "Nope"), { ok: false, error: "profile-not-found" });
  assert.deepEqual(await importer.read("chrome", "../Default"), { ok: false, error: "profile-not-found" });
  assert.deepEqual(await importer.read("chrome", "Empty"), { ok: false, error: "no-cookie-db" });

  // 纯明文库：不该为了它弹钥匙串框
  const read = await importer.read("chrome", "Default");
  assert.ok(read.ok);
  assert.equal(secretReads, 0);

  // 取消后 pending 失效
  await importer.cancel(read.pendingId);
  assert.deepEqual(await importer.commit(read.pendingId, ["a.com"]), { ok: false, error: "no-pending" });

  // 新一次读取替换旧 pending
  const first = await importer.read("chrome", "Default");
  const second = await importer.read("chrome", "Default");
  assert.ok(first.ok && second.ok);
  assert.notEqual(first.pendingId, second.pendingId);
  assert.deepEqual(await importer.commit(first.pendingId, ["a.com"]), { ok: false, error: "no-pending" });
});

test("LoginImporter：默认时钟按秒算——一年后才过期的 cookie 照常导入，会话 cookie 补的是 400 天后", async (t) => {
  if (process.platform !== "darwin") return t.skip("仅 macOS");
  const root = await mkdtemp(join(tmpdir(), "orbita-import-test-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const profileDir = join(root, "Google", "Chrome", "Default");
  await mkdir(join(profileDir, "Network"), { recursive: true });
  const nowSeconds = Math.floor(Date.now() / 1000);
  await writeCookieDatabase(
    profileDir,
    [
      { host: "github.com", name: "dated", expiresUnix: nowSeconds + 365 * 86400, value: "a", encrypted: null },
      { host: "github.com", name: "session", expiresUnix: 0, value: "b", encrypted: null },
    ],
    24,
  );
  const fake = fakeTarget();
  // 不注入时钟：走生产默认值
  const importer = new LoginImporter({ cookieTarget: () => fake.target, appSupportDir: root, readSecret: async () => SECRET });
  const read = await importer.read("chrome", "Default");
  assert.ok(read.ok);
  assert.deepEqual(read.sites, [{ site: "github.com", count: 2 }]);
  const commit = await importer.commit(read.pendingId, ["github.com"]);
  assert.ok(commit.ok);
  assert.deepEqual(commit.summary, { imported: 2, sites: 1, skipped: 0 });
  const session = fake.written.find((cookie) => cookie.name === "session");
  const days = ((session?.expirationDate ?? 0) - nowSeconds) / 86400;
  assert.ok(days > 399 && days < 401, `session cookie expires in ${days} days`);
});
