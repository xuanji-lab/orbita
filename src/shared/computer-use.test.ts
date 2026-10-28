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
  COMPUTER_USE_DISPATCHED_HINT,
  COMPUTER_USE_MASK_CACHE_MAX_AGE_MS,
  COMPUTER_USE_SHOT_MAX_WIDTH,
  COMPUTER_USE_UIA_TIMEOUT_MS,
  captureNote,
  computerUseAudit,
  computerUseChannels,
  computerUseUiaErrors,
  isUiaFocusRequest,
  isUiaRequest,
  isWindowScreenshotRequest,
  mergeGuestAllowExe,
  normalizeGuestAppName,
  parseComputerUseAdmission,
  parseComputerUseDelivery,
  screenshotPointToNative,
  type ComputerUseToolRequest,
  type ComputerUseCaptureInfo,
} from "./computer-use.ts";

/** 回图 1280×720，物理屏 2560×1440（长边缩一半的常见情形） */
const scaled = { width: 1280, height: 720, nativeWidth: 2560, nativeHeight: 1440 };

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
    assert.equal(isUiaRequest({ action: "uia-act", perform: "invoke", ref: 3 }), true);
    assert.equal(isUiaRequest({ action: "uia-act", perform: "setValue", name: "Search", value: "orbita" }), true);
    assert.equal(isUiaRequest({ action: "uia-act", perform: "selection", ref: 3 }), true);
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
    assert.equal(isUiaFocusRequest({ action: "uia-act", perform: "invoke", ref: 2 }), false);
    assert.equal(isUiaFocusRequest({ action: "uia-act", perform: "setValue", name: "Search", value: "x" }), false);
    assert.equal(isUiaFocusRequest({ action: "uia-act", perform: "selection", ref: 2 }), false);
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

// ── 像素输入的交付语义（三档）─────────────────────────────────────────

describe("parseComputerUseDelivery", () => {
  test("三档各自认对：applied / dispatched / failed 原样返回", () => {
    assert.equal(parseComputerUseDelivery("applied"), "applied");
    assert.equal(parseComputerUseDelivery("dispatched"), "dispatched");
    assert.equal(parseComputerUseDelivery("failed"), "failed");
  });

  test("缺字段 / 不认识的档位 / 非字符串一律 undefined（不猜，不当成成功）", () => {
    for (const raw of [undefined, null, "", "Applied", "ok", 1, true, {}, []]) {
      assert.equal(parseComputerUseDelivery(raw), undefined, String(raw));
    }
  });

  test("dispatched 的口径说清楚了两件事：无法确认生效 + 不要立刻重放（先截图）", () => {
    assert.match(COMPUTER_USE_DISPATCHED_HINT, /dispatched/);
    assert.match(COMPUTER_USE_DISPATCHED_HINT, /no evidence it took effect/);
    assert.match(COMPUTER_USE_DISPATCHED_HINT, /do not replay/);
    assert.match(COMPUTER_USE_DISPATCHED_HINT, /computer_screenshot/);
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

  test("看过而且没有密码框：一个字都不添（正常截图的文案不能被这一刀改掉）", () => {
    assert.equal(captureNote({ ...masked, maskedRegions: 0 }), "");
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
