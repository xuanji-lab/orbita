import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseSettings, galaxyBatterySaverOf } from "../../../../shared/settings.ts";
import { dustKeepUnderPower, powerNoticeDue, powerSaveOf } from "./power-save.ts";

describe("离电省电档", () => {
  test("离电 → 省电，插电 → 恢复；开关关掉时离电也不省", () => {
    const enabled = galaxyBatterySaverOf(parseSettings({}));
    assert.equal(enabled, true, "缺席 = 开");
    // 一串真实顺序：开机接电 → 拔电 → 插电 → 关掉开关 → 再拔电
    const steps: [boolean, boolean, boolean][] = [
      [false, true, false],
      [true, true, true],
      [false, true, false],
      [false, false, false],
      [true, false, false],
    ];
    for (const [onBattery, on, expected] of steps) assert.equal(powerSaveOf({ onBattery, enabled: on }), expected, `电池 ${onBattery} · 开关 ${on}`);
  });

  test("提示只出一次：第一次进省电档出，记下之后再离电不出；没进省电档不出", () => {
    let seen = false;
    const shown: boolean[] = [];
    for (const saving of [false, true, false, true, true]) {
      const due = powerNoticeDue(saving, seen);
      shown.push(due);
      if (due) seen = true;
    }
    assert.deepEqual(shown, [false, true, false, false, false]);
  });

  test("省电档碎石带不显示，不省电时照设置的密度", () => {
    assert.equal(dustKeepUnderPower(0.5, true), 0);
    assert.equal(dustKeepUnderPower(0.5, false), 0.5);
    assert.equal(dustKeepUnderPower(1, false), 1);
  });
});
