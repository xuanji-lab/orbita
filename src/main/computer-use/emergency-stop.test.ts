import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createEmergencyStop,
  EMERGENCY_STOP_ACCELERATOR,
  type EmergencyStopDeps,
} from "./emergency-stop.ts";

function harness(registerResult: boolean | "throw") {
  const registered: string[] = [];
  const unregistered: string[] = [];
  let pressed: (() => void) | null = null;
  let triggers = 0;
  const deps: EmergencyStopDeps = {
    register: (accelerator, callback) => {
      if (registerResult === "throw") throw new Error("Invalid accelerator");
      registered.push(accelerator);
      pressed = callback;
      return registerResult;
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
    press: () => pressed?.(),
    triggerCount: () => triggers,
  };
}

describe("急停热键", () => {
  test("注册成功：状态如实报「已注册」，键位是 Control+Alt+Shift+Escape", () => {
    const h = harness(true);
    const stop = createEmergencyStop(h.deps);
    assert.deepEqual(stop.status(), {
      accelerator: EMERGENCY_STOP_ACCELERATOR,
      registered: true,
      error: null,
    });
    assert.equal(EMERGENCY_STOP_ACCELERATOR, "Control+Alt+Shift+Escape");
    assert.deepEqual(h.registered, [EMERGENCY_STOP_ACCELERATOR]);
  });

  test("按下热键调到 onTrigger", () => {
    const h = harness(true);
    createEmergencyStop(h.deps);
    h.press();
    assert.equal(h.triggerCount(), 1);
  });

  test("被占用（register 返回 false）：registered=false 且有给用户看的原因", () => {
    const h = harness(false);
    const stop = createEmergencyStop(h.deps);
    const status = stop.status();
    assert.equal(status.registered, false);
    assert.match(status.error ?? "", /占用|Ctrl|Control/i);
  });

  test("register 抛错（非法键位）也变成可见状态，不让应用启动失败", () => {
    const h = harness("throw");
    const stop = createEmergencyStop(h.deps);
    assert.equal(stop.status().registered, false);
    assert.equal(stop.status().error, "Invalid accelerator");
  });

  test("dispose 只注销注册成功的那次；失败时什么都不做", () => {
    const ok = harness(true);
    createEmergencyStop(ok.deps).dispose();
    assert.deepEqual(ok.unregistered, [EMERGENCY_STOP_ACCELERATOR]);

    const failed = harness(false);
    createEmergencyStop(failed.deps).dispose();
    assert.deepEqual(failed.unregistered, []);
  });
});
