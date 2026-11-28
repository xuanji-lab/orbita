import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { computerUseUiTexts, type ComputerUseUiAction, type ComputerUseUiTexts } from "./computer-use-texts.ts";

/**
 * 这张表的**两道纯净守卫**（2026-11-28）。它们要拦的是同一类 bug：
 *
 *   1. 英文那半边漏了一句中文（英文界面下露中文）；
 *   2. 中文那半边有人图省事塞了一句英文（中文界面下露整句英文）。
 *
 * 为什么守在这里而不是守在调用点：文案的出口只有一个（`computerUseUiTexts`），守出口
 * 就能覆盖全部调用点；以后新加一个键、只写了一种语言，这两条测试立刻红。
 *
 * 专名例外：`WSB` / `QEMU` / `Edge` / `L2b` 这类名字在两种语言里都不翻译，所以中文守卫
 * 不按「出现 ASCII 就失败」判，而是按**英文的虚词**判（下面 `ENGLISH_FUNCTION_WORDS`）——
 * 专名里不会有 ` the ` / ` and ` / ` is `。
 */

const LANGS = ["zh", "en"] as const;

/**
 * 每个带参函数配一组样本实参：守卫要遍历函数产出的**文本**，不只是函数对象。
 * 这张表与接口一一对应，下面第一条测试会核对「函数键 == 表里的键」——
 * 以后新加一个带参键却忘了给样本，测试立刻红，而不是悄悄漏掉。
 */
const SAMPLE_ARGS: Partial<Record<keyof ComputerUseUiTexts, unknown[][]>> = {
  actionName: [["screenshot"]],
  isolationWindowsOnly: [["linux"]],
  isolationProbeFailed: [["boom"]],
  mxcNativeLoadFailed: [["boom"]],
  nodeTooOld: [["22.0.0"]],
  sandboxNotRunning: [["screenshot", "off"], ["uiaAct", "error"]],
  anotherSandboxRunning: [["WindowsSandboxClient.exe"]],
  bridgeExeMissing: [["C:\bridge.exe"]],
  sandboxExeMissing: [["C:\WindowsSandbox.exe"]],
  bridgeReadyTimeout: [[60]],
  bridgeWaitTimedOut: [[60]],
  sandboxWindowClosedEarly: [["1"]],
  wsbLaunchFailed: [["boom"]],
  sandboxLeftoverVms: [["1234, 5678"]],
  isolationBridgePingFailed: [["timeout"]],
  isolationBridgeNotAnnounced: [["C:\ws\out\bridge.log", null], ["C:\ws\out\bridge.log", "line"]],
  isolationBridgeLogTail: [["line"]],
  isolationBridgeExeMissing: [["C:\bridge.exe"]],
  isolationWorkspaceWriteFailed: [["C:\ws", "denied"]],
  isolationStopSessionFailed: [["boom"]],
  isolationReleaseFailed: [["boom"]],
  isolationResidue: [["C:\Users\agent"]],
  isolationNotRunning: [["screenshot", "off"], ["browser", "starting"], ["uiaAct", "error"]],
  isolationErrorState: [["boom"]],
  isolationBusy: [["screenshot", true], ["browser", false]],
  bridgeJpegMissing: [["screenshot"]],
  bridgeJpegFieldMissing: [["screenshot"]],
  bridgeJpegNameInvalid: [["x.jpg"]],
  tcpConnectError: [["boom"]],
  tcpHelloUnexpected: [["hello-nope"]],
  tcpReadTimeout: [[1500]],
  tcpHelloTimeout: [[1500]],
  tcpConnectFailed: [["ECONNREFUSED"]],
  tcpConnectTimeout: [[1500]],
  tcpHandshakeFailed: [["127.0.0.1:1", "timeout"]],
  tcpChannelBroke: [["screenshot", " timeout"]],
  guestBrowserTimeout: [["cdp-nav", "45s"]],
  guestDesktopTimeout: [["screenshot", "45s"]],
  browserUploadNotFound: [["C:\a.pdf"]],
  browserUploadNotFile: [["C:\a"]],
  browserUploadEmpty: [["C:\a.pdf"]],
  browserUploadBadName: [["C:\a.pdf"]],
  internalWrongLane: [["click", "CDP"]],
  tooManyBrowsers: [[4]],
  qemuStopFailed: [["boom"]],
  qemuUnknownCommand: [["uia-list", "click / type"]],
  qemuGuestTimeout: [[1500, 5900]],
  qemuGuestUnreachable: [[5900, "boom"]],
  qemuGuestHttp: [[500, 5900]],
  qemuGuestNotJson: [["<html>"]],
  qemuShotHttp: [[500]],
  qemuNoShot: [["boom"]],
  qemuNoFreePorts: [["6200..6400"]],
  qemuVmFilesMissing: [["desktop.qcow2"]],
  qemuWaitTimeout: [[90, "boom"]],
  rfbUnreachable: [[5900]],
  rfbNotRfb: [["HTTP"]],
  rfbAuthTypes: [["2,16"]],
  backendSwitchStopFailed: [["wsb", "boom"]],
  emergencyHotkeyTaken: [["Ctrl+Shift+F12"]],
  leaseTimeout: [["Kimi"], [""]],
  leaseQueueFull: [["Kimi", 8]],
  leaseHoldExpired: [[15]],
  leaseRevoked: [["stopped"]],
  leaseBusy: [["Kimi"]],
  guestErrorGenericCode: [["net::ERR_CONNECTION_RESET"]],
  // ── 回执正文（computer-use-receipt-texts.ts）：样本实参由脚本按参数个数生成 ──
  rcptNavOpened: [["sample", 1, true, "sample"]],
  rcptObserveTitleLine: [["sample", 1]],
  rcptElementsHeader: [[1]],
  rcptObserveTruncated: [["sample", 1]],
  rcptElementLine: [["sample", 1, true, "sample", 1, true, "sample"]],
  rcptClickDone: [["sample", 1, true, "sample", 1, true]],
  rcptTypeDone: [["sample", 1, true, "sample", 1]],
  rcptExtractTotal: [[1]],
  rcptExtractTruncated: [["sample", 1]],
  rcptWaitSettled: [["sample"]],
  rcptWaitAppeared: [["sample", 1]],
  rcptWaitMissing: [["sample", 1]],
  rcptShotPage: [["sample", 1, true, "sample", 1, true]],
  rcptUploadAttached: [["sample", 1, true]],
  rcptDownloadNone: [["sample", 1]],
  rcptDownloadDone: [["sample", 1, true]],
  rcptTabsHeader: [["sample"]],
  rcptTabsSwitched: [["sample"]],
  rcptDesktopShot: [["sample", 1, true, "sample"]],
  rcptWindowShot: [["sample", 1, true, "sample", 1, true]],
  rcptClickSent: [["sample", 1, true]],
  rcptTypedChars: [["sample"]],
  rcptKeyPressed: [["sample"]],
  rcptScrolled: [["sample", 1, true]],
  rcptAdmission: [["sample", 1, true]],
  rcptDeferred: [["sample"]],
  rcptCandidates: [["sample"]],
  rcptWindowMinimized: [["sample"]],
  rcptUiaActWarningLabel: [["sample"]],
  rcptUiaGoneLine: [["sample", "sample"]],
  rcptUiaGoneUnnamed: [["sample"]],
  rcptUiaNoTitle: [["sample"]],
  rcptUiaItemSupports: [["sample"]],
  rcptUiaItemAt: [["sample"]],
  rcptUiaListHead: [["sample", 1, true, "sample", 1]],
  rcptUiaDiffHead: [["sample", 1, true, "sample", 1, true, "sample", 1, true]],
  rcptUiaTail: [["sample", 1]],
  rcptUiaPasswordNote: [["sample"]],
  rcptUiaEditNote: [["sample"]],
  rcptUiaNoteLine: [["sample"]],
  rcptUiaItemUnnamed: [["sample"]],
  rcptUiaChangeChanged: [["sample"]],
  rcptUiaVerbInvoke: [["sample"]],
  rcptUiaVerbSetValue: [["sample"]],
  rcptUiaVerbSelection: [["sample"]],
  rcptUiaActHead: [["sample", 1, true, "sample", 1, true]],
  rcptUiaActFooter: [["sample"]],
  rcptCaptureMasked: [["sample"]],
  rcptCaptureStale: [["sample", 1]],
  rcptShotMaskClean: [["sample"]],
  rcptShotMaskNothingCovered: [["sample"]],
  rcptShotMaskCovered: [["sample", 1]],
  rcptShotMaskMissing: [["sample"]],
  rcptShotMaskBridgeSaid: [["sample"]],
  rcptPointOutside: [["sample", 1, true, "sample"]],
};

/** 把一份表摊成 `键 → 该键产出的全部文本`（函数按样本实参调一遍） */
function flatten(texts: ComputerUseUiTexts): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of Object.keys(texts) as Array<keyof ComputerUseUiTexts>) {
    const value = texts[key];
    const produced: string[] = [];
    if (typeof value === "string") {
      produced.push(value);
    } else {
      const calls = SAMPLE_ARGS[key];
      assert.ok(calls !== undefined, `${key}: 带参文案缺样本实参（补到 SAMPLE_ARGS）`);
      for (const args of calls ?? []) {
        const text = (value as (...inner: unknown[]) => string)(...args);
        assert.equal(typeof text, "string", `${key} 必须回字符串`);
        produced.push(text);
      }
    }
    out.set(key, produced);
  }
  return out;
}

const CJK = /[\u4e00-\u9fff]/;

/** 英文句子里的虚词：中文文案里出现它们，就是有人把英文原句留下了 */
const ENGLISH_FUNCTION_WORDS = [" the ", " and ", " is ", " are ", " to ", " of ", " you ", " this ", " with "];

describe("电脑使用文案表：结构", () => {
  test("zh / en 两张表的键完全一致（漏一个就是漏一条翻译）", () => {
    const zh = Object.keys(computerUseUiTexts("zh")).sort();
    const en = Object.keys(computerUseUiTexts("en")).sort();
    assert.deepEqual(en, zh);
  });

  test("每一句都不为空，且 zh 与 en 不是同一句话（没翻译 / 复制粘贴）", () => {
    const zh = flatten(computerUseUiTexts("zh"));
    const en = flatten(computerUseUiTexts("en"));
    for (const [key, zhTexts] of zh) {
      const enTexts = en.get(key) ?? [];
      assert.equal(enTexts.length, zhTexts.length, `${key}: 两侧句数不一致`);
      zhTexts.forEach((zhText, index) => {
        const enText = enTexts[index] ?? "";
        assert.ok(zhText.trim() !== "", `${key}[${index}]: 中文为空`);
        assert.ok(enText.trim() !== "", `${key}[${index}]: 英文为空`);
        assert.notEqual(enText, zhText, `${key}[${index}]: 两侧一模一样，多半漏了翻译`);
      });
    }
  });

  test("不认得的语言按英文（与界面缺省一致）", () => {
    assert.deepEqual(flatten(computerUseUiTexts(undefined)), flatten(computerUseUiTexts("en")));
    assert.deepEqual(flatten(computerUseUiTexts("fr")), flatten(computerUseUiTexts("en")));
  });
});

describe("英文纯净守卫：英文那半边不许出现任何 CJK", () => {
  test("每个键、每种实参下都没有中日韩字符", () => {
    const violations: string[] = [];
    for (const language of LANGS) {
      if (language !== "en") continue;
      for (const [key, texts] of flatten(computerUseUiTexts(language))) {
        texts.forEach((text, index) => {
          const hit = CJK.exec(text);
          if (hit !== null) violations.push(`${key}[${index}]: …${text.slice(Math.max(0, hit.index - 20), hit.index + 20)}…`);
        });
      }
    }
    assert.deepEqual(violations, []);
  });

  test("英文那半边也不许留着中文标点（「」『』、【】：；（）！？。等）", () => {
    const violations: string[] = [];
    for (const [key, texts] of flatten(computerUseUiTexts("en"))) {
      for (const text of texts) {
        // 「」『』、【】：；（）！？。 都是中文界面专用的标点；英文句子里出现它们
        // 基本等于那句是从中文抄过来的（`›` 是英文界面自己的面包屑，允许）
        const hit = /[「」『』【】：；！（）、。]/.exec(text);
        if (hit !== null) violations.push(`${key}: ${hit[0]}`);
      }
    }
    assert.deepEqual(violations, []);
  });
});

/**
 * 只由标点/分隔符构成的键：它们本来就是排版用的（中文「，」「、」，英文 ", "），
 * 按「必须有汉字」判会误报。**只允许这几个键**——别的键出现「一个汉字都没有」仍然是漏翻译。
 */
const PUNCTUATION_ONLY_KEYS = new Set(["rcptUiaStateSeparator", "rcptUiaFlagJoiner"]);

describe("中文纯净守卫：中文那半边不许留整句英文", () => {
  test("每句都有中文（纯分隔符的键除外）", () => {
    for (const [key, texts] of flatten(computerUseUiTexts("zh"))) {
      if (PUNCTUATION_ONLY_KEYS.has(key)) continue;
      texts.forEach((text, index) => {
        assert.match(text, CJK, `${key}[${index}] 里一个汉字都没有：${text}`);
      });
    }
  });

  test("纯分隔符的键确实只有分隔符（不许借这个名单塞英文）", () => {
    const zh = computerUseUiTexts("zh");
    for (const key of PUNCTUATION_ONLY_KEYS) {
      const value = zh[key as keyof typeof zh];
      assert.equal(typeof value, "string", `${key} 应当是字符串`);
      assert.doesNotMatch(String(value), /[A-Za-z0-9]/, `${key} 里不许有字母数字`);
    }
  });

  test("不含英文虚词（the / and / is / to / of / you / this / with 这类只属于英文句子）", () => {
    const violations: string[] = [];
    for (const [key, texts] of flatten(computerUseUiTexts("zh"))) {
      for (const text of texts) {
        for (const word of ENGLISH_FUNCTION_WORDS) {
          if (text.includes(word)) violations.push(`${key}: 含有「${word.trim()}」`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });
});

describe("动作名词", () => {
  test("七种动作两种语言都有名词，且各不相同（拼进句子里不能撞成同一句）", () => {
    const actions: ComputerUseUiAction[] = ["screenshot", "windowShot", "windowList", "uiaList", "uiaAct", "pixels", "browser"];
    for (const language of LANGS) {
      const texts = computerUseUiTexts(language);
      const names = actions.map((action) => texts.actionName(action));
      assert.equal(new Set(names).size, names.length, `${language}: 有动作名词重复`);
      for (const name of names) assert.ok(name.trim() !== "");
    }
  });
});
