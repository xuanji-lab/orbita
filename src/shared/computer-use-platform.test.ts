/**
 * 平台谓词的账：谁家算能用、其余归哪一类、不支持的文案键取哪一条。
 * 三处共用（设置页 / 开轮装配 / agent 工具注册）的那一份判定就在这里钉。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computerUsePlatformKind, computerUsePlatformSupport, computerUseToolsActive } from "./computer-use-platform.ts";

describe("computerUsePlatformSupport（电脑使用只在 Windows 上）", () => {
  test("win32：支持，不给理由键", () => {
    assert.deepEqual(computerUsePlatformSupport("win32"), {
      supported: true,
      kind: "windows",
      reasonKey: null,
    });
  });

  test("darwin：不支持，点名 macOS 那条出路", () => {
    assert.deepEqual(computerUsePlatformSupport("darwin"), {
      supported: false,
      kind: "macos",
      reasonKey: "macos",
    });
  });

  test("linux：不支持，归 linux 一类", () => {
    assert.deepEqual(computerUsePlatformSupport("linux"), {
      supported: false,
      kind: "linux",
      reasonKey: "linux",
    });
  });

  test("认不出的平台（freebsd / 空串）：同样不支持，归 other——fail closed", () => {
    for (const platform of ["freebsd", "aix", "sunos", "openbsd", ""]) {
      assert.deepEqual(
        computerUsePlatformSupport(platform),
        { supported: false, kind: "other", reasonKey: "other" },
        platform,
      );
    }
  });

  test("归档函数与支持判定同源：kind 为 windows 当且仅当 supported", () => {
    for (const platform of ["win32", "darwin", "linux", "freebsd"]) {
      assert.equal(computerUsePlatformKind(platform) === "windows", computerUsePlatformSupport(platform).supported);
    }
  });
});

describe("computerUseToolsActive（这一轮注不注册 computer_* / sandbox_*）", () => {
  test("Windows + 开关开着：注册", () => {
    assert.equal(computerUseToolsActive({ enabled: true, platformSupported: true, allowNetwork: true }), true);
  });

  test("非 Windows：开关开着也不注册（拒绝文案在那里只能是做不到的建议）", () => {
    assert.equal(computerUseToolsActive({ enabled: true, platformSupported: false, allowNetwork: true }), false);
    // 出网关不关都要关掉这组工具：它们操作的是同一个沙箱
    assert.equal(computerUseToolsActive({ enabled: true, platformSupported: false, allowNetwork: false }), false);
  });

  test("开关关着 / 现场缺席：不注册", () => {
    assert.equal(computerUseToolsActive({ enabled: false, platformSupported: true, allowNetwork: true }), false);
    assert.equal(computerUseToolsActive(undefined), false);
  });
});
