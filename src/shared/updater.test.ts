/**
 * 更新契约里能单独测的纯函数（shared/updater.ts）。
 *
 * `releaseTagUrl` 是界面「查看说明」打开的那个地址：基址由主进程从 package.json 的
 * build.publish 给（见 main/updater/releases-url.ts），这里只负责拼尾巴。钉正常路径与
 * 一个边界：版本号还没到（快照未到，空串）时拼不出地址，调用方据此不画入口。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { currentVersionNotesView, historyReleases, recentReleaseTitle, releaseTagUrl } from "./updater.ts";
import type { RecentRelease, UpdateNote } from "./updater.ts";

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
    notes: null,
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

describe("currentVersionNotesView —— 「当前版本」的说明从哪来", () => {
  const note: UpdateNote = { icon: null, text: "终端面板在大输出下重绘更快。" };
  const release = (version: string, notes: readonly UpdateNote[] | null): RecentRelease => ({
    tag: `v${version}`,
    version,
    title: version,
    publishedAt: "2026-10-18T05:00:00Z",
    htmlUrl: `https://github.com/example/repo/releases/tag/v${version}`,
    notes,
  });

  test("本地有（下载这一版时留在 userData 的那份）→ 直接用，不问网络", () => {
    assert.deepEqual(currentVersionNotesView("0.1.15", [note], null), { kind: "local", notes: [note] });
  });

  test("本地有时不看远端结果（列表就算拉失败也先用本地的）", () => {
    assert.deepEqual(currentVersionNotesView("0.1.15", [note], { ok: false, message: "HTTP 429" }), {
      kind: "local",
      notes: [note],
    });
  });

  test("本地没有、GitHub 还没回话 → fetching", () => {
    assert.deepEqual(currentVersionNotesView("0.1.15", null, null), { kind: "fetching" });
  });

  test("本地没有、列表里有这一版且带说明 → remote（点开再拉，与历史列表同一份缓存）", () => {
    const remote = { ok: true as const, releases: [release("0.1.16", null), release("0.1.15", [note])] };
    assert.deepEqual(currentVersionNotesView("0.1.15", null, remote), { kind: "remote", notes: [note] });
  });

  test("列表里没有这一版（GitHub 上还没发 / 不在前几版里）→ missing", () => {
    const remote = { ok: true as const, releases: [release("0.1.16", [note])] };
    assert.deepEqual(currentVersionNotesView("0.1.15", null, remote), { kind: "missing" });
  });

  test("列表里有这一版但没有说明（没附 latest.yml / latest.yml 没写）→ missing", () => {
    assert.deepEqual(
      currentVersionNotesView("0.1.15", null, { ok: true, releases: [release("0.1.15", null)] }),
      { kind: "missing" },
    );
    assert.deepEqual(
      currentVersionNotesView("0.1.15", null, { ok: true, releases: [release("0.1.15", [])] }),
      { kind: "missing" },
    );
  });

  test("拉取失败 → failed，带机器原话（界面放进 title 当诊断）", () => {
    assert.deepEqual(currentVersionNotesView("0.1.15", null, { ok: false, message: "HTTP 502" }), {
      kind: "failed",
      message: "HTTP 502",
    });
  });
});

describe("historyReleases —— 「历史版本」列表去掉当前版本", () => {
  const release = (version: string): RecentRelease => ({
    tag: `v${version}`,
    version,
    title: version,
    publishedAt: "2026-10-18T05:00:00Z",
    htmlUrl: `https://github.com/example/repo/releases/tag/v${version}`,
    notes: null,
  });

  test("当前版本从列表里去掉（它的说明归「当前版本」那一行管）", () => {
    const releases = [release("0.1.15"), release("0.1.14"), release("0.1.13")];
    assert.deepEqual(historyReleases(releases, "0.1.15"), [release("0.1.14"), release("0.1.13")]);
  });

  test("比当前新的版本保留（有可用更新还没装时，GitHub 上已挂着那一版）", () => {
    const releases = [release("0.1.16"), release("0.1.15"), release("0.1.14")];
    assert.deepEqual(historyReleases(releases, "0.1.15"), [release("0.1.16"), release("0.1.14")]);
  });

  test("仓里只发过当前这一版 → 空列表（界面据此说「没有更早的版本」，不是「还没有版本」）", () => {
    assert.deepEqual(historyReleases([release("0.1.15")], "0.1.15"), []);
  });
});
