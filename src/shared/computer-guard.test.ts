import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  COMPUTER_USE_HARD_LIMIT,
  COMPUTER_USE_REPEAT_LIMIT,
  COMPUTER_USE_SOFT_LIMIT,
  COMPUTER_USE_TURN_DEADLINE_MS,
  countNearbyClicks,
  describeComputerUseRisk,
  judgeComputerUseBudget,
  normalizeComputerKey,
} from "./computer-guard.ts";

describe("computer-guard —— D1 组合键黑名单", () => {
  test("归一化：大小写 / 空白 / 顺序都折到同一个键", () => {
    assert.equal(normalizeComputerKey("Alt+F4"), "alt+f4");
    assert.equal(normalizeComputerKey(" ctrl + shift + esc "), "ctrl+esc+shift");
    assert.equal(normalizeComputerKey("ESC"), "esc");
    assert.equal(normalizeComputerKey(""), "");
  });

  test("命中黑名单：关窗 / 切窗 / 锁屏 / 运行框 / 任务管理器", () => {
    for (const key of ["alt+f4", "ALT+F4", "ctrl+w", "Ctrl+Shift+W", "alt+tab", "win+d", "win+l", "win+r", "ctrl+shift+esc", "shift+delete"]) {
      const risk = describeComputerUseRisk({ tool: "computer_key", args: { key } });
      assert.notEqual(risk, null, `${key} 应命中`);
      assert.equal(risk?.level, "confirm");
      assert.equal(risk?.rule, "key");
    }
  });

  test("顺序不同的同一组合键同样命中（shift+ctrl+esc）", () => {
    const risk = describeComputerUseRisk({ tool: "computer_key", args: { key: "shift+ctrl+esc" } });
    assert.equal(risk?.rule, "key");
    assert.equal(risk?.detail, "ctrl+esc+shift");
  });

  test("普通按键不命中：enter / escape / ctrl+a / f1", () => {
    for (const key of ["enter", "escape", "ctrl+a", "f1", "tab", "ctrl+shift+s", "shift+tab"]) {
      assert.equal(describeComputerUseRisk({ tool: "computer_key", args: { key } }), null, `${key} 不该命中`);
    }
  });

  test("非字符串 / 缺 key：不命中，也不抛", () => {
    assert.equal(describeComputerUseRisk({ tool: "computer_key", args: {} }), null);
    assert.equal(describeComputerUseRisk({ tool: "computer_key", args: { key: 42 } }), null);
  });
});

describe("computer-guard —— D2 破坏词", () => {
  test("命中：format / diskpart / shutdown / 批量删除 / 递归删除 / 删账户", () => {
    const samples = [
      "format c: /q",
      "diskpart",
      "shutdown /s /t 0",
      "shutdown /r",
      "del /f /s /q C:\\Users",
      "rmdir /s C:\\data",
      "rd /s /q C:\\data",
      "powershell Remove-Item C:\\data -Recurse -Force",
      "cipher /w:C:",
      "reg delete HKLM\\Software\\X /f",
      "net user alice /delete",
      "taskkill /PID 1234 /F",
    ];
    for (const text of samples) {
      const risk = describeComputerUseRisk({ tool: "computer_type", args: { text } });
      assert.notEqual(risk, null, `「${text}」应命中`);
      assert.equal(risk?.rule, "command");
    }
  });

  test("大小写不敏感，跨在命令前后缀里也命中", () => {
    assert.equal(describeComputerUseRisk({ tool: "computer_type", args: { text: "FORMAT D:" } })?.rule, "command");
    assert.equal(
      describeComputerUseRisk({ tool: "computer_type", args: { text: "cmd /c \"shutdown /s\"" } })?.rule,
      "command",
    );
  });

  test("不命中：普通输入 / 带 del 的英文单词 / 只说 disk", () => {
    for (const text of [
      "hello world",
      "https://example.com/delete?x=1",
      "the model is a delta of the previous one",
      "disk usage is high",
      "deliver the package",
      "format this paragraph nicely",
      "shutdown -h now", // 不是 Windows 的 /s /r 写法；沙箱是 Windows
    ]) {
      assert.equal(describeComputerUseRisk({ tool: "computer_type", args: { text } }), null, `「${text}」不该命中`);
    }
  });

  test("只有多行文本里出现破坏词也命中", () => {
    const text = "echo start\nformat d: /q\necho done";
    assert.equal(describeComputerUseRisk({ tool: "computer_type", args: { text } })?.rule, "command");
  });
});

describe("computer-guard —— D3 同点连点", () => {
  test("计数半径：≤4px 算同一点，>4px 不算", () => {
    const clicks = [
      { x: 100, y: 100 },
      { x: 104, y: 96 }, // 与 (100,100) 各差 4：算
      { x: 105, y: 100 }, // 差 5：不算
    ];
    assert.equal(countNearbyClicks(clicks, 100, 100), 2);
    assert.equal(countNearbyClicks(clicks, 200, 200), 0);
    assert.equal(countNearbyClicks([], 10, 10), 0);
  });

  test(`第 ${COMPUTER_USE_REPEAT_LIMIT} 次起命中，前 ${COMPUTER_USE_REPEAT_LIMIT - 1} 次不命中`, () => {
    for (let prior = 0; prior < COMPUTER_USE_REPEAT_LIMIT - 1; prior += 1) {
      assert.equal(
        describeComputerUseRisk({ tool: "computer_click", args: { x: 100, y: 100 }, priorSamePointClicks: prior }),
        null,
        `此前 ${prior} 次不该命中`,
      );
    }
    const risk = describeComputerUseRisk({
      tool: "computer_click",
      args: { x: 100, y: 100 },
      priorSamePointClicks: COMPUTER_USE_REPEAT_LIMIT - 1,
    });
    assert.equal(risk?.rule, "repeat");
    assert.equal(risk?.detail, String(COMPUTER_USE_REPEAT_LIMIT));
    assert.equal(risk?.level, "confirm");
  });

  test("缺省历史 = 0，单击永远不命中", () => {
    assert.equal(describeComputerUseRisk({ tool: "computer_click", args: { x: 1, y: 2 } }), null);
  });
});

describe("computer-guard —— 不参与判定的工具", () => {
  test("screenshot / scroll / 未知工具一律 null（截图无输入，滚动不落点）", () => {
    assert.equal(describeComputerUseRisk({ tool: "computer_screenshot", args: {} }), null);
    assert.equal(describeComputerUseRisk({ tool: "computer_scroll", args: { deltaY: 5 } }), null);
    assert.equal(describeComputerUseRisk({ tool: "bash", args: { command: "format c:" } }), null);
  });
});

describe("computer-guard —— 预算两级（按轮重置的边界）", () => {
  const now = 1_000_000;

  test(`第 ${COMPUTER_USE_SOFT_LIMIT} 次仍放行，第 ${COMPUTER_USE_SOFT_LIMIT + 1} 次是软限`, () => {
    assert.deepEqual(judgeComputerUseBudget({ count: COMPUTER_USE_SOFT_LIMIT - 1, startedAt: now, now }), {
      level: "ok",
    });
    const soft = judgeComputerUseBudget({ count: COMPUTER_USE_SOFT_LIMIT, startedAt: now, now });
    assert.equal(soft.level, "soft");
    if (soft.level === "soft") assert.match(soft.message, /budget/i);
  });

  test(`第 ${COMPUTER_USE_HARD_LIMIT} 次仍是软限，第 ${COMPUTER_USE_HARD_LIMIT + 1} 次硬限（次数）`, () => {
    const atHardEdge = judgeComputerUseBudget({ count: COMPUTER_USE_HARD_LIMIT - 1, startedAt: now, now });
    assert.equal(atHardEdge.level, "soft");

    const hard = judgeComputerUseBudget({ count: COMPUTER_USE_HARD_LIMIT, startedAt: now, now });
    assert.equal(hard.level, "hard");
    if (hard.level === "hard") {
      assert.equal(hard.reason, "count");
      assert.match(hard.message, /interrupted/i);
    }
  });

  test("20 分钟边界：差 1ms 仍放行，正好到线即硬限（时长优先于次数）", () => {
    const startedAt = now - (COMPUTER_USE_TURN_DEADLINE_MS - 1);
    assert.equal(judgeComputerUseBudget({ count: 0, startedAt, now }).level, "ok");

    const hard = judgeComputerUseBudget({ count: 0, startedAt: now - COMPUTER_USE_TURN_DEADLINE_MS, now });
    assert.equal(hard.level, "hard");
    if (hard.level === "hard") assert.equal(hard.reason, "time");
  });

  test("还没开始（startedAt = null）只按次数判，不会因为 now 很大就超时", () => {
    assert.equal(judgeComputerUseBudget({ count: 0, startedAt: null, now: Number.MAX_SAFE_INTEGER }).level, "ok");
  });

  test("count 是「已尝试」的次数：同一 count 反复判得到同一结论（推进计数是闸门的事）", () => {
    const soft = judgeComputerUseBudget({ count: COMPUTER_USE_SOFT_LIMIT, startedAt: now, now });
    assert.equal(soft.level, "soft");
    // 纯函数只认输入：同一个 count 判多少次都是 soft；闸门每次尝试才把 count 推进 1
    for (let i = 0; i < 100; i += 1) {
      assert.equal(judgeComputerUseBudget({ count: COMPUTER_USE_SOFT_LIMIT, startedAt: now, now }).level, "soft");
    }
  });
});
