/**
 * 「沙箱有没有出网」这段话的账（computer-network.ts）。
 *
 * 三件事必须钉住：
 * 1. **开着出网时零变化**——提示词空串、失败原文一字不改（断网还可能是宿主机 / 网站 /
 *    地址写错，把设置问题扣上去就是误导）；
 * 2. **关掉出网且后端做得到时是确定句**——评审的原始问题就是模型只能拿到「可能没有出网」
 *    然后反复重试导航；
 * 3. **关掉出网但后端做不到时（L2b）不许说「你没网」**——它就挂在用户这台机器的网络上，
 *    说「没网」是假话。这一格是 `networkControlled` 存在的全部理由。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  computerUseNetworkGuideline,
  networkFailureError,
  sandboxNetworkNote,
  type SandboxNetworkFacts,
} from "./computer-network.ts";

/** 四象限：用户选了什么 × 这个后端能不能真断网 */
const QUADRANTS: ReadonlyArray<SandboxNetworkFacts & { label: string }> = [
  { label: "开着 / 能断", allowNetwork: true, networkControlled: true },
  { label: "开着 / 断不了", allowNetwork: true, networkControlled: false },
  { label: "关着 / 能断", allowNetwork: false, networkControlled: true },
  { label: "关着 / 断不了", allowNetwork: false, networkControlled: false },
];

describe("工具描述里那段（sandboxNetworkNote）", () => {
  test("四象限只有一格有话说：关着 + 能断网才是「没有出网」", () => {
    for (const q of QUADRANTS) {
      const note = sandboxNetworkNote({ allowNetwork: q.allowNetwork, networkControlled: q.networkControlled });
      if (q.allowNetwork === false && q.networkControlled) {
        assert.match(note, /This sandbox has no outbound network/, q.label);
      } else if (q.allowNetwork === false) {
        // 关着但断不了：一句诚实短话，且**不许**出现「没有出网」那种断言
        assert.match(note, /cannot block its network/, q.label);
        assert.ok(note.length > 0, `${q.label}：不能装作无事发生，用户的要求没被满足`);
        assert.doesNotMatch(note, /no outbound network/, q.label);
        assert.doesNotMatch(note, /pages will not load/, q.label);
      } else {
        assert.equal(note, "", `${q.label}：开着出网时一个字都不加`);
      }
    }
  });

  test("关着 + 能断：设置路径 + 「别重试导航」+ 宿主机工具要有用户同意", () => {
    const note = sandboxNetworkNote({ allowNetwork: false, networkControlled: true });
    assert.match(note, /Settings › Computer use/);
    assert.match(note, /Do not retry the navigation/);
    assert.match(note, /only if the user agrees — use the host browser_\* tools/);
  });

  test("关着 + 断不了：说清三件事（用户的要求 / 这台机器断不了 / 别主动浏览）", () => {
    const note = sandboxNetworkNote({ allowNetwork: false, networkControlled: false });
    assert.match(note, /The user turned off/);
    assert.match(note, /separate logon session on the user's own computer/);
    assert.match(note, /assume the machine's network is reachable/);
    assert.match(note, /Don't browse unless the task needs it/);
  });
});

describe("system prompt 那段（computerUseNetworkGuideline）", () => {
  test("开着出网：提示词是空串（一个字的噪音都不加），无论后端能不能断", () => {
    for (const networkControlled of [true, false]) {
      assert.equal(
        computerUseNetworkGuideline({ enabled: true, platformSupported: true, allowNetwork: true, networkControlled }),
        "",
      );
    }
  });

  test("平台不支持（非 Windows）：工具组不注册，出网一个字也不讲——讲了就是一句做不到的建议", () => {
    for (const allowNetwork of [true, false]) {
      for (const networkControlled of [true, false]) {
        assert.equal(
          computerUseNetworkGuideline({ enabled: true, platformSupported: false, allowNetwork, networkControlled }),
          "",
        );
      }
    }
  });

  test("开关关着（工具根本没注册）：也不讲出网，缺席（旧夹具）同样什么都不讲", () => {
    assert.equal(
      computerUseNetworkGuideline({ enabled: false, platformSupported: true, allowNetwork: false, networkControlled: true }),
      "",
    );
    assert.equal(
      computerUseNetworkGuideline({ enabled: false, platformSupported: true, allowNetwork: false, networkControlled: false }),
      "",
    );
    assert.equal(computerUseNetworkGuideline(undefined), "");
  });

  test("关着 + 能断：点明「这是设置不是网站」，并给出三条纪律与恢复方式", () => {
    const guideline = computerUseNetworkGuideline({
      enabled: true,
      platformSupported: true,
      allowNetwork: false,
      networkControlled: true,
    });
    assert.match(guideline, /<orbita-sandbox-network>/);
    assert.match(guideline, /no outbound network/);
    assert.match(guideline, /Do not retry a failed sandbox_navigate/);
    assert.match(guideline, /turning it on applies the next time the sandbox starts/);
    assert.match(guideline, /Local desktop and file work in the sandbox is unaffected/);
    // 设置路径要能照着找到那一行（与设置页文案同一路径）
    assert.match(guideline, /Settings › Computer use/);
    assert.match(guideline, /Allow network access/);
  });

  test("关着 + 断不了（L2b）：只有那句诚实短话，不许出现「你没有出网」", () => {
    const guideline = computerUseNetworkGuideline({
      enabled: true,
      platformSupported: true,
      allowNetwork: false,
      networkControlled: false,
    });
    assert.match(guideline, /<orbita-sandbox-network>/);
    assert.match(guideline, /cannot block its network/);
    assert.match(guideline, /assume the machine's network is reachable/);
    assert.doesNotMatch(guideline, /no outbound network/);
    assert.doesNotMatch(guideline, /pages will not load/i);
    assert.doesNotMatch(guideline, /Do not retry a failed sandbox_navigate/);
  });
});

describe("networkFailureError", () => {
  const message = "页面没有加载：ERR_INTERNET_DISCONNECTED（沙箱可能没有出网、宿主机没联网，或这个地址不可达）。";

  test("开着出网：原样返回（同一个字符串，调用点直接抛它），断不了的后端也一样", () => {
    assert.equal(networkFailureError(message, { allowNetwork: true, networkControlled: true }), message);
    assert.equal(networkFailureError(message, { allowNetwork: true, networkControlled: false }), message);
    // 连「可能」那半句都不动：此刻它说的确实是实情
    assert.match(networkFailureError(message, { allowNetwork: true, networkControlled: false }), /可能没有出网/);
  });

  test("关着 + 能断网 + 网络类错误：改成确定句，并说清这是设置、怎么恢复", () => {
    const text = networkFailureError(message, { allowNetwork: false, networkControlled: true }, "zh");
    assert.ok(text.startsWith(message), "guest 的原话要留着（含 ERR 码），模型才看得出是哪类错");
    assert.match(text, /确定原因（宿主设置，不是猜测）/);
    assert.match(text, /不允许出网/);
    assert.match(text, /这是设置，不是网站的问题/);
    assert.match(text, /允许沙箱出网/);
    assert.match(text, /下次启动沙箱时生效/);
    // 确定是设置问题：第一段那句「换一个一定能打开的地址试一次」也要真的消失，
    // 而不是只靠第二段「别这么做」去压它（模型先读到的是第一段）
    assert.match(text, /不要换地址、不要换站点/);
    assert.doesNotMatch(text, /换一个一定能打开的地址试一次/);
  });

  test("误导的「确认方式」整句被摘掉，它前后的话与错误码原样保留", () => {
    const guest =
      "页面没有加载：ERR_INTERNET_DISCONNECTED（沙箱可能没有出网）。" +
      "确认方式：换一个一定能打开的地址试一次；如果所有站点都是这个错，那是网络的问题，不是这一页的问题。" +
      "仍要操作当前界面时改用 computer_screenshot / computer_click 像素工具。";
    const text = networkFailureError(guest, { allowNetwork: false, networkControlled: true }, "zh");
    assert.match(text, /ERR_INTERNET_DISCONNECTED/);
    assert.match(text, /仍要操作当前界面时改用 computer_screenshot/);
    assert.doesNotMatch(text, /换一个一定能打开的地址试一次/);
    assert.ok(!text.includes("。。"), "摘句不能留下叠在一起的句号");
  });

  test("关着 + 断不了（L2b）：原样返回——不能把「可能没网」改成「确定没网」", () => {
    assert.equal(networkFailureError(message, { allowNetwork: false, networkControlled: false }), message);
  });

  test("三族网络码都认：断网 / DNS / 连不上", () => {
    for (const code of ["ERR_INTERNET_DISCONNECTED", "ERR_NAME_NOT_RESOLVED", "ERR_CONNECTION_TIMED_OUT"]) {
      assert.match(
        networkFailureError(`页面没有加载：${code}`, { allowNetwork: false, networkControlled: true }, "zh"),
        /不允许出网/,
        code,
      );
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
      assert.equal(
        networkFailureError(original, { allowNetwork: false, networkControlled: true }, "zh"),
        original,
        original,
      );
    }
  });
});

/**
 * 出网被关的那句结论也有两种语言（2026-11-28）。
 *
 * 中文界面拿到中文结论、英文界面拿到英文结论——**都不含对方的字符**。桥那句中文的
 * 「换一个地址试一次」只在中文侧存在；英文侧桥的回执早被宿主映射成英文，不会出现矛盾。
 */
describe("出网被关的结论：两种语言", () => {
  const message = "页面没有加载：ERR_INTERNET_DISCONNECTED";
  const facts = { allowNetwork: false, networkControlled: true };

  test("中文界面：中文结论，无整句英文", () => {
    const text = networkFailureError(message, facts, "zh");
    assert.match(text, /确定原因/);
    assert.doesNotMatch(text, /[A-Za-z]{4,} [A-Za-z]{4,} [A-Za-z]{4,}/);
  });

  test("英文界面：英文结论，不含 CJK", () => {
    // 英文界面下桥的回执已经由宿主映射成英文，所以这里用英文的正文（真实路径）
    const text = networkFailureError("The page did not load: ERR_INTERNET_DISCONNECTED", facts, "en");
    assert.doesNotMatch(text, /[一-鿿]/);
    assert.match(text, /Allow network access is off/);
    assert.match(text, /ERR_INTERNET_DISCONNECTED/);
  });
});
