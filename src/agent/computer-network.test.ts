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
import { en } from "../renderer/src/messages-en.ts";
import { zh } from "../renderer/src/messages-zh.ts";

/**
 * 提示词里写的那条设置路径，**从界面文案表拼出来**。
 *
 * 上一版的教训：文案里写的是「Settings › Experimental features › Computer use ›
 * "Allow network access"」，而设置页的页签其实叫 `Experimental`、分组叫 `Sandbox`——
 * 模型把这串英文原样转述给中文用户，用户照着找会对不上界面（真机验收里发现的）。
 * 写死一份字符串副本就会再次漂移，所以这里直接拿 `en` / `zh` 拼，
 * 改文案时测试会跟着响。
 */
const EN_ALLOW_NETWORK_PATH = [
  en.common.settings,
  en.settings.tabs.experimental,
  en.settings.tabs["computer-use"],
  en.computerUse.sandboxGroup,
  `"${en.computerUse.allowNetwork}"`,
].join(" › ");

const ZH_ALLOW_NETWORK_PATH = [
  zh.common.settings,
  zh.settings.tabs.experimental,
  zh.settings.tabs["computer-use"],
  zh.computerUse.allowNetwork,
].join(" › ");

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
    // 设置路径要能照着找到那一行（从界面文案表拼，见 EN_ALLOW_NETWORK_PATH）
    assert.ok(guideline.includes(EN_ALLOW_NETWORK_PATH), `system prompt 里要有设置路径：${EN_ALLOW_NETWORK_PATH}`);
  });

  test("描述那段：设置路径 + 「别重试导航」+ 宿主机工具要有用户同意", () => {
    const note = sandboxNetworkNote(false);
    assert.ok(note.includes(EN_ALLOW_NETWORK_PATH), `工具描述里要有设置路径：${EN_ALLOW_NETWORK_PATH}`);
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

describe("设置路径与真实界面标签一致", () => {
  const note = sandboxNetworkNote(false);
  const guideline = computerUseNetworkGuideline({ enabled: true, allowNetwork: false });
  const failure = networkFailureError("页面没有加载：ERR_INTERNET_DISCONNECTED", false);

  test("英文两段用 en 表的页签 / 分组 / 开关名，不自己翻译", () => {
    for (const [where, text] of [
      ["工具描述", note],
      ["system prompt", guideline],
    ] as const) {
      assert.ok(text.includes(EN_ALLOW_NETWORK_PATH), `${where} 缺设置路径：${EN_ALLOW_NETWORK_PATH}`);
      // 上一版的错名字不能再回来（界面上的页签叫 Experimental，没有 features）
      assert.ok(!text.includes("Experimental features"), `${where} 还在用界面上不存在的旧名`);
    }
  });

  test("中文确定句用 zh 表的同一行（三处标签必须一字不差）", () => {
    assert.ok(failure.includes(ZH_ALLOW_NETWORK_PATH), `缺中文设置路径：${ZH_ALLOW_NETWORK_PATH}`);
    // 分开检查各级，排版改动不会让这条测试静默变弱
    assert.ok(failure.includes(zh.settings.tabs.experimental));
    assert.ok(failure.includes(zh.settings.tabs["computer-use"]));
    assert.ok(failure.includes(zh.computerUse.allowNetwork));
    assert.ok(!failure.includes("实验性功能"), "中文里没有「实验性功能」这个词");
  });

  test("中英两份路径引用的是同一个开关：装修名就一起挂", () => {
    // 两边都能拼出路径本身就是契约（表里少一个键，这行就不成立）
    assert.notEqual(EN_ALLOW_NETWORK_PATH, ZH_ALLOW_NETWORK_PATH);
    assert.ok(EN_ALLOW_NETWORK_PATH.includes(en.computerUse.allowNetwork));
    assert.ok(ZH_ALLOW_NETWORK_PATH.includes(zh.computerUse.allowNetwork));
  });
});
