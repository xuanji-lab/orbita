/**
 * 「最近几个版本」（updater/recent-releases.ts）的测试。
 *
 * 两条线各钉各的：
 * - **解析是纯函数**：正常 / 空数组 / 条目字段缺失 / 根形状不对（不是数组）。这里钉的是
 *   「半个条目不如没有」——字段缺的整条丢掉，根形状不对当失败（和「真的没有已发布版本」
 *   是两句不同的话）。
 * - **回路**：缓存 10 分钟、失败不缓存（点重试是真再打一次）、非 200 与网络异常都落成
 *   `ok:false` 而不是抛错。
 * - **说明只来自每一版的 latest.yml**，Release 正文（给专业用户的完整文档）不进软件。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import packageJson from "../../../package.json" with { type: "json" };
import { GitHubClient, type GitHubTransport } from "./github-client.ts";
import { createRecentReleases, notesFromChannelFile, parseRecentReleases } from "./recent-releases.ts";
import { releasesApiUrl } from "./releases-url.ts";

const YML_URL = "https://github.com/xuanji-lab/orbita/releases/download/v0.1.15/latest.yml";

/** GitHub releases 端点的一个条目（只留我们要用的字段）。正文是给专业用户的完整文档，不该进软件 */
const ENTRY = {
  tag_name: "v0.1.15",
  name: "0.1.15",
  published_at: "2026-10-18T05:00:00Z",
  html_url: "https://github.com/xuanji-lab/orbita/releases/tag/v0.1.15",
  body: "# ORBITA v0.1.15 · 功能总览\n\n## 一、Agent 与对话\n- **独立进程的 agent**：…",
  assets: [
    { name: "orbita-0.1.15-win-x64-setup.exe", browser_download_url: "https://example.com/setup.exe" },
    { name: "latest.yml", browser_download_url: YML_URL },
  ],
};

/** electron-builder 写出的 latest.yml（releaseNotes 是多行块标量） */
const LATEST_YML = [
  "version: 0.1.15",
  "files:",
  "  - url: orbita-0.1.15-win-x64-setup.exe",
  "    sha512: abc",
  "    size: 100",
  "path: orbita-0.1.15-win-x64-setup.exe",
  "sha512: abc",
  "releaseNotes: |-",
  "  [icon:download] Windows 自动更新：确认后才下载。",
  "  修了几个窄窗口下的对齐问题。",
  "releaseDate: '2026-10-18T05:00:00.000Z'",
  "",
].join("\n");

/**
 * 共享客户端的 transport 替身：列表端点给 JSON，latest.yml 给原文；没登记的地址 404。
 * 网络请求由 GitHubClient 发出（缓存 / 限流都在它那里），这里只负责作答。
 */
function stubTransport(
  calls: string[],
  routes: Record<string, { status?: number; body: unknown }>,
): GitHubTransport {
  return async ({ url }) => {
    calls.push(url.href);
    const route = Object.entries(routes).find(([prefix]) => url.href.startsWith(prefix))?.[1];
    if (route === undefined) return { status: 404, headers: {}, body: "not found" };
    const body = typeof route.body === "string" ? route.body : JSON.stringify(route.body);
    return { status: route.status ?? 200, headers: {}, body };
  };
}

/** 每个用例一套客户端：缓存是共享的，不能跨用例串味 */
function clientOf(
  calls: string[],
  routes: Record<string, { status?: number; body: unknown }>,
  now?: () => number,
): GitHubClient {
  return new GitHubClient({ transport: stubTransport(calls, routes), now });
}

const API = "https://api.github.com/repos/a/b/releases";
/** 正常的一套：列表 + 这一版的 latest.yml */
const ROUTES = { [API]: { body: [ENTRY] }, [YML_URL]: { body: LATEST_YML } };

describe("parseRecentReleases —— GitHub releases 载荷 → 列表条目（说明另拉）", () => {
  test("正常：tag 去 v 成版本号，标题 / 日期 / 链接带出，说明地址指向这一版的 latest.yml", () => {
    assert.deepEqual(parseRecentReleases([ENTRY]), [
      {
        tag: "v0.1.15",
        version: "0.1.15",
        title: "0.1.15",
        publishedAt: "2026-10-18T05:00:00Z",
        htmlUrl: "https://github.com/xuanji-lab/orbita/releases/tag/v0.1.15",
        notesUrl: YML_URL,
      },
    ]);
  });

  test("有资产 id 时优先拼发布资产端点（browser_download_url 在 github.com，部分网络被拦）", () => {
    const entry = {
      ...ENTRY,
      assets: [{ id: 668402530, name: "latest.yml", browser_download_url: YML_URL }],
    };
    assert.equal(
      parseRecentReleases([entry], "https://api.github.com/repos/xuanji-lab/orbita/releases/assets")?.[0]?.notesUrl,
      "https://api.github.com/repos/xuanji-lab/orbita/releases/assets/668402530",
    );
  });

  test("没有 latest.yml 时退到 latest-mac.yml；两份都没有是 null（那一行没有说明，但仍在列表里）", () => {
    const mac = "https://example.com/latest-mac.yml";
    const onlyMac = { ...ENTRY, assets: [{ name: "latest-mac.yml", browser_download_url: mac }] };
    assert.equal(parseRecentReleases([onlyMac])?.[0]?.notesUrl, mac);
    assert.equal(parseRecentReleases([{ ...ENTRY, assets: [] }])?.[0]?.notesUrl, null);
    assert.equal(parseRecentReleases([{ ...ENTRY, assets: undefined }])?.[0]?.version, "0.1.15");
  });

  test("没有标题的 Release 回落到 tag；tag 没有 v 前缀时版本号原样", () => {
    const parsed = parseRecentReleases([{ ...ENTRY, tag_name: "0.1.15", name: "" }]);
    assert.equal(parsed?.[0]?.version, "0.1.15");
    assert.equal(parsed?.[0]?.title, "0.1.15");
  });

  test("空数组 = 真的没有已发布的版本（不是失败）", () => {
    assert.deepEqual(parseRecentReleases([]), []);
  });

  test("条目字段缺失 → 整条丢掉，其余条目照旧", () => {
    const parsed = parseRecentReleases([
      { ...ENTRY, html_url: undefined },
      { ...ENTRY, tag_name: "" },
      { ...ENTRY, published_at: 42 },
      "不是对象",
      { ...ENTRY, tag_name: "v0.1.16", html_url: "https://example.com/v0.1.16" },
    ]);
    assert.equal(parsed?.length, 1);
    assert.equal(parsed?.[0]?.version, "0.1.16");
  });

  test("根形状不对（不是数组）→ null（当失败，不当空列表）", () => {
    assert.equal(parseRecentReleases({ message: "Not Found" }), null);
    assert.equal(parseRecentReleases(null), null);
    assert.equal(parseRecentReleases("<html>"), null);
  });
});

describe("notesFromChannelFile —— latest.yml → 软件里的说明", () => {
  test("读出 releaseNotes 的多行块，按发布约定逐条拆", () => {
    assert.deepEqual(notesFromChannelFile(LATEST_YML), [
      { icon: "download", text: "Windows 自动更新：确认后才下载。" },
      { icon: null, text: "修了几个窄窗口下的对齐问题。" },
    ]);
  });
  test("没写 releaseNotes / YAML 坏了：null，不抛", () => {
    assert.equal(notesFromChannelFile("version: 0.1.15\n"), null);
    assert.equal(notesFromChannelFile("version: [坏的"), null);
  });
});

describe("createRecentReleases —— 共享客户端、缓存与失败", () => {
  test("打到 API 端点（带 per_page），再拉这一版的 latest.yml：说明来自 yml，Release 正文不进来", async () => {
    const calls: string[] = [];
    const recent = createRecentReleases({ endpoint: () => API, client: clientOf(calls, ROUTES) });
    const result = await recent.recent();
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok ? result.releases[0]?.notes : null, [
      { icon: "download", text: "Windows 自动更新：确认后才下载。" },
      { icon: null, text: "修了几个窄窗口下的对齐问题。" },
    ]);
    assert.deepEqual(calls, [`${API}?per_page=5`, YML_URL]);
    // 回执里不带内部字段（notesUrl 不出主进程）
    assert.equal(result.ok ? "notesUrl" in (result.releases[0] ?? {}) : true, false);
  });

  test("这一版没传 latest.yml（404）：那一行没有说明，列表照常，且照常缓存", async () => {
    const calls: string[] = [];
    const recent = createRecentReleases({
      endpoint: () => API,
      client: clientOf(calls, { [API]: { body: [ENTRY] } }),
    });
    const first = await recent.recent();
    assert.equal(first.ok ? first.releases[0]?.notes : "x", null);
    await recent.recent();
    assert.equal(calls.length, 2, "404 是确定的「没有」，第二次应命中缓存");
  });

  test("latest.yml 网络层失败：那一行没有说明，且只有它不缓存——下次展开再拉", async () => {
    const calls: string[] = [];
    const flaky: GitHubTransport = async ({ url }) => {
      calls.push(url.href);
      if (url.href === YML_URL) throw new Error("socket hang up");
      return { status: 200, headers: {}, body: JSON.stringify([ENTRY]) };
    };
    const recent = createRecentReleases({
      endpoint: () => API,
      client: new GitHubClient({ transport: flaky }),
    });
    const first = await recent.recent();
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.releases[0]?.notes : "x", null);
    await recent.recent();
    // 列表原文在共享客户端缓存里（10 分钟），失败的 latest.yml 不进缓存：第二次只重拉它
    assert.equal(calls.length, 3, "失败的说明不缓存，下次展开只重拉那一份");
    assert.equal(calls.filter((url) => url === YML_URL).length, 2);
  });

  test("说明请求被限流（429）：那一行没有说明，但不写缓存——限流解除后下一次展开就拿到说明", async () => {
    const calls: string[] = [];
    let limited = true;
    const entry = { ...ENTRY, assets: [{ id: 42, name: "latest.yml" }] };
    const transport: GitHubTransport = async ({ url }) => {
      calls.push(url.href);
      if (url.pathname.endsWith("/releases/assets/42")) {
        // 不带 retry-after / x-ratelimit-*：这里钉的是 recent-releases 的分类，不是客户端那本账
        return limited ? { status: 429, headers: {}, body: "rate limited" } : { status: 200, headers: {}, body: LATEST_YML };
      }
      return { status: 200, headers: {}, body: JSON.stringify([entry]) };
    };
    const recent = createRecentReleases({ endpoint: () => API, client: new GitHubClient({ transport }) });

    const first = await recent.recent();
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.releases[0]?.notes : "x", null, "限流时那一行没有说明，但列表照常");

    limited = false;
    const second = await recent.recent();
    // 修之前：429 被当成「这一版没有说明」缓存 10 分钟，第二次直接吃缓存，说明永远是 null
    const notes = second.ok ? second.releases[0]?.notes : null;
    assert.ok(notes !== null && notes !== undefined && notes.length > 0, "限流的说明不写缓存，限流解除后重新拉到了");
    assert.equal(calls.filter((href) => href.endsWith("/assets/42")).length, 2, "说明打了两次（第一次 429、第二次成功）");
  });

  test("说明请求 403（共享出口 IP 被限流的样子）：同样不缓存，下次展开再试", async () => {
    const calls: string[] = [];
    const entry = { ...ENTRY, assets: [{ id: 43, name: "latest.yml" }] };
    const transport: GitHubTransport = async ({ url }) => {
      calls.push(url.href);
      if (url.pathname.endsWith("/releases/assets/43")) {
        return { status: 403, headers: {}, body: "forbidden" };
      }
      return { status: 200, headers: {}, body: JSON.stringify([entry]) };
    };
    const recent = createRecentReleases({ endpoint: () => API, client: new GitHubClient({ transport }) });

    const first = await recent.recent();
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.releases[0]?.notes : "x", null);

    await recent.recent();
    assert.equal(calls.filter((href) => href.endsWith("/assets/43")).length, 2, "403 不算「没有说明」，第二次重新拉");
  });

  test("退路 URL（browser_download_url）在白名单外的域：不向它发请求，那一行当没有说明", async () => {
    const calls: string[] = [];
    const entry = {
      ...ENTRY,
      assets: [{ name: "latest.yml", browser_download_url: "https://evil.example/latest.yml" }],
    };
    const transport: GitHubTransport = async ({ url }) => {
      calls.push(url.href);
      return { status: 200, headers: {}, body: JSON.stringify([entry]) };
    };
    const recent = createRecentReleases({ endpoint: () => API, client: new GitHubClient({ transport }) });
    const result = await recent.recent();
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.releases[0]?.notes : "x", null);
    // 只打了列表端点：白名单外的域一个请求都不发
    assert.deepEqual(calls, [`${API}?per_page=5`]);
  });

  test("成功结果缓存 10 分钟：窗口内再点不打 API，过期后再打", async () => {
    const calls: string[] = [];
    let clock = 0;
    const recent = createRecentReleases({
      endpoint: () => API,
      client: clientOf(calls, ROUTES, () => clock),
      now: () => clock,
    });
    await recent.recent();
    await recent.recent();
    assert.equal(calls.length, 2, "10 分钟窗口内第二次应命中缓存（第一次是列表 + yml 两个请求）");
    clock = 10 * 60 * 1000;
    await recent.recent();
    assert.equal(calls.length, 4, "窗口过期后应重新请求");
  });

  test("非 200 落成 ok:false，且不缓存——重试真的再打一次", async () => {
    const calls: string[] = [];
    const recent = createRecentReleases({
      endpoint: () => API,
      client: clientOf(calls, { [API]: { status: 403, body: { message: "rate limited" } } }),
    });
    const first = await recent.recent();
    assert.equal(first.ok, false);
    assert.equal(first.ok ? "" : first.message, "HTTP 403");
    await recent.recent();
    assert.equal(calls.length, 2, "失败不该进缓存");
  });

  test("根形状不对（非数组）落成 ok:false", async () => {
    const recent = createRecentReleases({
      endpoint: () => API,
      client: new GitHubClient({
        transport: stubTransport([], { [API]: { body: { message: "Not Found" } } }),
      }),
    });
    const result = await recent.recent();
    assert.equal(result.ok, false);
  });

  test("没有配置发布源时不给兜底地址，直接说清楚", async () => {
    const recent = createRecentReleases({ endpoint: () => null, client: clientOf([], {}) });
    const result = await recent.recent();
    assert.equal(result.ok, false);
  });

  test("网络异常落成 ok:false，不抛给调用方", async () => {
    const recent = createRecentReleases({
      endpoint: () => API,
      client: new GitHubClient({
        transport: async () => {
          throw new Error("ENOTFOUND api.github.com");
        },
      }),
    });
    const result = await recent.recent();
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.message, /ENOTFOUND/);
  });
});

describe("releasesApiUrl —— 与网页入口同源", () => {
  test("owner/repo 来自 package.json 的 build.publish", () => {
    const publish = packageJson.build.publish[0];
    assert.ok(publish !== undefined);
    assert.equal(releasesApiUrl(), `https://api.github.com/repos/${publish.owner}/${publish.repo}/releases`);
  });
});
