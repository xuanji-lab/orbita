/**
 * 状态机与版本比较的测试（updater/state.ts）。
 *
 * 钉三类事：一条完整走通的主链、两条粘性规则（已下载不被顶掉 / 下载中不被检查结果
 * 覆盖）、以及「状态没变时返回同一个引用」这条广播去重的依据。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { UpdateNote, UpdateRelease, UpdateState } from "../../shared/updater.ts";
import { isNewerVersion, reduceUpdater } from "./state.ts";

const release = (
  version: string,
  size: number | null = 14_800_000,
  releaseNotes: readonly UpdateNote[] | null = [{ icon: "download", text: "更新内容" }],
): UpdateRelease => ({
  version,
  size,
  releaseNotes,
});

describe("reduceUpdater —— 主链", () => {
  test("idle → checking → available → downloading → downloaded", () => {
    let state: UpdateState = { kind: "idle" };
    state = reduceUpdater(state, { type: "check-started" });
    assert.deepEqual(state, { kind: "checking" });

    state = reduceUpdater(state, { type: "available", release: release("0.2.0") });
    assert.deepEqual(state, { kind: "available", release: release("0.2.0") });

    state = reduceUpdater(state, { type: "download-started" });
    assert.deepEqual(state, {
      kind: "downloading",
      release: release("0.2.0"),
      progress: { percent: 0, transferred: 0, total: 14_800_000, bytesPerSecond: 0 },
    });

    state = reduceUpdater(state, {
      type: "progress",
      progress: { percent: 42, transferred: 6_200_000, total: 14_800_000, bytesPerSecond: 900_000 },
    });
    assert.equal(state.kind, "downloading");

    state = reduceUpdater(state, { type: "downloaded", version: "0.2.0" });
    assert.deepEqual(state, { kind: "downloaded", version: "0.2.0" });
  });

  test("size 缺席时进度条的 total 从 0 起（界面靠 percent 画）", () => {
    const state = reduceUpdater(
      { kind: "available", release: release("0.2.0", null) },
      { type: "download-started" },
    );
    assert.equal(state.kind, "downloading");
    if (state.kind !== "downloading") return;
    assert.equal(state.progress.total, 0);
  });

  test("检查结果就是已是最新 → up-to-date；失败 → error（带阶段）", () => {
    const available = reduceUpdater({ kind: "checking" }, { type: "up-to-date", version: "0.1.15" });
    assert.deepEqual(available, { kind: "up-to-date", version: "0.1.15" });

    const failed = reduceUpdater(available, { type: "failed", stage: "check", message: "ETIMEDOUT" });
    assert.deepEqual(failed, { kind: "error", stage: "check", message: "ETIMEDOUT" });
  });

  test("失败后可重新检查：error → checking → available（重试路径）", () => {
    const error: UpdateState = { kind: "error", stage: "download", message: "socket hang up" };
    const checking = reduceUpdater(error, { type: "check-started" });
    assert.deepEqual(checking, { kind: "checking" });
  });
});

describe("reduceUpdater —— 粘性规则", () => {
  test("已下载的更新不被随后的一次检查顶掉（check-started / up-to-date / failed 都动不了它）", () => {
    const downloaded: UpdateState = { kind: "downloaded", version: "0.2.0" };
    assert.equal(reduceUpdater(downloaded, { type: "check-started" }), downloaded);
    assert.equal(reduceUpdater(downloaded, { type: "up-to-date", version: "0.2.0" }), downloaded);
    assert.equal(reduceUpdater(downloaded, { type: "failed", stage: "check", message: "x" }), downloaded);
    assert.equal(reduceUpdater(downloaded, { type: "failed", stage: "download", message: "x" }), downloaded);
  });

  test("已下载 0.2.0，更新源又给出 0.2.0（发布重发）→ 保留已下载的那份", () => {
    const downloaded: UpdateState = { kind: "downloaded", version: "0.2.0" };
    assert.equal(reduceUpdater(downloaded, { type: "available", release: release("0.2.0") }), downloaded);
  });

  test("已下载 0.2.0，更新源给出更旧的 0.1.16（发布被回退）→ 保留已下载的那份", () => {
    const downloaded: UpdateState = { kind: "downloaded", version: "0.2.0" };
    assert.equal(reduceUpdater(downloaded, { type: "available", release: release("0.1.16") }), downloaded);
  });

  test("已下载 0.2.0，更新源给出更新的 0.3.0 → 换成新的发布（用户可再下载一次）", () => {
    const next = reduceUpdater({ kind: "downloaded", version: "0.2.0" }, {
      type: "available",
      release: release("0.3.0"),
    });
    assert.deepEqual(next, { kind: "available", release: release("0.3.0") });
  });

  test("下载中不被检查结果打扰（check-started / up-to-date / available 都保持进度）", () => {
    const downloading: UpdateState = {
      kind: "downloading",
      release: release("0.2.0"),
      progress: { percent: 30, transferred: 1, total: 2, bytesPerSecond: 3 },
    };
    assert.equal(reduceUpdater(downloading, { type: "check-started" }), downloading);
    assert.equal(reduceUpdater(downloading, { type: "up-to-date", version: "0.2.0" }), downloading);
    assert.equal(reduceUpdater(downloading, { type: "available", release: release("0.3.0") }), downloading);
    assert.equal(reduceUpdater(downloading, { type: "failed", stage: "check", message: "x" }), downloading);
  });

  test("下载失败（stage=download）确实会中断下载 → error", () => {
    const downloading: UpdateState = {
      kind: "downloading",
      release: release("0.2.0"),
      progress: { percent: 30, transferred: 1, total: 2, bytesPerSecond: 3 },
    };
    const next = reduceUpdater(downloading, { type: "failed", stage: "download", message: "socket hang up" });
    assert.deepEqual(next, { kind: "error", stage: "download", message: "socket hang up" });
  });

  test("取消下载 → 退回同一份 available（大小与更新说明都不丢）", () => {
    const downloading: UpdateState = {
      kind: "downloading",
      release: release("0.2.0", 14_800_000),
      progress: { percent: 30, transferred: 1, total: 2, bytesPerSecond: 3 },
    };
    assert.deepEqual(reduceUpdater(downloading, { type: "download-cancelled" }), {
      kind: "available",
      release: release("0.2.0", 14_800_000),
    });
  });

  test("取消只对下载中有效（已下载 / 已是最新时是空操作）", () => {
    const downloaded: UpdateState = { kind: "downloaded", version: "0.2.0" };
    assert.equal(reduceUpdater(downloaded, { type: "download-cancelled" }), downloaded);
    const upToDate: UpdateState = { kind: "up-to-date", version: "0.2.0" };
    assert.equal(reduceUpdater(upToDate, { type: "download-cancelled" }), upToDate);
  });

  test("互不相关的动作是空操作：还没检查就点下载 / 没下载完就点安装", () => {
    const idle: UpdateState = { kind: "idle" };
    assert.equal(reduceUpdater(idle, { type: "download-started" }), idle);
    assert.equal(reduceUpdater(idle, { type: "progress", progress: { percent: 1, transferred: 1, total: 1, bytesPerSecond: 1 } }), idle);
    assert.equal(reduceUpdater(idle, { type: "downloaded", version: "0.2.0" }).kind, "downloaded");
  });
});

describe("reduceUpdater —— 状态不变就返回同一个引用（广播去重的依据）", () => {
  test("同一份发布的重复 available / 同一个进度的重复 progress / 同一条错误都不换对象", () => {
    const available = reduceUpdater({ kind: "checking" }, { type: "available", release: release("0.2.0") });
    assert.equal(reduceUpdater(available, { type: "available", release: release("0.2.0") }), available);

    const downloading = reduceUpdater(available, { type: "download-started" });
    const progress = { percent: 42, transferred: 6_200_000, total: 14_800_000, bytesPerSecond: 900_000 };
    const once = reduceUpdater(downloading, { type: "progress", progress });
    assert.equal(reduceUpdater(once, { type: "progress", progress }), once);
    assert.notEqual(reduceUpdater(once, { type: "progress", progress: { ...progress, percent: 43 } }), once);

    const error = reduceUpdater(once, { type: "failed", stage: "download", message: "socket hang up" });
    assert.equal(reduceUpdater(error, { type: "failed", stage: "download", message: "socket hang up" }), error);
    // 同一条错误被库报两次（事件 + rejection）时，第二次算出的阶段可能是 check：
    // 先到的那条（download）要留住，否则界面把「下载失败」说成「检查失败」
    assert.equal(reduceUpdater(error, { type: "failed", stage: "check", message: "socket hang up" }), error);
    // 换了一条错误就照实更新
    assert.deepEqual(reduceUpdater(error, { type: "failed", stage: "check", message: "ETIMEDOUT" }), {
      kind: "error",
      stage: "check",
      message: "ETIMEDOUT",
    });
  });
});

describe("isNewerVersion —— 版本比较", () => {
  test("数字段按数值比，不按字符串", () => {
    assert.equal(isNewerVersion("0.1.16", "0.1.15"), true);
    assert.equal(isNewerVersion("0.1.9", "0.1.10"), false);
    assert.equal(isNewerVersion("0.2.0", "0.10.0"), false);
    assert.equal(isNewerVersion("1.0.0", "0.99.99"), true);
    assert.equal(isNewerVersion("0.1.15", "0.1.15"), false);
  });

  test("v 前缀与段数不足都认", () => {
    assert.equal(isNewerVersion("v0.1.16", "0.1.15"), true);
    assert.equal(isNewerVersion("0.2", "0.1.15"), true);
    assert.equal(isNewerVersion("1", "0.9.9"), true);
    assert.equal(isNewerVersion("0.1.0", "0.1"), false);
  });

  test("预发布版低于同号正式版；数字标识符低于字母标识符", () => {
    assert.equal(isNewerVersion("1.0.0", "1.0.0-beta.1"), true);
    assert.equal(isNewerVersion("1.0.0-beta.1", "1.0.0"), false);
    assert.equal(isNewerVersion("1.0.0-beta.2", "1.0.0-beta.1"), true);
    assert.equal(isNewerVersion("1.0.0-beta", "1.0.0-alpha"), true);
    assert.equal(isNewerVersion("1.0.0-alpha", "1.0.0-beta"), false);
    assert.equal(isNewerVersion("1.0.0-alpha.2", "1.0.0-alpha"), true);
  });

  test("build 元数据按 semver 忽略", () => {
    assert.equal(isNewerVersion("0.1.16+build.7", "0.1.16"), false);
    assert.equal(isNewerVersion("0.1.17+build.7", "0.1.16"), true);
  });

  test("解析不出来一律 false（宁可留着已下载的安装包）", () => {
    assert.equal(isNewerVersion("", "0.1.15"), false);
    assert.equal(isNewerVersion("latest", "0.1.15"), false);
    assert.equal(isNewerVersion("0.1.16", "nightly"), false);
    assert.equal(isNewerVersion("0.1.16 发布", "0.1.15"), false);
    assert.equal(isNewerVersion("0.1.16.1.2", "0.1.15"), true);
  });
});
