/**
 * scripts/officecli-source.mjs 的测试：版本表、URL 选择、镜像失败回退、sha256 校验、缓存命中。
 * 全部离线：fetch 与 fs 都是注入的桩，不打网络、不写磁盘。
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { join } from "node:path";
import {
  OFFICECLI_SUBDIR,
  OFFICECLI_TARGETS,
  OFFICECLI_VERSION,
  describeFetchFailure,
  ensureAsset,
  ensureOfficecli,
  fetchVerified,
  officecliBinDir,
  releaseUrls,
  sha256Hex,
} from "./officecli-source.mjs";

const GOOD = Buffer.from("officecli-binary-bytes");
const GOOD_SHA = sha256Hex(GOOD);
const WIN_TARGET = { asset: "officecli-win-x64.exe", file: "officecli.exe", sha256: GOOD_SHA };
const MAC_TARGET = { asset: "officecli-mac-arm64", file: "officecli", sha256: GOOD_SHA };

/** 内存里的「磁盘 + fetch」：disk 是路径 → 内容；fetched 记录每次尝试的 URL；mode 记录 chmod */
function harness({ files = {}, sources = {} } = {}) {
  const disk = new Map(Object.entries(files));
  const fetched = [];
  const modes = new Map();
  const io = {
    existsSync: (path) => disk.has(path),
    readFileSync: (path) => disk.get(path),
    writeFileSync: (path, bytes) => disk.set(path, bytes),
    mkdirSync: () => undefined,
    chmodSync: (path, mode) => modes.set(path, mode),
  };
  const fetchBytes = async (url) => {
    fetched.push(url);
    const source = sources[url];
    if (source === undefined) throw new Error("404");
    if (source instanceof Error) throw source;
    return source;
  };
  return { disk, fetched, modes, io, fetchBytes };
}

test("版本表：每个目标都有发布资产名与 64 位 sha256，且资产不重复", () => {
  assert.match(OFFICECLI_VERSION, /^\d+\.\d+\.\d+$/);
  const assets = new Set();
  for (const [key, target] of Object.entries(OFFICECLI_TARGETS)) {
    assert.match(key, /^(win32-x64|darwin-arm64)$/);
    assert.match(target.sha256, /^[0-9a-f]{64}$/, `${key} 的 sha256 必须是 64 位小写十六进制`);
    assert.equal(assets.has(target.asset), false, `${target.asset} 在两个目标里重名`);
    assets.add(target.asset);
    // 资产名带平台后缀：win 是 .exe，mac 不是
    if (key.startsWith("win32")) assert.match(target.asset, /\.exe$/);
    else assert.doesNotMatch(target.asset, /\.exe$/);
    // 本地落盘名与 rg / fd 同一套约定：就叫 officecli[.exe]（extraResources 的 filter 与
    // officecli-bin.ts 都按这个名字找），**不是**上游那个带平台后缀的资产名
    assert.equal(target.file, key.startsWith("win32") ? "officecli.exe" : "officecli");
  }
  // 我们在出的两个平台必须在表里，表外的平台由调用方报错（见下一条）
  assert.ok(Object.hasOwn(OFFICECLI_TARGETS, "win32-x64"));
  assert.ok(Object.hasOwn(OFFICECLI_TARGETS, "darwin-arm64"));
});

test("URL 选择：官方镜像在前、GitHub 在后，都是版本化不可变路径", () => {
  const [mirror, github] = releaseUrls(OFFICECLI_VERSION, WIN_TARGET.asset);
  assert.equal(mirror, `https://d.officecli.ai/releases/download/v${OFFICECLI_VERSION}/${WIN_TARGET.asset}`);
  assert.equal(github, `https://github.com/iOfficeAI/OfficeCLI/releases/download/v${OFFICECLI_VERSION}/${WIN_TARGET.asset}`);
  // /latest/download/ 会随上游发版漂移，与钉死的 sha256 打架
  for (const url of [mirror, github]) assert.doesNotMatch(url, /\/latest\//);
});

test("sha256Hex 对同一份字节稳定、对不同字节不同", () => {
  assert.equal(sha256Hex(GOOD), sha256Hex(Buffer.from(GOOD)));
  assert.notEqual(sha256Hex(GOOD), sha256Hex(Buffer.from("other")));
});

test("fetchVerified：第一个源成功就不再碰第二个", async () => {
  const [mirror, github] = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ sources: { [mirror]: GOOD, [github]: Buffer.from("unused") } });
  const bytes = await fetchVerified({ urls: [mirror, github], sha256: GOOD_SHA, fetchBytes: h.fetchBytes });
  assert.deepEqual(bytes, GOOD);
  assert.deepEqual(h.fetched, [mirror]);
});

test("fetchVerified：镜像网络失败 → 回退 GitHub", async () => {
  const [mirror, github] = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ sources: { [mirror]: new Error("ETIMEDOUT"), [github]: GOOD } });
  const bytes = await fetchVerified({ urls: [mirror, github], sha256: GOOD_SHA, fetchBytes: h.fetchBytes });
  assert.deepEqual(bytes, GOOD);
  assert.deepEqual(h.fetched, [mirror, github]);
});

test("fetchVerified：镜像送来的字节 sha256 不符 → 同样回退 GitHub", async () => {
  const [mirror, github] = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ sources: { [mirror]: Buffer.from("tampered"), [github]: GOOD } });
  const bytes = await fetchVerified({ urls: [mirror, github], sha256: GOOD_SHA, fetchBytes: h.fetchBytes });
  assert.deepEqual(bytes, GOOD);
  assert.deepEqual(h.fetched, [mirror, github]);
});

test("fetchVerified：两个源都 sha256 不符 → 抛错，并写明期望与实际哈希", async () => {
  const urls = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ sources: { [urls[0]]: Buffer.from("a"), [urls[1]]: Buffer.from("b") } });
  await assert.rejects(
    () => fetchVerified({ urls, sha256: GOOD_SHA, fetchBytes: h.fetchBytes }),
    (error) => {
      assert.match(error.message, /没有一个源可用/);
      assert.match(error.message, new RegExp(GOOD_SHA));
      assert.match(error.message, new RegExp(sha256Hex(Buffer.from("a"))));
      assert.match(error.message, new RegExp(sha256Hex(Buffer.from("b"))));
      return true;
    },
  );
  assert.deepEqual(h.fetched, urls);
});

test("fetchVerified：网络错误与哈希不符分别记在两个源名下", async () => {
  const urls = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ sources: { [urls[0]]: new Error("ECONNRESET") } }); // 第二个源不在桩表里 → 404
  await assert.rejects(
    () => fetchVerified({ urls, sha256: GOOD_SHA, fetchBytes: h.fetchBytes }),
    (error) => {
      assert.match(error.message, /ECONNRESET/);
      assert.match(error.message, /404/);
      assert.match(error.message, /releases\/download\/v1\.0\.0/);
      return true;
    },
  );
});

test("ensureAsset：下载成功 → 落盘 + 写标记 + 非 Windows 补 0755", async () => {
  const dir = "build/bin/darwin-arm64";
  const urls = releaseUrls("1.0.0", MAC_TARGET.asset);
  const h = harness({ sources: { [urls[0]]: GOOD } });
  const result = await ensureAsset({ target: MAC_TARGET, dir, version: "1.0.0", fetchBytes: h.fetchBytes, io: h.io });
  assert.equal(result.action, "downloaded");
  assert.equal(result.path, join(dir, MAC_TARGET.file));
  assert.deepEqual(h.disk.get(result.path), GOOD);
  assert.equal(h.disk.get(`${result.path}.version`), `1.0.0 ${GOOD_SHA}`);
  assert.equal(h.modes.get(result.path), 0o755, "mac 上必须可执行，否则装进包里跑不起来");
});

test("ensureAsset：Windows 资产不改权限位", async () => {
  const dir = "build/bin/win32-x64";
  const urls = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ sources: { [urls[1]]: GOOD } }); // 镜像缺席 → 走 GitHub 兜底
  const result = await ensureAsset({ target: WIN_TARGET, dir, version: "1.0.0", fetchBytes: h.fetchBytes, io: h.io });
  assert.equal(result.action, "downloaded");
  assert.deepEqual(h.modes.size, 0);
});

test("ensureAsset：缓存命中（二进制在 + 标记同版本同哈希）→ 不下载、不重写", async () => {
  const dir = "build/bin/win32-x64";
  const binary = join(dir, WIN_TARGET.file);
  const h = harness({ files: { [binary]: Buffer.from("already-there"), [`${binary}.version`]: `1.0.0 ${GOOD_SHA}` } });
  const result = await ensureAsset({ target: WIN_TARGET, dir, version: "1.0.0", fetchBytes: h.fetchBytes, io: h.io });
  assert.equal(result.action, "cached");
  assert.deepEqual(h.fetched, []);
  assert.deepEqual(h.disk.get(binary), Buffer.from("already-there"), "缓存命中不能覆盖已有文件");
  assert.deepEqual([...h.modes.entries()], []);
});

test("ensureAsset：标记是旧版本（或哈希变了）→ 重新下载并覆盖标记", async () => {
  const dir = "build/bin/darwin-arm64";
  const binary = join(dir, MAC_TARGET.file);
  const urls = releaseUrls("1.0.0", MAC_TARGET.asset);
  const h = harness({ files: { [binary]: Buffer.from("old"), [`${binary}.version`]: "0.9.0 deadbeef" }, sources: { [urls[0]]: GOOD } });
  const result = await ensureAsset({ target: MAC_TARGET, dir, version: "1.0.0", fetchBytes: h.fetchBytes, io: h.io });
  assert.equal(result.action, "downloaded");
  assert.deepEqual(h.disk.get(binary), GOOD);
  assert.equal(h.disk.get(`${binary}.version`), `1.0.0 ${GOOD_SHA}`);
});

test("ensureAsset：只有一个源在盘上、且哈希不符 → 失败且不改标记、不落文件", async () => {
  const dir = "build/bin/win32-x64";
  const binary = join(dir, WIN_TARGET.file);
  const urls = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ files: { [`${binary}.version`]: "0.9.0 deadbeef" }, sources: { [urls[0]]: Buffer.from("tampered") } });
  await assert.rejects(
    () => ensureAsset({ target: WIN_TARGET, dir, version: "1.0.0", fetchBytes: h.fetchBytes, io: h.io }),
    /sha256 不符/,
  );
  assert.deepEqual(h.fetched, urls, "两个源都要试过");
  assert.equal(h.disk.has(binary), false, "校验不过的字节不能落盘");
  assert.equal(h.disk.get(`${binary}.version`), "0.9.0 deadbeef", "失败时不能改标记");
});

test("ensureOfficecli：表外平台直接失败，不猜也不下载", async () => {
  const h = harness();
  await assert.rejects(
    () => ensureOfficecli({ targetKey: "linux-x64", dir: "build/bin/linux-x64", fetchBytes: h.fetchBytes, io: h.io }),
    /linux-x64 没有钉死的 OfficeCLI 版本/,
  );
  assert.deepEqual(h.fetched, []);
});

test("落点：officecli 在 bin 下的子目录里（不是 agent PATH 上那一层）", () => {
  // 子目录名同时写死在 src/main/agent/officecli-bin.ts 的 BIN_SUBDIR 里，两边各有测试盯着
  assert.equal(OFFICECLI_SUBDIR, "officecli");
  assert.equal(officecliBinDir(join("build", "bin", "win32-x64")), join("build", "bin", "win32-x64", "officecli"));
});

test("ensureAsset：给定 dir 就是落盘目录（子目录由 ensureOfficecli 拼）", async () => {
  const dir = join("build/bin/win32-x64", OFFICECLI_SUBDIR);
  const urls = releaseUrls("1.0.0", WIN_TARGET.asset);
  const h = harness({ sources: { [urls[0]]: GOOD } });
  const result = await ensureAsset({ target: WIN_TARGET, dir, version: "1.0.0", fetchBytes: h.fetchBytes, io: h.io });
  assert.equal(result.path, join(dir, "officecli.exe"));
  assert.deepEqual([...h.disk.keys()].sort(), [join(dir, "officecli.exe"), join(dir, "officecli.exe.version")].sort());
});

test("ensureOfficecli：表外平台的错误信息带平台键", async () => {
  const h = harness();
  await assert.rejects(() => ensureOfficecli({ targetKey: "linux-arm64", binRoot: "b", fetchBytes: h.fetchBytes, io: h.io }), /linux-arm64/);
});

describe("describeFetchFailure", () => {
  test("undici 的超时：带出 cause 里的 code 与 message", () => {
    const cause = Object.assign(new Error("Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)"), {
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const error = new Error("fetch failed", { cause });
    const text = describeFetchFailure(error);
    assert.match(text, /UND_ERR_CONNECT_TIMEOUT/);
    assert.match(text, /github\.com:443/);
  });

  test("连接被拒：code 与 message 重复时只留一次", () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" });
    const text = describeFetchFailure(new TypeError("fetch failed", { cause }));
    assert.match(text, /ECONNREFUSED/);
    assert.equal(text.split("ECONNREFUSED").length - 1, 1, "同一个词不该重复两遍");
  });

  test("我们自己抛的 HTTP 404：message 原样带出", () => {
    assert.equal(describeFetchFailure(new Error("HTTP 404")), "HTTP 404");
  });

  test("不是 Error 也说得出一句话", () => {
    assert.equal(describeFetchFailure("boom"), "boom");
  });

  test("fetchVerified 的失败行里有 code（排障能分清墙 / 超时 / DNS）", async () => {
    const urls = releaseUrls("1.0.0", WIN_TARGET.asset);
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND github.com"), { code: "ENOTFOUND" });
    const h = harness({
      sources: {
        [urls[0]]: new TypeError("fetch failed", { cause }),
        [urls[1]]: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      },
    });
    await assert.rejects(
      () => fetchVerified({ urls, sha256: GOOD_SHA, fetchBytes: h.fetchBytes }),
      (error) => {
        assert.match(error.message, /ENOTFOUND/);
        assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
        return true;
      },
    );
  });
});
