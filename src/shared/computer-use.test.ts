/**
 * 沙箱坐标换算的账（shared/computer-use.ts 的纯函数）。
 *
 * 为什么值得单独测：模型给的坐标是**它看到的那张图**的像素，而 SendInput 要的是沙箱
 * 物理屏的像素——两张图的比例只有工具层知道。换算错了不会报错，只会「点到了别的地方」，
 * 而且隔着沙箱看不出来。越界一律回 null（不做猜测性钳制）是这里的另一半：模型算错时
 * 我们要给它一句「这张图只有 1280×720」，不是替它点个它没打算点的地方。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_USE_ADMISSION_VERDICTS,
  COMPUTER_USE_DEFAULT_ALLOWED_APPS,
  COMPUTER_USE_DELIVERIES,
  COMPUTER_USE_DELIVERY_HINTS,
  COMPUTER_USE_DEV_BACKENDS_ENV,
  COMPUTER_USE_MASK_CACHE_MAX_AGE_MS,
  COMPUTER_USE_SHOT_MAX_WIDTH,
  COMPUTER_USE_NO_EVIDENCE_HINT,
  COMPUTER_USE_UIA_TIMEOUT_MS,
  computerUseConsentTexts,
  captureNote,
  computerUseBlockedReason,
  backendNetworkControl,
  computerUseAudit,
  computerUseBackendChoices,
  computerUseChannels,
  computerUseDevBackendRefusal,
  computerUseMaskLabel,
  computerUseShotMask,
  computerUseShotMaskNote,
  computerUseUiaErrors,
  devBackendsEnabled,
  isUiaFocusRequest,
  isUiaRequest,
  isWindowScreenshotRequest,
  mergeGuestAllowExe,
  normalizeGuestAppName,
  parseComputerUseAdmission,
  parseComputerUseDelivery,
  parseComputerUseEvidence,
  screenshotPointToNative,
  settleComputerUseDelivery,
  type ComputerUseEvidence,
  type ComputerUseToolRequest,
  type ComputerUseCaptureInfo,
  type ComputerUseShotMask,
} from "./computer-use.ts";

/** 回图 1280×720，物理屏 2560×1440（长边缩一半的常见情形） */
const scaled = { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440 };

describe("开发者后端（qemu）的门", () => {
  test("环境变量：缺席 / 空串 / 其它值都算关，只有 1 / true / yes / on（不分大小写）才算开", () => {
    // 默认关是这条门的前提：没显式打开就必须没有 qemu。
    // 边界值单列：`false` / `yes please` / `truex` 这类**前缀或子串看着对**的写法必须判关——
    // 「按前缀猜」是这道门最危险的一种实现错误。
    const closed = [
      {},
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "" },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "0" },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "off" },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "  " },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "false" },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "false please" },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "yes please" },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "truex" },
      { [COMPUTER_USE_DEV_BACKENDS_ENV]: "onward" },
    ];
    for (const env of closed) {
      assert.equal(devBackendsEnabled(env), false, JSON.stringify(env));
    }
    for (const value of ["1", "true", "TRUE", "yes", " on "]) {
      assert.equal(devBackendsEnabled({ [COMPUTER_USE_DEV_BACKENDS_ENV]: value }), true, value);
    }
  });

  test("可选后端列表：开 = 三档（qemu 标实验），关 = 只有两档且不含 qemu", () => {
    assert.deepEqual(computerUseBackendChoices(true), [
      { id: "wsb", experimental: false },
      { id: "isolation-session", experimental: false },
      { id: "qemu", experimental: true },
    ]);
    const off = computerUseBackendChoices(false);
    assert.deepEqual(
      off.map((choice) => choice.id),
      ["wsb", "isolation-session"],
    );
    assert.equal(off.some((choice) => choice.experimental), false);
  });

  test("拒绝文案是给人看的整句：点名开发者后端、自备镜像 / QEMU、只有截图点击打字、以及怎么开", () => {
    const text = computerUseDevBackendRefusal();
    for (const needle of ["开发者后端", "自备", "QEMU", "镜像", "截图", "点击", "打字", "UIA", "浏览器", "文件映射", "快照", COMPUTER_USE_DEV_BACKENDS_ENV]) {
      assert.ok(text.includes(needle), `拒绝文案缺「${needle}」：${text}`);
    }
  });
});

describe("screenshotPointToNative", () => {
  test("没缩放（回图 = 物理屏）：坐标原样过", () => {
    const shot = { width: 2560, height: 1440, nativeWidth: 2560, nativeHeight: 1440 };
    assert.deepEqual(screenshotPointToNative(shot, 100, 200), { x: 100, y: 200 });
    assert.deepEqual(screenshotPointToNative(shot, 0, 0), { x: 0, y: 0 });
  });

  test("长边缩一半：图像坐标乘 2 得到物理像素", () => {
    assert.deepEqual(screenshotPointToNative(scaled, 100, 200), { x: 200, y: 400 });
    assert.deepEqual(screenshotPointToNative(scaled, 0, 0), { x: 0, y: 0 });
    assert.deepEqual(screenshotPointToNative(scaled, 1279, 719), { x: 2558, y: 1438 });
  });

  test("两个轴各算各的比例（等比是桥的实现细节，不是协议）", () => {
    const shot = { width: 100, height: 100, nativeWidth: 1000, nativeHeight: 500 };
    assert.deepEqual(screenshotPointToNative(shot, 50, 50), { x: 500, y: 250 });
  });

  test("贴边写法（x == width / y == height）合法，落在最后一个像素上", () => {
    assert.deepEqual(screenshotPointToNative(scaled, 1280, 720), { x: 2559, y: 1439 });
  });

  test("图外 / 负数 / 非有限数一律 null——不钳制、不猜", () => {
    assert.equal(screenshotPointToNative(scaled, 1281, 100), null);
    assert.equal(screenshotPointToNative(scaled, 100, 721), null);
    assert.equal(screenshotPointToNative(scaled, -1, 0), null);
    assert.equal(screenshotPointToNative(scaled, 0, -1), null);
    assert.equal(screenshotPointToNative(scaled, Number.NaN, 10), null);
    assert.equal(screenshotPointToNative(scaled, 10, Number.POSITIVE_INFINITY), null);
  });

  test("四舍五入到整数像素（3 像素宽的图 → 10 像素的屏）", () => {
    const shot = { width: 3, height: 3, nativeWidth: 10, nativeHeight: 10 };
    assert.deepEqual(screenshotPointToNative(shot, 1, 1), { x: 3, y: 3 });
    assert.deepEqual(screenshotPointToNative(shot, 2, 2), { x: 7, y: 7 });
  });

  test("回图宽度上限是 1280（工具层按它压图省上下文）", () => {
    assert.equal(COMPUTER_USE_SHOT_MAX_WIDTH, 1280);
  });
});

describe("isWindowScreenshotRequest（租约分流的唯一判据）", () => {
  test("整桌面截图：false（仍要 desktop:exclusive）", () => {
    assert.equal(isWindowScreenshotRequest({ action: "screenshot" }), false);
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", maxWidth: 1280 }), false);
  });

  test("screenshot + window（标题或 hwnd）：true（不占桌面）", () => {
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", window: "Edge" }), true);
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", window: 4321, maxWidth: 640 }), true);
    // 空串也是「给了 window」：宿主要照常下发，让桥回一句「没找到这个窗口」，
    // 而不是悄悄退成整桌面截图（那会拍到用户没要的画面）
    assert.equal(isWindowScreenshotRequest({ action: "screenshot", window: "" }), true);
  });

  test("像素输入与浏览器动作：false（各有各的租约）", () => {
    assert.equal(isWindowScreenshotRequest({ action: "click", x: 1, y: 2 }), false);
    assert.equal(isWindowScreenshotRequest({ action: "type", text: "x" }), false);
    assert.equal(isWindowScreenshotRequest({ action: "sandbox-navigate", url: "https://example.com" }), false);
  });
});

describe("isUiaRequest（UIA 车道不占桌面租约的判据）", () => {
  test("uia-list / uia-act：true（不抢前台，所以不排队）", () => {
    assert.equal(isUiaRequest({ action: "uia-list", window: 4321 }), true);
    assert.equal(isUiaRequest({ action: "uia-list", window: "Edge" }), true);
    assert.equal(isUiaRequest({ action: "uia-act", perform: "invoke", ref: "g1:r3" }), true);
    assert.equal(isUiaRequest({ action: "uia-act", perform: "setValue", name: "Search", value: "orbita" }), true);
    assert.equal(isUiaRequest({ action: "uia-act", perform: "selection", ref: "g1:r3" }), true);
  });

  test("像素输入 / 整桌面截图 / 窗口截图 / 浏览器：都不是 UIA 车道", () => {
    assert.equal(isUiaRequest({ action: "click", x: 1, y: 2 }), false);
    assert.equal(isUiaRequest({ action: "screenshot" }), false);
    assert.equal(isUiaRequest({ action: "screenshot", window: 7 }), false);
    assert.equal(isUiaRequest({ action: "sandbox-click", selector: "#a" }), false);
  });

  test("看门狗 5 秒：比 guest 命令的 45 秒短一个量级，它管的是跨进程调用而不是整条通道", () => {
    assert.equal(COMPUTER_USE_UIA_TIMEOUT_MS, 5_000);
  });
});

describe("已删除的 focus 动作（桥 0.11.0）", () => {
  /** 旧 agent / 旧会话记录里还可能夹着这个动作：用宽化对象模拟，不走正常类型 */
  const legacyFocus = { action: "uia-act", perform: "focus", ref: 1 } as unknown as ComputerUseToolRequest;

  test("isUiaFocusRequest 认得它（接线层的兜底拦截靠这条判据）", () => {
    assert.equal(isUiaFocusRequest(legacyFocus), true);
    assert.equal(
      isUiaFocusRequest({ action: "uia-act", perform: "focus", name: "Search", window: "Edge" } as unknown as ComputerUseToolRequest),
      true,
    );
  });

  test("其余动作都不是它（包括仍然合法的三条 UIA 动作）", () => {
    assert.equal(isUiaFocusRequest({ action: "uia-list", window: 4321 }), false);
    assert.equal(isUiaFocusRequest({ action: "uia-act", perform: "invoke", ref: "g1:r2" }), false);
    assert.equal(isUiaFocusRequest({ action: "uia-act", perform: "setValue", name: "Search", value: "x" }), false);
    assert.equal(isUiaFocusRequest({ action: "uia-act", perform: "selection", ref: "g1:r2" }), false);
    assert.equal(isUiaFocusRequest({ action: "click", x: 1, y: 2 }), false);
    assert.equal(isUiaFocusRequest({ action: "type", text: "x" }), false);
  });

  test("拒绝文案给出两条替代路径（模型看不见 UI，不告诉它换什么它只会重试）", () => {
    assert.match(computerUseUiaErrors.focusRemoved, /computer_click/);
    assert.match(computerUseUiaErrors.focusRemoved, /invoke/);
    assert.match(computerUseUiaErrors.focusRemoved, /setValue/);
    assert.match(computerUseUiaErrors.focusRemoved, /接.*删除|已删除/);
  });
});

describe("computerUseChannels（IPC 契约真源）", () => {
  test("每个通道值唯一、都带 computer-use: 前缀（复制粘贴改错会在这里红）", () => {
    const values = Object.values(computerUseChannels);
    assert.equal(new Set(values).size, values.length);
    for (const value of values) assert.match(value, /^computer-use:/);
  });

  test("有「取当前状态」通道——只靠迁移推送会让重挂载的设置页永远按 off 画", () => {
    // 2026-10-27 真机 P1：沙盒在跑时离开设置页再回来，徽标显示未启动、
    // 停止按钮灰、点启动报「沙箱已经在运行」，用户从 UI 停不掉。
    assert.equal(computerUseChannels.computerUseStatusGet, "computer-use:status-get");
  });
});

// ── 像素输入的交付语义（五档）─────────────────────────────────────────

describe("parseComputerUseDelivery", () => {
  test("五档各自认对：原样返回", () => {
    for (const delivery of COMPUTER_USE_DELIVERIES) {
      assert.equal(parseComputerUseDelivery(delivery), delivery);
    }
  });

  test("老桥的三个老值归一：applied→confirmed、dispatched→unverifiable、failed→refused", () => {
    assert.equal(parseComputerUseDelivery("applied"), "confirmed");
    assert.equal(parseComputerUseDelivery("dispatched"), "unverifiable");
    assert.equal(parseComputerUseDelivery("failed"), "refused");
  });

  test("缺字段 / 不认识的档位 / 非字符串一律 undefined（不猜，不当成成功）", () => {
    for (const raw of [undefined, null, "", "Applied", "Dispatched", "ok", "possibly", 1, true, {}, []]) {
      assert.equal(parseComputerUseDelivery(raw), undefined, String(raw));
    }
  });
});

describe("settleComputerUseDelivery（没有读回证据就不许说 confirmed）", () => {
  test("confirmed 无证据 → 降级为 unverifiable（不抛错、不保留 confirmed）", () => {
    assert.equal(settleComputerUseDelivery("confirmed"), "unverifiable");
    assert.equal(settleComputerUseDelivery("confirmed", undefined), "unverifiable");
  });

  test("confirmed 有证据 → 保持 confirmed（四种读回都算证据）", () => {
    const evidences: ComputerUseEvidence[] = [
      { kind: "value", detail: 'value="已提交"' },
      { kind: "window", detail: "title=已保存" },
      { kind: "url", detail: "https://example.test/done" },
      { kind: "text", detail: "保存成功" },
    ];
    for (const evidence of evidences) {
      assert.equal(settleComputerUseDelivery("confirmed", evidence), "confirmed", evidence.kind);
    }
  });

  test("其余四档原样返回（降级只针对 confirmed 这一个谎报口子）", () => {
    for (const delivery of COMPUTER_USE_DELIVERIES) {
      if (delivery === "confirmed") continue;
      assert.equal(settleComputerUseDelivery(delivery), delivery);
      assert.equal(settleComputerUseDelivery(delivery, { kind: "text", detail: "x" }), delivery);
    }
  });
  test("settleComputerUseDelivery 与 evidence 是两件事：有证据也要有那一档才会放行", () => {
    // 反方向：拿得到证据但桥说的是 unverifiable → 不得被升级成 confirmed。
    // 这一条防的是「把『没读回』猜成『确认』」的第二种写法。
    assert.equal(settleComputerUseDelivery("unverifiable", { kind: "value", detail: "x" }), "unverifiable");
  });
});

describe("parseComputerUseEvidence（桥发来的证据只有四种有效形状）", () => {
  test("四种 kind 原样收下", () => {
    const evidences: ComputerUseEvidence[] = [
      { kind: "value", detail: 'value="已提交"' },
      { kind: "window", detail: "title=已保存" },
      { kind: "url", detail: "https://example.test/done" },
      { kind: "text", detail: "保存成功" },
    ];
    for (const evidence of evidences) {
      assert.deepEqual(parseComputerUseEvidence(evidence), evidence, evidence.kind);
    }
  });

  test("缺字段 / 不认识的 kind / 空 detail / 非对象 → undefined（当作没证据，不抛错）", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "value",
      1,
      true,
      [],
      {},
      { kind: "value" },
      { detail: "x" },
      { kind: "bogus", detail: "x" },
      { kind: "value", detail: "" },
      { kind: "value", detail: 123 },
      { kind: "value", detail: null },
    ];
    for (const raw of bad) {
      assert.equal(parseComputerUseEvidence(raw), undefined, JSON.stringify(raw));
    }
  });

  test("不认识的额外字段不影响（桥以后加字段不用先改宿主）", () => {
    assert.deepEqual(parseComputerUseEvidence({ kind: "value", detail: "x", extra: 1, at: 2 }), {
      kind: "value",
      detail: "x",
    });
  });
});

describe("COMPUTER_USE_DELIVERY_HINTS（五档唯一口径）", () => {
  test("恰好五档、顺序与 COMPUTER_USE_DELIVERIES 一致、每档一句非空的话", () => {
    assert.deepEqual(Object.keys(COMPUTER_USE_DELIVERY_HINTS), [...COMPUTER_USE_DELIVERIES]);
    for (const delivery of COMPUTER_USE_DELIVERIES) {
      assert.ok(COMPUTER_USE_DELIVERY_HINTS[delivery].trim().length > 0, delivery);
    }
  });

  test("unverifiable 的口径说清两件事：先看一眼 + 不要立刻重放", () => {
    assert.match(COMPUTER_USE_DELIVERY_HINTS.unverifiable, /先截一张图|先看一眼/);
    assert.match(COMPUTER_USE_DELIVERY_HINTS.unverifiable, /不要立刻重放/);
  });

  test("suspected_noop 要求换做法、不原样重试；refused 允许修参数重试", () => {
    assert.match(COMPUTER_USE_DELIVERY_HINTS.suspected_noop, /换个做法/);
    assert.match(COMPUTER_USE_DELIVERY_HINTS.suspected_noop, /不要原样重试/);
    assert.match(COMPUTER_USE_DELIVERY_HINTS.refused, /可以修参数后重试/);
  });

  test("不再存在「applied 这一档本刀不产出」这类与实现矛盾的说法", () => {
    for (const delivery of COMPUTER_USE_DELIVERIES) {
      assert.doesNotMatch(COMPUTER_USE_DELIVERY_HINTS[delivery], /本刀不产出|位置先留/);
    }
  });

  // P1-8：上一轮这两句模型读不懂——「先截一张图」没点名工具（它不知道调哪个），
  // 「还差什么看 evidence.detail」指向一个**模型看不见**的字段（它不在正文里）。
  test("unverifiable 点名 computer_screenshot（只说「截一张图」模型不知道该调哪个工具）", () => {
    assert.match(COMPUTER_USE_DELIVERY_HINTS.unverifiable, /computer_screenshot/);
    // 工具名是它唯一能执行的指令：必须与「先看一眼」「不要立刻重放」在同一句里
    assert.match(COMPUTER_USE_DELIVERY_HINTS.unverifiable, /先截一张图（computer_screenshot）/);
  });

  // partial 现在有真实产出路径（SendInput 只插入部分事件）。正文仍然不能引用
  // evidence.detail（模型看不见那个字段），但必须点名 computer_screenshot 与「不要原样重放」。
  test("partial 不说 evidence.detail，且给出下一步（先截图、别原样整条重放）", () => {
    assert.doesNotMatch(COMPUTER_USE_DELIVERY_HINTS.partial, /evidence/);
    assert.match(COMPUTER_USE_DELIVERY_HINTS.partial, /剩下的/);
    assert.match(COMPUTER_USE_DELIVERY_HINTS.partial, /computer_screenshot/);
    assert.match(COMPUTER_USE_DELIVERY_HINTS.partial, /不要原样重放/);
  });

  test("COMPUTER_USE_NO_EVIDENCE_HINT：说清「这个后端拿不到读回」且点名 computer_screenshot", () => {
    assert.ok(COMPUTER_USE_NO_EVIDENCE_HINT.trim().length > 0);
    assert.match(COMPUTER_USE_NO_EVIDENCE_HINT, /拿不到任何读回/);
    assert.match(COMPUTER_USE_NO_EVIDENCE_HINT, /computer_screenshot/);
    // 它不是五档之一：别把它塞进 COMPUTER_USE_DELIVERY_HINTS（那是**按档位**的一句话）
    assert.equal(
      Object.values(COMPUTER_USE_DELIVERY_HINTS).includes(COMPUTER_USE_NO_EVIDENCE_HINT.trim()),
      false,
    );
  });
});

describe("应用级准入契约（桥 0.11.0 的观察模式）", () => {
  test("正常回执：四个字段读出来，targetPid 缺席也不假造", () => {
    assert.deepEqual(
      parseComputerUseAdmission({ admission: "bypassed", targetExe: "notepad.exe", targetPid: 400 }),
      { admission: "bypassed", targetExe: "notepad.exe", targetPid: 400 },
    );
    assert.deepEqual(parseComputerUseAdmission({ admission: "owned", targetExe: "msedge.exe" }), {
      admission: "owned",
      targetExe: "msedge.exe",
    });
  });

  test("老桥 / 缺字段 / 不认识的 verdict 一律当没有（不让新值静默流进 UI）", () => {
    assert.equal(parseComputerUseAdmission({ ok: true }), null);
    assert.equal(parseComputerUseAdmission({ admission: "trusted", targetExe: "x.exe" }), null);
    assert.equal(parseComputerUseAdmission({ admission: 1, targetExe: "x.exe" }), null);
    // targetExe 不是字符串就回空串（verdict 本身仍然是有效信息）
    assert.deepEqual(parseComputerUseAdmission({ admission: "unknown" }), { admission: "unknown", targetExe: "" });
  });

  test("四个 verdict 是契约：桥、宿主、将来要拒的模式都认这同一张表", () => {
    assert.deepEqual([...COMPUTER_USE_ADMISSION_VERDICTS], ["owned", "allowlisted", "bypassed", "unknown"]);
  });

  test("exe 名规范化：末段、小写、只认 .exe；坏值 null", () => {
    assert.equal(normalizeGuestAppName(" Notepad.EXE "), "notepad.exe");
    assert.equal(normalizeGuestAppName(String.raw`C:\Windows\System32\calc.exe`), "calc.exe");
    assert.equal(normalizeGuestAppName("C:/Tools/app.exe"), "app.exe");
    assert.equal(normalizeGuestAppName("notepad"), null);
    assert.equal(normalizeGuestAppName(".exe"), null);
    assert.equal(normalizeGuestAppName("we ird.exe"), null);
  });

  test("下发白名单 = 内置四个浏览器 exe ∪ 用户项（规范化去重、默认在前）", () => {
    assert.deepEqual([...COMPUTER_USE_DEFAULT_ALLOWED_APPS], ["msedge.exe", "chrome.exe", "brave.exe", "chromium.exe"]);
    assert.deepEqual(mergeGuestAllowExe(undefined), ["msedge.exe", "chrome.exe", "brave.exe", "chromium.exe"]);
    assert.deepEqual(mergeGuestAllowExe([]), ["msedge.exe", "chrome.exe", "brave.exe", "chromium.exe"]);
    assert.deepEqual(mergeGuestAllowExe(["notepad.exe", "MSEDGE.EXE", "bad", "calc.exe"]), [
      "msedge.exe",
      "chrome.exe",
      "brave.exe",
      "chromium.exe",
      "notepad.exe",
      "calc.exe",
    ]);
    // 用户项是**追加**：写一个已经在默认里的名字不该重复，也不该把它提到前面
    assert.deepEqual(mergeGuestAllowExe(["chrome.exe"]), ["msedge.exe", "chrome.exe", "brave.exe", "chromium.exe"]);
  });
});

/** 一张「遮了、清单新鲜、刚拍时没人打字」的基准 capture，各用例只改关心的那个字段 */
const masked: ComputerUseCaptureInfo = {
  maskedRegions: 1,
  maskListed: true,
  maskStale: false,
  maskCacheAgeMs: 900,
  userTyping: false,
};

describe("captureNote（截图回执里那句「遮了 / 没遮」）", () => {
  test("遮了：告诉模型那块黑是有意的、密码不该进上下文", () => {
    const note = captureNote(masked);
    assert.match(note, /1 password field in this image was blacked out/);
    assert.match(note, /black block is deliberate/);
    // 模型要知道下一步：要密码就问用户，而不是去读黑块
    assert.match(note, /ask the user/);
    assert.doesNotMatch(note, /NOT masked/);
  });

  test("遮了多块：复数写法（回执语法错了模型会读歪）", () => {
    const note = captureNote({ ...masked, maskedRegions: 3 });
    assert.match(note, /3 password fields in this image were blacked out/);
  });

  test("清单过期：**必须明说没遮**，并给出「重新 list 再截图」的下一步", () => {
    const note = captureNote({ ...masked, maskedRegions: 0, maskListed: false, maskStale: true, maskCacheAgeMs: 42_000 });
    assert.match(note, /WARNING: this image is NOT masked/);
    // 年龄要说清（模型据此判断「多久之前的事」），并且点名过期线
    assert.match(note, /42s old/);
    assert.match(note, /30s/);
    assert.match(note, /computer_uia list on that window again/);
  });

  test("从没 list 过：也明说没遮，并说清它现在能做什么", () => {
    const old = captureNote({ ...masked, maskedRegions: 0, maskListed: false, maskStale: false, maskCacheAgeMs: -1 });
    assert.match(old, /WARNING: this image is NOT masked/);
    assert.match(old, /nothing has been listed with computer_uia yet/);
    assert.match(old, /Run computer_uia list on that window first/);
  });

  test("看过而且没有密码框：不吓人，但**一定要带桌面车道的声明**", () => {
    // 旧版本这里一个字都不添。现在不行了：「一块都没遮」恰恰是“页面把密码翻成明文”的样子
    // （IsPassword=false → 0 块），模型必须知道这条车道看不见那种框、网页要用 sandbox_screenshot。
    // 但不能带 WARNING / NOT masked 那种吓人的话：清单是新的，没没遮。
    const note = captureNote({ ...masked, maskedRegions: 0 });
    assert.match(note, /desktop lane/);
    assert.match(note, /show password/);
    assert.match(note, /sandbox_screenshot/);
    assert.doesNotMatch(note, /WARNING/);
    assert.doesNotMatch(note, /blacked out/);
  });

  test("老桥不报 capture：不添话、也不编造「已遮」", () => {
    assert.equal(captureNote(undefined), "");
  });

  test("用户在打字：添一句「你看到的可能已经过时」（用户优先的既有语义）", () => {
    const note = captureNote({ ...masked, maskedRegions: 0, userTyping: true });
    assert.match(note, /A person was typing in the sandbox/);
    assert.match(note, /out of date/);
  });

  test("过期线与桥的 CacheMaxAgeMs 同一个数（C# 与 TS 各一份，改了这里会红）", () => {
    assert.equal(COMPUTER_USE_MASK_CACHE_MAX_AGE_MS, 30_000);
  });
});

/** 一张「检查 3 帧、盖住 2 个字段、没有漏掉的帧」的基准回执 */
const shotMasked: ComputerUseShotMask = {
  fieldsCovered: 2,
  framesChecked: 3,
  framesCovered: 3,
  missing: [],
  missingTotal: 0,
};
/** 同一份东西在**回执里**的样子（宿主按桥的字段名取值，两套名字不能混） */
const shotResp = {
  maskFieldsCovered: 2,
  maskFramesChecked: 3,
  maskFramesCovered: 3,
  maskMissing: [] as string[],
  maskMissingTotal: 0,
};

describe("computerUseMaskLabel（overlay 上那行字跟界面语言走）", () => {
  test("中文界面：中文标签", () => {
    assert.equal(computerUseMaskLabel("zh"), "已遮罩");
  });

  test("英文界面：英文标签", () => {
    assert.equal(computerUseMaskLabel("en"), "Masked");
  });

  test("语言缺失 / 不认识：按英文（与 effectiveLanguage 的 en 兜底、桥的默认值一致）", () => {
    assert.equal(computerUseMaskLabel(undefined), "Masked");
    assert.equal(computerUseMaskLabel(""), "Masked");
    assert.equal(computerUseMaskLabel("ja"), "Masked");
  });
});

describe("computerUseShotMask（网页截图遮罩回执的解析）", () => {
  test("老桥没有这几个字段 → undefined（不能说遮了，也不能说没遮）", () => {
    assert.equal(computerUseShotMask({ ok: true, width: 1 }), undefined);
  });

  test("门槛字段是 maskFieldsCovered：负数 / 非数字都不认", () => {
    assert.equal(computerUseShotMask({ maskFieldsCovered: -1 }), undefined);
    assert.equal(computerUseShotMask({ maskFieldsCovered: "2" }), undefined);
  });

  test("缺帧数按 0、缺清单按空数组（宁可少说，不可编）", () => {
    assert.deepEqual(computerUseShotMask({ maskFieldsCovered: 1 }), {
      fieldsCovered: 1,
      framesChecked: 0,
      framesCovered: 0,
      missing: [],
      missingTotal: 0,
    });
  });

  test("清单只收非空字符串、每条截到 160 字、最多 8 条", () => {
    const many = Array.from({ length: 12 }, (_, i) => `https://f${i}/ — 没遮上`);
    const mask = computerUseShotMask({ maskFieldsCovered: 0, maskMissing: [...many, "  ", 42] });
    assert.equal(mask?.missing.length, 8);
    assert.match(mask?.missing[0] ?? "", /^https:\/\/f0\//);
    const long = computerUseShotMask({ maskFieldsCovered: 0, maskMissing: ["x".repeat(400)] });
    assert.equal(long?.missing[0]?.length, 160);
  });

  test("missingTotal：桥给的为准；缺字段时按数组长度兜底，且不小于列出来的条数", () => {
    assert.equal(computerUseShotMask({ maskFieldsCovered: 0, maskMissing: ["a — x"], maskMissingTotal: 9 })?.missingTotal, 9);
    assert.equal(computerUseShotMask({ maskFieldsCovered: 0, maskMissing: ["a — x"] })?.missingTotal, 1);
    assert.equal(computerUseShotMask({ maskFieldsCovered: 0, maskMissingTotal: 0 })?.missingTotal, 0);
  });

  test("字段原样取回；maskError 空白时不带这个键", () => {
    assert.deepEqual(computerUseShotMask({ ...shotResp }), shotMasked);
    assert.deepEqual(computerUseShotMask({ ...shotResp, maskError: "  " }), shotMasked);
    assert.match(
      computerUseShotMask({ ...shotResp, maskMissing: ["https://pay/ — attach 失败"], maskError: "attach 失败" })
        ?.error ?? "",
      /attach/,
    );
  });
});

describe("computerUseShotMaskNote（给模型的那一句实话）", () => {
  test("两组数字都要出现：checked N frames, covered M password fields", () => {
    const note = computerUseShotMaskNote(shotMasked);
    assert.match(note, /checked 3 frames/);
    assert.match(note, /covered 2 password fields/);
    assert.doesNotMatch(note, /could not reach/);
  });

  test("一块都没有但都检查过：说清检查了几帧，不说「遮住了」", () => {
    const note = computerUseShotMaskNote({ ...shotMasked, fieldsCovered: 0 });
    assert.match(note, /checked 3 frames and found no password field to cover/);
    assert.doesNotMatch(note, /covered 0/);
  });

  test("有没到的帧：**逐条点名**，并说明那里面的东西在图里是可见的", () => {
    const note = computerUseShotMaskNote({
      ...shotMasked,
      fieldsCovered: 1,
      missing: ["https://pay.example/ — attachToTarget 没有回 sessionId", "(帧 1A2B3C4D) — 没有可用的执行上下文"],
    });
    assert.match(note, /could not reach/);
    assert.match(note, /https:\/\/pay\.example\//);
    assert.match(note, /1A2B3C4D/);
    assert.match(note, /visible in this image/);
  });

  test("桥给了整体原因就带上（模型要知道是「没设备」还是「没去」）", () => {
    const note = computerUseShotMaskNote({ ...shotMasked, error: "目标浏览器未就绪" });
    assert.match(note, /The bridge said: 目标浏览器未就绪/);
  });

  test("**零帧被检查**时不许说「没有密码字段」：这张图没被检查过", () => {
    // 预算闸把整轮跳过：framesChecked=0 却说「checked 0 frames and found no password field」
    // 就是把「没检查」说成了「检查过且干净」——模型会据此相信图里没有明文。
    const note = computerUseShotMaskNote({
      fieldsCovered: 0,
      framesChecked: 0,
      framesCovered: 0,
      missing: [],
      missingTotal: 0,
      error: "时间预算不足（剩 3000ms），这张没遮",
    });
    assert.match(note, /skipped the password-field check/);
    assert.match(note, /has not been checked for password fields/);
    assert.doesNotMatch(note, /found no password field/);
    assert.match(note, /时间预算不足/); // 原因照带，模型知道下次可以重试
  });

  test("清单被截断时说清「还有 N 条未列」（读者不会以为列全了）", () => {
    const note = computerUseShotMaskNote({
      ...shotMasked,
      fieldsCovered: 1,
      missing: ["https://a/ — 没遮上", "https://b/ — 没遮上"],
      missingTotal: 5,
    });
    assert.match(note, /and 3 more not listed/);
  });

  test("一帧没到且零字段：中性说「covered no password field」，不下「没有密码字段」的结论", () => {
    const note = computerUseShotMaskNote({
      ...shotMasked,
      fieldsCovered: 0,
      missing: ["https://pay/ — attach 失败"],
      missingTotal: 1,
    });
    assert.match(note, /covered no password field/);
    assert.doesNotMatch(note, /found no password field/);
  });

  test("老桥（undefined）一个字都不添", () => {
    assert.equal(computerUseShotMaskNote(undefined), "");
  });
});

describe("computerUseAudit（审计载荷的唯一工厂）", () => {
  test("四个基础字段：action / args / at / inputOrigin", () => {
    const audit = computerUseAudit("click", { x: 1, y: 2 }, 1234);
    assert.deepEqual(audit, { action: "click", args: { x: 1, y: 2 }, at: 1234, inputOrigin: "agent" });
  });

  test("不传时刻就用当下（调用点不必各写一遍 Date.now）", () => {
    const before = Date.now();
    const audit = computerUseAudit("type", { text: "hi" });
    assert.ok(audit.at >= before && audit.at <= Date.now());
  });

  test("sandbox 写件与 UIA 用同一份形状（三段代码拼三份字段就会漂）", () => {
    assert.equal(computerUseAudit("sandbox-click", { selector: "#a" }).inputOrigin, "agent");
    assert.equal(computerUseAudit("uia-act", { action: "invoke", ref: 1 }).inputOrigin, "agent");
  });
});

/**
 * 「关掉出网」这个设置在三个后端上能不能兑现（backendNetworkControl）。
 *
 * 为什么单独一条：这是「设置骗人」的唯一判定点。提示词、失败文案、设置页置灰都读它，
 * 判定错了三处会一起说谎；而两只眼睛看不出来——同一条 `.wsb` / `-netdev` 参数不会报错。
 */
describe("backendNetworkControl（这只后端能不能真的断网）", () => {
  test("wsb：能——.wsb 的 <Networking>Disable</Networking>（关掉就是真没有出网）", () => {
    assert.equal(backendNetworkControl("wsb"), "enforced");
  });

  test("qemu：能——`-netdev user` 的 restrict=on（hostfwd 照通，桌面通道不受影响）", () => {
    assert.equal(backendNetworkControl("qemu"), "enforced");
  });

  test("isolation-session：做不到——它在用户自己这台机器的另一个登录会话里（MXC 文档：cannot restrict networking）", () => {
    assert.equal(backendNetworkControl("isolation-session"), "not-enforceable");
  });

  test("三个后端都有明确结论，没有漏表态的（将来加后端会在这里显形）", () => {
    for (const backend of ["wsb", "isolation-session", "qemu"] as const) {
      assert.ok(["enforced", "not-enforceable"].includes(backendNetworkControl(backend)), backend);
    }
  });
});

/**
 * 电脑使用的唯一判据（2026-11-27 验收后）：这一条会话、这一轮，用户能不能看到并回答
 * 那个授权提问。两件事一起判——会话身份（子会话 / 幕后 / 未 promoted 的自动化会话）
 * 与这一轮是谁发起的（this_session 自动化会把一轮投回用户的会话）。
 */
describe("computerUseConsentTexts —— 给模型的固定文本跟界面语言走（2026-11-28 验收 P2-1）", () => {
  test("zh：与原来那几句一字不差（老用户看到的没变）", () => {
    const zh = computerUseConsentTexts("zh");
    assert.equal(zh.denied, "用户拒绝了电脑操作，本会话不要再请求");
    assert.match(zh.stopped, /这一轮已停止/);
    assert.match(zh.mainSessionOnly, /只在主会话里可用/);
    assert.match(zh.unattended, /不是你手动发起的/);
  });

  test("en：四句都是英文、语义等价（英文界面下不再夹中文）", () => {
    const en = computerUseConsentTexts("en");
    assert.match(en.denied, /^The user denied computer actions\./);
    assert.equal(en.denied, "The user denied computer actions. Do not request them again in this session.");
    assert.match(en.stopped, /^This turn was stopped/);
    assert.match(en.mainSessionOnly, /^Computer use is only available in the main session/);
    assert.match(en.unattended, /^This turn was not started by the user/);
    for (const text of Object.values(en)) assert.doesNotMatch(text, /[一-鿿]/, text);
  });

  test("超时 / 没人回答那条：不能说成「用户拒绝了」（2026-11-28 验收顺手项）", () => {
    const zh = computerUseConsentTexts("zh");
    const en = computerUseConsentTexts("en");
    // 两份都要点明「没有人明确拒绝」，否则模型会转告用户「你拒绝了」
    assert.match(zh.deniedUnanswered, /用户没有明确拒绝/);
    assert.match(zh.deniedUnanswered, /没有收到用户的回答/);
    assert.match(en.deniedUnanswered, /the user did not explicitly deny it/i);
    // 与「用户拒绝」那句必须不同（同一句就没有意义了）
    assert.notEqual(zh.deniedUnanswered, zh.denied);
    assert.notEqual(en.deniedUnanswered, en.denied);
  });

  test("认不出的语言（含缺省）按英文：与界面 locale 的 en 兜底一致", () => {
    assert.deepEqual(computerUseConsentTexts(undefined), computerUseConsentTexts("en"));
    assert.deepEqual(computerUseConsentTexts("fr"), computerUseConsentTexts("en"));
  });
});

describe("computerUseBlockedReason —— 用户此刻能不能看到并回答", () => {
  test("普通会话 + 用户手点：能问（null）", () => {
    assert.equal(computerUseBlockedReason({}, "user"), null);
  });

  test("子会话 / 幕后会话：主会话专用（身份那条先挡）", () => {
    assert.equal(computerUseBlockedReason({ parentId: "p" }, "user"), "main-session-only");
    assert.equal(computerUseBlockedReason({ backstage: "avatar" }, "channel"), "main-session-only");
  });

  test("自动化新开的会话（automationId）不 promoted：主会话专用；用户点了转成普通会话（promoted）：按普通会话问", () => {
    assert.equal(computerUseBlockedReason({ automationId: "au1" }, "user"), "main-session-only");
    assert.equal(computerUseBlockedReason({ automationId: "au1", promoted: true }, "user"), null);
  });

  test("主会话但这一轮是自动化发起的（this_session）：不弹提问，说清「请在主会话里手动发起」", () => {
    assert.equal(computerUseBlockedReason({}, "automation"), "unattended");
    // promoted 的自动化会话也一样：会话看得见，但这一轮不是用户发起的
    assert.equal(computerUseBlockedReason({ automationId: "au1", promoted: true }, "automation"), "unattended");
    // 编排投递同理（子会话在身份那条已经挡了，这里只是不为 machine-origin 开口子）
    assert.equal(computerUseBlockedReason({}, "channel"), "unattended");
  });
});
