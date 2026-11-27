/**
 * 「沙箱有没有出网」这段话的账（computer-network.ts）。
 *
 * 两件事必须钉住：
 * 1. **开着出网时零变化**——提示词空串、失败原文一字不改（断网还可能是宿主机 / 网站 /
 *    地址写错，把设置问题扣上去就是误导）；
 * 2. **关掉出网时是确定句**——评审的原始问题就是模型只能拿到「可能没有出网」然后反复
 *    重试导航。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  computerUseNetworkGuideline,
  networkFailureError,
  sandboxNetworkNote,
} from "./computer-network.ts";

describe("提示词与工具描述", () => {
  test("开着出网：描述那段是空串，system prompt 也是空串（一个字的噪音都不加）", () => {
    assert.equal(sandboxNetworkNote(true), "");
    assert.equal(computerUseNetworkGuideline({ enabled: true, allowNetwork: true }), "");
  });

  test("开关关着（工具根本没注册）：也不讲出网，缺席（旧夹具）同样什么都不讲", () => {
    assert.equal(computerUseNetworkGuideline({ enabled: false, allowNetwork: false }), "");
    assert.equal(computerUseNetworkGuideline(undefined), "");
  });

  test("关掉出网：提示词点明「这是设置不是网站」，并给出三条纪律与恢复方式", () => {
    const guideline = computerUseNetworkGuideline({ enabled: true, allowNetwork: false });
    assert.match(guideline, /<orbita-sandbox-network>/);
    assert.match(guideline, /no outbound network/);
    assert.match(guideline, /Do not retry a failed sandbox_navigate/);
    assert.match(guideline, /turning it on applies the next time the sandbox starts/);
    assert.match(guideline, /Local desktop and file work in the sandbox is unaffected/);
    // 设置路径要能照着找到那一行（与设置页文案同一路径）
    assert.match(guideline, /Settings › Experimental features › Computer use/);
    assert.match(guideline, /Allow network access/);
  });

  test("描述那段：设置路径 + 「别重试导航」+ 宿主机工具要有用户同意", () => {
    const note = sandboxNetworkNote(false);
    assert.match(note, /Settings › Experimental features › Computer use/);
    assert.match(note, /Do not retry the navigation/);
    assert.match(note, /only if the user agrees — use the host browser_\* tools/);
  });
});

describe("networkFailureError", () => {
  const message = "页面没有加载：ERR_INTERNET_DISCONNECTED（沙箱可能没有出网、宿主机没联网，或这个地址不可达）。";

  test("开着出网：原样返回（同一个字符串，调用点直接抛它）", () => {
    assert.equal(networkFailureError(message, true), message);
    // 连「可能」那半句都不动：此刻它说的确实是实情
    assert.match(networkFailureError(message, true), /可能没有出网/);
  });

  test("关掉出网 + 网络类错误：改成确定句，并说清这是设置、怎么恢复", () => {
    const text = networkFailureError(message, false);
    assert.ok(text.startsWith(message), "guest 的原话要留着（含 ERR 码），模型才看得出是哪类错");
    assert.match(text, /确定原因（宿主设置，不是猜测）/);
    assert.match(text, /不允许出网/);
    assert.match(text, /这是设置，不是网站的问题/);
    assert.match(text, /允许沙箱出网/);
    assert.match(text, /下次启动沙箱时生效/);
    // guest 那句「换一个一定能打开的地址试一次」必须被点名废止：它就在上面，模型很容易照着做
    assert.match(text, /「换一个一定能打开的地址试一次」都不用再验证/);
  });

  test("三族网络码都认：断网 / DNS / 连不上", () => {
    for (const code of ["ERR_INTERNET_DISCONNECTED", "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_TIMED_OUT"]) {
      assert.match(networkFailureError(`页面没有加载：${code}`, false), /不允许出网/, code);
    }
  });

  test("不是网络类错误：关掉出网也一个字不改——网站 500 不是设置的问题", () => {
    for (const original of [
      "选择器「#gone」没有匹配到元素",
      "页面没有加载：ERR_ABORTED",
      "页面没有加载：ERR_HTTP_RESPONSE_CODE_FAILURE",
      "沙箱没有在运行",
      // 只有前缀、没有具体码：不算一条网络错误
      "ERR_CONNECTION_",
    ]) {
      assert.equal(networkFailureError(original, false), original, original);
    }
  });
});
