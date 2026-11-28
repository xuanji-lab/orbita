import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { computerUseUiTexts } from "../../shared/computer-use-texts.ts";
import { guestErrorText, guestNoteText, hasCjk } from "./bridge-error-text.ts";

/**
 * guest 桥中文错误 → 英文界面（2026-11-28）。
 *
 * 守两层：
 *   1. **样本层**：从 `guest-bridge/` 里逐字抄来的常见错误，英文界面下必须是完整英文句、
 *      不含 CJK，并且给出下一步；中文界面原样返回。
 *   2. **全量层（源头守卫）**：直接扫 `guest-bridge/*.cs` 里所有会进回执的中文字面串，
 *      断言每一条经过映射后都不含 CJK。别人往 C# 里加一句新的中文错误，这条测试立刻覆盖它
 *      ——不需要谁记得回来补样本。
 */

/** 逐字抄自 guest-bridge 的常见错误（行号写在注释里，改桥时好回溯） */
const SAMPLES: ReadonlyArray<{ source: string; raw: string }> = [
  // Program.cs：像素车道的失败
  { source: "Program.cs 截图失败", raw: "截图失败：The handle is invalid." },
  // Cdp.cs NavErrorMessage：导航没打开
  {
    source: "Cdp.cs 页面没有加载",
    raw:
      "页面没有加载：net::ERR_INTERNET_DISCONNECTED（沙箱可能没有出网、宿主机没联网，或这个地址不可达）。" +
      "确认方式：换一个一定能打开的地址试一次；如果所有站点都是这个错，那是网络的问题，不是这一页的问题。" +
      "仍要操作当前界面时改用 computer_screenshot / computer_click 像素工具。",
  },
  // Cdp.cs Click
  {
    source: "Cdp.cs 选择器没匹配到可见元素",
    raw: "选择器「#submit」在页面上没有匹配到可见元素。重新 sandbox_observe 看当前页面结构，用它给的 selector；页面导航后旧选择器可能已失效",
  },
  // Cdp.cs Upload
  { source: "Cdp.cs 沙箱里看不到这个文件", raw: "沙箱里看不到这个文件：C:\\orbita-out\\upload\\a.pdf（映射目录可能还没同步完，稍等重试）" },
  // Cdp.cs 浏览器额度
  { source: "Cdp.cs 浏览器名额定满", raw: "沙箱里同时最多 4 个浏览器，先 cdp-stop 一个再开新的（不用的实例在空闲 5 分钟后自动回收）" },
  // WorkerHost.cs：通道挂了
  { source: "WorkerHost.cs 通道意外退出", raw: "沙箱里的浏览器通道意外退出（0 没有回执），这个会话的下一条命令会自动重新拉起" },
  // WorkerHost.cs / Cdp.cs：浏览器没在运行
  { source: "Cdp.cs 浏览器没有在运行", raw: "沙箱里的 Edge 没有在运行（或已经退出）" },
  // Uia.cs：控件树拿不到
  {
    source: "Uia.cs 控件树读不到",
    raw: "读不到这个窗口的控件树（FindAll HRESULT 0x80131505）——它可能不是标准窗口，改用 computer_screenshot 看一眼",
  },
  // Uia.cs：ref 失效
  { source: "Uia.cs ref 失效", raw: "g12:r3 指向的控件已经不在了——重新 list 再动作。" },
  // WinShot.cs：按窗口截图拍不到
  { source: "WinShot.cs 窗口拍不到", raw: "这个窗口拍不到（PrintWindow 返回空图）——改用整桌面截图或 computer_screenshot" },
  // Program.cs：SendInput 被拒
  {
    source: "Program.cs 错误码 5",
    raw: "错误码 5 = 拒绝访问：系统拒绝了这次注入——沙箱会话可能还没就绪或已经失效，先截图确认沙箱状态，再决定重试还是重启沙箱",
  },
  // Program.cs：参数校验
  { source: "Program.cs button 非法", raw: "button 只能是 left / right / middle，收到：super" },
];

describe("guest 桥错误：常见样本在两种界面语言下", () => {
  for (const sample of SAMPLES) {
    test(`${sample.source}：英文界面是完整英文句、不含 CJK`, () => {
      const english = guestErrorText(sample.raw, "en", () => {});
      assert.ok(english.trim() !== "");
      assert.equal(hasCjk(english), false, `英文产物里还有中文：${english}`);
      // 完整句子：首字母大写、以句号收尾
      assert.match(english, /^[A-Z]/, english);
      assert.match(english, /[.!]$/, english);
      // 认得出的样本必须是「映射过的英文」，不能是兜底句（否则等于没映射）
      assert.notEqual(english, computerUseUiTexts("en").guestErrorGeneric);
    });

    test(`${sample.source}：中文界面原样返回`, () => {
      assert.equal(guestErrorText(sample.raw, "zh", () => {}), sample.raw);
    });
  }

  test("映射覆盖：样本里认得出来的比例（低于这条线说明规则退化了）", () => {
    let mapped = 0;
    for (const sample of SAMPLES) {
      const english = guestErrorText(sample.raw, "en", () => {});
      if (!english.startsWith("The sandbox reported an error")) mapped += 1;
    }
    assert.equal(mapped, SAMPLES.length, `只映射了 ${mapped}/${SAMPLES.length} 条样本`);
  });
});

describe("guest 桥错误：兜底（永不漏的那一条）", () => {
  test("没见过的中文错误 → 英文通用句，原文不在返回值里", () => {
    const raw = "某个以后才会加的错误：桥里炸了";
    const english = guestErrorText(raw, "en", () => {});
    assert.equal(english, computerUseUiTexts("en").guestErrorGeneric);
    assert.equal(english.includes(raw), false);
    assert.equal(hasCjk(english), false);
  });

  test("兜底时原文进日志（细节不丢，只是不上界面）", () => {
    const raw = "某个以后才会加的错误：桥里炸了";
    const logged: string[] = [];
    guestErrorText(raw, "en", (message) => logged.push(message));
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? "", new RegExp(raw.slice(0, 6)));
  });

  test("兜底句保留网络错误码（那是「为什么打不开」的证据，networkFailureError 还要用）", () => {
    const english = guestErrorText("页面打不开 net::ERR_CONNECTION_RESET 原因不明", "en", () => {});
    assert.equal(english, computerUseUiTexts("en").guestErrorGenericCode("net::ERR_CONNECTION_RESET"));
    assert.match(english, /ERR_CONNECTION_RESET/);
    assert.equal(hasCjk(english), false);
  });

  test("本来就是英文的串一个字都不动（映射是幂等的）", () => {
    const english = "The browser is not running. Start it again.";
    assert.equal(guestErrorText(english, "en", () => {}), english);
    const mapped = guestErrorText("截图失败：boom", "en", () => {});
    assert.equal(guestErrorText(mapped, "en", () => {}), mapped);
  });
});

describe("guest 桥成功回执里的 note（SendInput 只送进去一部分）", () => {
  // 逐字抄自 Program.cs 的 PartialNote()
  const note =
    "SendInput 只插入了 2/5 个事件（差 3 个），剩下的没有送出去；已补发松开(microsoft、ctrl)——" +
    "先截图确认现在的状态，再决定要不要重做（不要原样重放同一个动作）。";

  test("英文界面：给一句英文，带数量与「别原样重放」，不含 CJK", () => {
    const english = guestNoteText(note, "en", () => {});
    assert.match(english, /2 of 5/);
    assert.match(english, /do not replay the same action/i);
    assert.equal(hasCjk(english), false);
  });

  test("中文界面原样；认不出的 note 在英文界面下丢掉（不是必需信息）", () => {
    assert.equal(guestNoteText(note, "zh", () => {}), note);
    const dropped: string[] = [];
    assert.equal(guestNoteText("一句没人见过的话", "en", (m) => dropped.push(m)), "");
    assert.equal(dropped.length, 1);
  });
});

// ── 全量层：直接扫 C# 源头 ─────────────────────────────────────────────

const BRIDGE_DIR = join(import.meta.dirname, "..", "..", "..", "guest-bridge");

/**
 * 从 C# 源码里抠出「会进回执」的中文字面串。
 *
 * 判据与 `guest-error-text` 的职责一致：`"error":` / `.Str("error"` / `Fail(` / `NavErrorMessage(`
 * 附近的串算回执；`Log(...)` / `Console` 附近的算日志（日志保持中文，不在这条守卫的范围里）。
 */
function receiptStringsInBridgeSources(): Array<{ file: string; line: number; text: string; starter: boolean }> {
  const found: Array<{ file: string; line: number; text: string; starter: boolean }> = [];
  const literal = /(?<!\$)@?"((?:[^"\\]|\\.)*)"/g;
  const errorContext = /"error"\s*:|Str\("error"|Fail\(|NavErrorMessage|TooManyMessage|PartialNote/;
  const logContext = /\bLog\(|WriteLog|Console\./;
  /** 「一条消息的开头」：字面串前面紧跟着 Fail( / NavErrorMessage( / .Str("error", / = " 这些 */
  const starterBefore = /(?:Fail\(|NavErrorMessage\(|TooManyMessage\(|Str\("error",\s*|= |: |return )\s*$/;
  for (const file of readdirSync(BRIDGE_DIR).filter((name) => name.endsWith(".cs"))) {
    const raw = readFileSync(join(BRIDGE_DIR, file), "utf8");
    const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, (match) => "\n".repeat(match.split("\n").length - 1));
    const lines = withoutBlockComments.split("\n");
    lines.forEach((line, index) => {
      const code = line.split("//")[0] ?? "";
      let match: RegExpExecArray | null;
      literal.lastIndex = 0;
      while ((match = literal.exec(code)) !== null) {
        const text = match[1] ?? "";
        if (!hasCjk(text)) continue;
        const window = lines.slice(Math.max(0, index - 4), index + 1).join("\n");
        if (!errorContext.test(window)) continue;
        if (logContext.test(window.split("\n").pop() ?? "")) continue;
        found.push({ file, line: index + 1, text, starter: starterBefore.test(code.slice(0, match.index)) });
      }
    });
  }
  return found;
}

describe("源头守卫：guest-bridge 里所有进回执的中文串，英文界面下都不许留 CJK", () => {
  const corpus = receiptStringsInBridgeSources();

  test("扫到了东西（否则这条守卫是空的）", () => {
    assert.ok(corpus.length >= 40, `只扫到 ${corpus.length} 条，守卫可能失效了`);
    console.log(`[守卫] 进回执的中文字面串：${corpus.length} 条`);
  });

  test("逐条过映射：英文产物不含 CJK、也不为空", () => {
    const leaks: string[] = [];
    for (const item of corpus) {
      const english = guestErrorText(item.text, "en", () => {});
      if (hasCjk(english)) leaks.push(`${item.file}:${item.line} → ${english}`);
      if (english.trim() === "") leaks.push(`${item.file}:${item.line} → 空串`);
    }
    assert.deepEqual(leaks, []);
  });

  test("映射覆盖率：一条消息的**开头**要认得出来（拼接碎片与自测标签不参与统计）", () => {
    // C# 里很多错误是 `Fail("头：" + 变量 + "尾")` 拼出来的，字面串会被拆成碎片；运行时到达
    // 宿主的永远是拼好的整句。所以覆盖率只在「消息开头」上统计——碎片只要求「不漏中文」。
    const starters = corpus.filter((item) => item.starter && item.text.length >= 6);
    const fallbackPrefix = computerUseUiTexts("en").guestErrorGeneric.slice(0, 20);
    const mapped = starters.filter((item) => !guestErrorText(item.text, "en", () => {}).startsWith(fallbackPrefix));
    const ratio = mapped.length / Math.max(1, starters.length);
    console.log(`[守卫] 消息开头映射：${mapped.length}/${starters.length}`);
    assert.ok(ratio >= 0.85, `消息开头只映射了 ${mapped.length}/${starters.length}（${Math.round(ratio * 100)}%）`);
  });
});
