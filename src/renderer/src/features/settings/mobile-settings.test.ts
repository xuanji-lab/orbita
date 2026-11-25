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
  isStaleDevice,
  needsInterfaceName,
  newlyPaired,
  STALE_DEVICE_MS,
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

/** 一节文案摊平成一段字：函数文案代入一个占位参数（数字参数的拿到 "X" 也照样拼得出句子） */
function copyText(copy: object): string {
  const flat = (value: unknown): unknown =>
    typeof value === "function" ? (value as (arg: string) => unknown)("X") : value !== null && typeof value === "object" ? Object.values(value).map(flat) : value;
  return JSON.stringify(Object.values(copy).map(flat));
}

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

  test("设备的动作叫「移除」，不叫「撤销」（「撤销」在本应用里是 undo），确认条两钮是「移除」「保留」", () => {
    const copy = zh.settings.mobile;
    assert.equal(copy.remove, "移除…");
    assert.equal(copy.removeAsk("iPad mini"), "移除「iPad mini」？");
    assert.equal(copy.removeAction, "移除");
    assert.equal(copy.removeKeep, "保留");
    const all = copyText(copy);
    assert.ok(!all.includes("撤销"), "手机页文案里不该再有「撤销」");
  });

  test("用户看得到的文案不露实现词：放行、监听、密钥库、keyring、主机私钥", () => {
    const copy = zh.settings.mobile;
    const all = copyText(copy);
    for (const word of ["放行", "监听", "密钥库", "keyring", "主机私钥", "手机服务"]) {
      assert.ok(!all.includes(word), `手机页文案里出现了「${word}」`);
    }
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

  test("网卡名只在同类地址不止一个时才需要写", () => {
    const [tailscale, lan] = candidates;
    assert.ok(tailscale && lan);
    assert.equal(needsInterfaceName(lan, candidates), false);
    const twoLans = [...candidates, { address: "10.0.0.15", kind: "private" as const, interfaceName: "en5" }];
    assert.equal(needsInterfaceName(lan, twoLans), true);
    assert.equal(needsInterfaceName(tailscale, twoLans), false);
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

  test("很久没用：不在线、最近一次连上（没连过按配对时间）早于 30 天前", () => {
    const now = 100 * STALE_DEVICE_MS;
    const old = now - STALE_DEVICE_MS - 1;
    assert.equal(isStaleDevice(device("a", { lastSeenAt: old }), now), true);
    assert.equal(isStaleDevice(device("b", { lastSeenAt: now - STALE_DEVICE_MS }), now), false);
    assert.equal(isStaleDevice(device("c", { pairedAt: old, lastSeenAt: null }), now), true);
    assert.equal(isStaleDevice(device("d", { pairedAt: now - 1_000, lastSeenAt: null }), now), false);
    // 此刻在线的哪怕记录旧也不算
    assert.equal(isStaleDevice(device("e", { lastSeenAt: old, connected: true }), now), false);
  });

  test("端口输入：1–65535 的整数才收", () => {
    assert.equal(parsePortInput(" 47620 "), 47620);
    assert.equal(parsePortInput("0"), null);
    assert.equal(parsePortInput("65536"), null);
    assert.equal(parsePortInput("80.5"), null);
    assert.equal(parsePortInput(""), null);
  });
});
