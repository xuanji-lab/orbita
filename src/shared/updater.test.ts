/**
 * 更新契约里能单独测的纯函数（shared/updater.ts）。
 *
 * `releaseTagUrl` 是界面「查看说明」打开的那个地址：基址由主进程从 package.json 的
 * build.publish 给（见 main/updater/releases-url.ts），这里只负责拼尾巴。钉正常路径与
 * 一个边界：版本号还没到（快照未到，空串）时拼不出地址，调用方据此不画入口。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { recentReleaseTitle, releaseTagUrl } from "./updater.ts";

describe("releaseTagUrl —— 某一版的 Release 页", () => {
  test("版本号拼成 v<版本号> 的 tag 地址", () => {
    assert.equal(
      releaseTagUrl("https://github.com/example/repo/releases", "0.1.16"),
      "https://github.com/example/repo/releases/tag/v0.1.16",
    );
  });

  test("预发布版号原样进 tag（不做 semver 解析，只是拼串）", () => {
    assert.equal(
      releaseTagUrl("https://github.com/example/repo/releases", "0.2.0-beta.1"),
      "https://github.com/example/repo/releases/tag/v0.2.0-beta.1",
    );
  });

  test("版本号还没到（空串）时不拼：返回 null，而不是把人送到 /tag/v 上", () => {
    assert.equal(releaseTagUrl("https://github.com/example/repo/releases", ""), null);
  });
});

describe("recentReleaseTitle —— 列表行的标题该不该画", () => {
  const release = (title: string, version: string) => ({
    tag: `v${version}`,
    version,
    title,
    publishedAt: "2026-10-18T05:00:00Z",
    htmlUrl: "https://github.com/example/repo/releases",
  });

  test("与版本号相同 → null（只画 mono 版本号，不再重影）", () => {
    assert.equal(recentReleaseTitle(release("0.1.15", "0.1.15")), null);
    assert.equal(recentReleaseTitle(release("v0.1.15", "0.1.15")), null);
  });

  test("不同 → 原样返回（画成「0.1.13 · 会话记忆」那样的标题）", () => {
    assert.equal(recentReleaseTitle(release("会话记忆与回退", "0.1.13")), "会话记忆与回退");
  });

  test("标题为空（GitHub 允许没写名字）→ null", () => {
    assert.equal(recentReleaseTitle(release("", "0.1.15")), null);
    assert.equal(recentReleaseTitle(release("   ", "0.1.15")), null);
  });
});
