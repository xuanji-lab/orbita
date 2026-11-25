import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { NetworkInterfaceInfo } from "node:os";
import { bindCandidatesOf } from "./net.ts";

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: null };
}
function v6(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: "ffff:ffff::", family: "IPv6", mac: "00:00:00:00:00:00", internal, cidr: null, scopeid: 0 };
}

describe("可绑地址的枚举", () => {
  test("Tailscale 排最前，其后私网，回环最后；公网不列；IPv6 不列；去重", () => {
    const candidates = bindCandidatesOf({
      en0: [v4("192.168.1.5"), v6("fe80::1"), v4("8.8.8.8"), v4("192.168.1.5")],
      utun5: [v4("100.64.3.7")],
      lo0: [v4("127.0.0.1"), v6("::1")],
      "en1: legacy-number-family": [{ ...v4("10.0.0.2"), family: 4 as unknown as "IPv4" }],
    });
    assert.deepEqual(
      candidates.map((candidate) => candidate.address),
      ["100.64.3.7", "192.168.1.5", "10.0.0.2", "127.0.0.1"],
    );
    assert.deepEqual(
      candidates.map((candidate) => candidate.kind),
      ["tailscale", "private", "private", "loopback"],
    );
  });

  test("172.16–172.31 算私网；172.32 与 11.x 不列", () => {
    const candidates = bindCandidatesOf({
      a: [v4("172.16.0.1"), v4("172.31.0.1"), v4("172.32.0.1"), v4("11.0.0.1")],
    });
    assert.deepEqual(candidates.map((c) => c.address), ["172.16.0.1", "172.31.0.1"]);
  });
});
