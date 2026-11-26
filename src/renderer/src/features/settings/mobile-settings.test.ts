import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { MobileDevice } from "../../../../shared/mobile.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import {
  bindView,
  formatCountdown,
  groupPairingCode,
  newlyPaired,
  offerSecondsLeft,
  parsePortInput,
  sortDevices,
} from "./mobile-settings.ts";
import { SETTINGS_TABS } from "./settings-tabs.ts";

const device = (id: string, patch: Partial<MobileDevice> = {}): MobileDevice => ({
  id,
  name: id,
  pairedAt: 1_000,
  lastSeenAt: null,
  connected: false,
  ...patch,
});

describe("设置 › 手机：页签登记", () => {
  test("「手机」页签在、图标走 FEATURE_ICON，中英都有名字", () => {
    const tab = SETTINGS_TABS.find((entry) => entry.id === "mobile");
    assert.ok(tab);
    assert.equal(tab.icon, FEATURE_ICON.mobile);
    assert.equal(zh.settings.tabs.mobile, "手机");
    assert.equal(en.settings.tabs.mobile, "Phone");
  });

  test("配对码的有效期写的是 3 分钟（安全审查要求，不是设计稿的 5 分钟）", () => {
    assert.ok(zh.settings.mobile.pairInfo.includes("3 分钟"));
    assert.ok(!zh.settings.mobile.pairInfo.includes("5 分钟"));
    assert.ok(en.settings.mobile.pairInfo.includes("3 minutes"));
  });
});

describe("设置 › 手机：倒计时与配对码", () => {
  test("剩余秒数向上取整，过期后是 0 不是负数", () => {
    assert.equal(offerSecondsLeft(10_000, 0), 10);
    assert.equal(offerSecondsLeft(10_000, 9_001), 1);
    assert.equal(offerSecondsLeft(10_000, 10_000), 0);
    assert.equal(offerSecondsLeft(10_000, 99_000), 0);
  });

  test("m:ss，秒补零", () => {
    assert.equal(formatCountdown(180), "3:00");
    assert.equal(formatCountdown(161), "2:41");
    assert.equal(formatCountdown(5), "0:05");
    assert.equal(formatCountdown(-3), "0:00");
  });

  test("6 位码 3 + 3 分组，别的形状原样", () => {
    assert.equal(groupPairingCode("042917"), "042 917");
    assert.equal(groupPairingCode("12345"), "12345");
  });
});

describe("设置 › 手机：绑定地址的处境", () => {
  const candidates = [
    { address: "100.101.7.4", kind: "tailscale" as const, interfaceName: "utun5" },
    { address: "192.168.1.20", kind: "private" as const, interfaceName: "en0" },
  ];

  test("没选地址是 null", () => {
    assert.equal(bindView({ bind: null, candidates }), null);
  });

  test("在候选里：带上类别与网卡名，不算缺", () => {
    assert.deepEqual(bindView({ bind: { address: "192.168.1.20", port: 47620 }, candidates }), {
      address: "192.168.1.20",
      port: 47620,
      kind: "private",
      interfaceName: "en0",
      missing: false,
    });
  });

  test("地址此刻不在本机：如实标缺，类别按地址本身认，不换成别的候选", () => {
    const view = bindView({ bind: { address: "100.88.1.2", port: 47620 }, candidates });
    assert.equal(view?.address, "100.88.1.2");
    assert.equal(view?.kind, "tailscale");
    assert.equal(view?.missing, true);
    assert.equal(view?.interfaceName, null);
  });
});

describe("设置 › 手机：设备", () => {
  test("在线的在前，其余按最近连上（没连过按配对时间）从新到旧", () => {
    const sorted = sortDevices([
      device("old", { lastSeenAt: 2_000 }),
      device("never", { pairedAt: 5_000 }),
      device("online", { connected: true, lastSeenAt: 100 }),
      device("recent", { lastSeenAt: 9_000 }),
    ]);
    assert.deepEqual(sorted.map((entry) => entry.id), ["online", "recent", "never", "old"]);
  });

  test("配上的新设备：只认生成配对码之前不在的，多台取最新配对的", () => {
    const before = new Set(["a"]);
    assert.equal(newlyPaired(before, [device("a")]), null);
    assert.equal(newlyPaired(before, [device("a"), device("b", { pairedAt: 3 }), device("c", { pairedAt: 9 })])?.id, "c");
  });

  test("端口输入：1–65535 的整数才收", () => {
    assert.equal(parsePortInput(" 47620 "), 47620);
    assert.equal(parsePortInput("0"), null);
    assert.equal(parsePortInput("65536"), null);
    assert.equal(parsePortInput("80.5"), null);
    assert.equal(parsePortInput(""), null);
  });
});
