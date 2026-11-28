import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmergencyStop,
  EMERGENCY_STOP_ACCELERATOR,
  EMERGENCY_STOP_ACCELERATORS,
  type EmergencyStopDeps,
} from "./emergency-stop.ts";

/** `results` 按调用次序给出每条候选的结果：true / false / "throw"（缺的按 false） */
function harness(results: Array<boolean | "throw">) {
  const registered: string[] = [];
  const unregistered: string[] = [];
  const pressedBy: Array<{ accelerator: string; callback: () => void }> = [];
  let triggers = 0;
  let call = 0;
  const deps: EmergencyStopDeps = {
    register: (accelerator, callback) => {
      const result = results[call] ?? false;
      call += 1;
      registered.push(accelerator);
      if (result === "throw") throw new Error("Invalid accelerator");
      if (result) pressedBy.push({ accelerator, callback });
      return result;
    },
    unregister: (accelerator) => {
      unregistered.push(accelerator);
    },
    onTrigger: () => {
      triggers += 1;
    },
  };
  return {
    deps,
    registered,
    unregistered,
    press: () => pressedBy.at(-1)?.callback(),
    triggerCount: () => triggers,
  };
}

describe("急停热键", () => {
  test("注册成功：状态如实报「已注册」，键位是主选 Control+Alt+Shift+Escape", () => {
    const h = harness([true]);
    const stop = createEmergencyStop(h.deps);
    assert.deepEqual(stop.status(), {
      accelerator: EMERGENCY_STOP_ACCELERATOR,
      preferred: EMERGENCY_STOP_ACCELERATOR,
      registered: true,
      error: null,
    });
    assert.equal(EMERGENCY_STOP_ACCELERATOR, "Control+Alt+Shift+Escape");
    assert.deepEqual(h.registered, [EMERGENCY_STOP_ACCELERATOR]);
  });

  test("候选表：三条、互不相同、都是三修饰键（撞车面小）", () => {
    assert.equal(EMERGENCY_STOP_ACCELERATORS.length, 3);
    assert.equal(new Set(EMERGENCY_STOP_ACCELERATORS).size, 3);
    for (const accelerator of EMERGENCY_STOP_ACCELERATORS) {
      assert.match(accelerator, /^Control\+.*\+/);
      assert.doesNotMatch(accelerator, /^Alt\+F4|Win/i);
    }
  });

  test("按下热键调到 onTrigger", () => {
    const h = harness([true]);
    createEmergencyStop(h.deps);
    h.press();
    assert.equal(h.triggerCount(), 1);
  });

  test("主选被占用 → 降级到第二个候选：生效的是它，且如实标出主选", () => {
    const h = harness([false, true]);
    const stop = createEmergencyStop(h.deps);
    const status = stop.status();
    assert.equal(status.registered, true);
    assert.equal(status.accelerator, EMERGENCY_STOP_ACCELERATORS[1]);
    assert.equal(status.preferred, EMERGENCY_STOP_ACCELERATORS[0]);
    assert.equal(status.error, null);
    assert.deepEqual(h.registered, [EMERGENCY_STOP_ACCELERATORS[0], EMERGENCY_STOP_ACCELERATORS[1]]);
    h.press();
    assert.equal(h.triggerCount(), 1, "按下回调来自成功的那条");
    stop.dispose();
    assert.deepEqual(h.unregistered, [EMERGENCY_STOP_ACCELERATORS[1]], "只注销成功的那条");
  });

  test("前两条抛错 / 被占用、第三条成功：照样有保护", () => {
    const h = harness(["throw", false, true]);
    const stop = createEmergencyStop(h.deps);
    assert.equal(stop.status().registered, true);
    assert.equal(stop.status().accelerator, EMERGENCY_STOP_ACCELERATORS[2]);
  });

  test("全失败：registered=false，文案列出试过的组合并给出下一步", () => {
    const h = harness([false, false, false]);
    const stop = createEmergencyStop(h.deps);
    const status = stop.status();
    assert.equal(status.registered, false);
    for (const accelerator of EMERGENCY_STOP_ACCELERATORS) {
      assert.ok((status.error ?? "").includes(accelerator), accelerator);
    }
    assert.match(status.error ?? "", /重启/);
    assert.equal(status.accelerator, EMERGENCY_STOP_ACCELERATORS[0], "全失败时回主选（「本该是它」）");
    stop.dispose();
    assert.deepEqual(h.unregistered, []);
  });

  test("dispose 只注销注册成功的那次；失败时什么都不做", () => {
    const ok = harness([true]);
    createEmergencyStop(ok.deps).dispose();
    assert.deepEqual(ok.unregistered, [EMERGENCY_STOP_ACCELERATOR]);

    const failed = harness([false, false, false]);
    createEmergencyStop(failed.deps).dispose();
    assert.deepEqual(failed.unregistered, []);
  });
});
