/**
 * 「最近几个版本」（updater/recent-releases.ts）的测试。
 *
 * 两条线各钉各的：
 * - **解析是纯函数**：正常 / 空数组 / 条目字段缺失 / 根形状不对（不是数组）。这里钉的是
 *   「半个条目不如没有」——字段缺的整条丢掉，根形状不对当失败（和「真的没有已发布版本」
 *   是两句不同的话）。
 * - **回路**：缓存 10 分钟、失败不缓存（点重试是真再打一次）、非 200 与网络异常都落成
 *   `ok:false` 而不是抛错。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import packageJson from "../../../package.json" with { type: "json" };
import { createRecentReleases, parseRecentReleases } from "./recent-releases.ts";
import { releasesApiUrl } from "./releases-url.ts";

/** GitHub releases 端点的一个条目（只留我们要用的字段） */
const ENTRY = {
  tag_name: "v0.1.15",
  name: "0.1.15",
  published_at: "2026-10-18T05:00:00Z",
  html_url: "https://github.com/xuanji-lab/orbita/releases/tag/v0.1.15",
};

/** 记录请求地址、按给定载荷作答的 fetch 替身 */
function stubFetch(calls: string[], payload: unknown, status = 200): typeof fetch {
  return async (input) => {
    calls.push(String(input));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("parseRecentReleases —— GitHub releases 载荷 → 界面条目", () => {
  test("正常：tag 去 v 成版本号，标题 / 日期 / 链接原样带出", () => {
    const parsed = parseRecentReleases([ENTRY]);
    assert.deepEqual(parsed, [
      {
        tag: "v0.1.15",
        version: "0.1.15",
        title: "0.1.15",
        publishedAt: "2026-10-18T05:00:00Z",
        htmlUrl: "https://github.com/xuanji-lab/orbita/releases/tag/v0.1.15",
      },
    ]);
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

describe("createRecentReleases —— 缓存与失败", () => {
  test("打到 API 端点，带 per_page；成功条目透传", async () => {
    const calls: string[] = [];
    const recent = createRecentReleases({ endpoint: () => "https://api.github.com/repos/a/b/releases", call: stubFetch(calls, [ENTRY]) });
    const result = await recent.recent();
    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.releases.length : -1, 1);
    assert.deepEqual(calls, ["https://api.github.com/repos/a/b/releases?per_page=5"]);
  });

  test("成功结果缓存 10 分钟：窗口内再点不打 API，过期后再打", async () => {
    const calls: string[] = [];
    let clock = 0;
    const recent = createRecentReleases({
      endpoint: () => "https://api.github.com/repos/a/b/releases",
      call: stubFetch(calls, [ENTRY]),
      now: () => clock,
    });
    await recent.recent();
    await recent.recent();
    assert.equal(calls.length, 1, "10 分钟窗口内第二次应命中缓存");
    clock = 10 * 60 * 1000;
    await recent.recent();
    assert.equal(calls.length, 2, "窗口过期后应重新请求");
  });

  test("非 200 落成 ok:false，且不缓存——重试真的再打一次", async () => {
    const calls: string[] = [];
    const recent = createRecentReleases({
      endpoint: () => "https://api.github.com/repos/a/b/releases",
      call: stubFetch(calls, { message: "rate limited" }, 403),
    });
    const first = await recent.recent();
    assert.equal(first.ok, false);
    assert.equal(first.ok ? "" : first.message, "HTTP 403");
    await recent.recent();
    assert.equal(calls.length, 2, "失败不该进缓存");
  });

  test("根形状不对（非数组）落成 ok:false", async () => {
    const recent = createRecentReleases({
      endpoint: () => "https://api.github.com/repos/a/b/releases",
      call: stubFetch([], { message: "Not Found" }),
    });
    const result = await recent.recent();
    assert.equal(result.ok, false);
  });

  test("没有配置发布源时不给兜底地址，直接说清楚", async () => {
    const recent = createRecentReleases({ endpoint: () => null, call: stubFetch([], []) });
    const result = await recent.recent();
    assert.equal(result.ok, false);
  });

  test("网络异常落成 ok:false，不抛给调用方", async () => {
    const recent = createRecentReleases({
      endpoint: () => "https://api.github.com/repos/a/b/releases",
      call: async () => {
        throw new Error("ENOTFOUND api.github.com");
      },
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
