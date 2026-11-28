/**
 * MXC 的 Node 版本闸门单测 —— 边界值逐个钉住。
 *
 * 为什么要单独测：这个闸门在 SDK 里**在 provision 之后才炸**（`backend_unavailable`），
 * 而失败现场看起来像「会话起不来」。写错一个边界，用户会对着一个已经建好的 OS 账号
 * 看到一句不知所云的错。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeSupportsNativeStdio, nodeTooOldReason } from "./mxc-node.ts";

describe("nodeSupportsNativeStdio（>=24.21 <25 || >=26.8）", () => {
  it("24.20 不够，24.21 刚好（Electron 43 带的就是 24.21.0）", () => {
    assert.equal(nodeSupportsNativeStdio("24.20.0"), false);
    assert.equal(nodeSupportsNativeStdio("24.21.0"), true);
    assert.equal(nodeSupportsNativeStdio("24.22.3"), true);
    assert.equal(nodeSupportsNativeStdio("v24.21.0"), true);
  });

  it("24.14（很多发行版还在这一档）被拦，且原因里写明要求", () => {
    assert.equal(nodeSupportsNativeStdio("24.14.0"), false);
    const reason = nodeTooOldReason("24.14.0");
    assert.match(reason, /24\.14\.0/);
    assert.match(reason, /24\.21/);
  });

  it("25 与 26.7 不够（SDK 的 range 明确跳过 25 这条线），26.8 起才行", () => {
    assert.equal(nodeSupportsNativeStdio("25.0.0"), false);
    assert.equal(nodeSupportsNativeStdio("26.7.9"), false);
    assert.equal(nodeSupportsNativeStdio("26.8.0"), true);
    assert.equal(nodeSupportsNativeStdio("27.0.0"), true);
    assert.equal(nodeSupportsNativeStdio("30.1.0"), true);
  });

  it("烂输入按不够处理（不抛）", () => {
    assert.equal(nodeSupportsNativeStdio(""), false);
    assert.equal(nodeSupportsNativeStdio("abc"), false);
    assert.equal(nodeSupportsNativeStdio("24"), false);
  });
});
