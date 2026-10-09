import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { NetworkInterfaceInfo } from "node:os";
import { findHostBindIp, HostServer, normalizeRemoteAddress, type GuestRegistration, type ListInterfaces } from "./host-server.ts";

function v4(address: string, internal = false): NetworkInterfaceInfo {
  return { address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal, cidr: `${address}/24` };
}

function v6(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal,
    scopeid: 0,
    cidr: `${address}/64`,
  };
}

describe("findHostBindIp", () => {
  test("优先 vEthernet (Windows Sandbox NAT)，无视物理网卡", () => {
    const list: ListInterfaces = () => ({
      Ethernet: [v4("192.168.1.5")],
      "vEthernet (Windows Sandbox NAT)": [v4("172.27.160.1")],
    });
    assert.deepEqual(findHostBindIp(list), { name: "vEthernet (Windows Sandbox NAT)", ip: "172.27.160.1" });
  });

  test("没有 sandbox 命名的 vEthernet 时退回第一个 vEthernet 的 IPv4", () => {
    const list: ListInterfaces = () => ({
      "vEthernet (Default Switch)": [v6("fe80::1"), v4("172.20.0.1")],
      "Loopback Pseudo-Interface": [v4("127.0.0.1", true)],
    });
    assert.deepEqual(findHostBindIp(list), { name: "vEthernet (Default Switch)", ip: "172.20.0.1" });
  });

  test("没有 vEthernet（或只有 internal / IPv6）→ null", () => {
    assert.equal(findHostBindIp(() => ({ Ethernet: [v4("192.168.1.5")] })), null);
    assert.equal(findHostBindIp(() => ({ "vEthernet (X)": [v4("127.0.0.1", true), v6("fe80::2")] })), null);
    assert.equal(findHostBindIp(() => ({})), null);
  });
});

describe("normalizeRemoteAddress", () => {
  test("剥 IPv6-mapped 前缀；普通地址原样", () => {
    assert.equal(normalizeRemoteAddress("::ffff:172.16.0.1"), "172.16.0.1");
    assert.equal(normalizeRemoteAddress("172.16.0.2"), "172.16.0.2");
    assert.equal(normalizeRemoteAddress(undefined), "");
  });
});

describe("HostServer", () => {
  async function listenOn(server: HostServer): Promise<number> {
    await server.listen("127.0.0.1");
    const address = server.address();
    assert(address !== null, "服务应已监听");
    return address.port;
  }

  test("register：token 对 → 200 {ok:true}，回调拿到来源 IP 与 guest 端口", async () => {
    const registrations: GuestRegistration[] = [];
    const server = new HostServer({ hostPort: 0, token: "tok123", onRegister: (r) => registrations.push(r) });
    try {
      const port = await listenOn(server);
      const response = await fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { authorization: "Bearer tok123" },
        body: JSON.stringify({ port: 52741 }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.deepEqual(registrations, [{ ip: "127.0.0.1", port: 52741 }]);
    } finally {
      server.close();
    }
  });

  test("鉴权：没带 token / token 不对 → 401，且回调不被调用", async () => {
    const registrations: GuestRegistration[] = [];
    const server = new HostServer({ hostPort: 0, token: "tok123", onRegister: (r) => registrations.push(r) });
    try {
      const port = await listenOn(server);
      const noAuth = await fetch(`http://127.0.0.1:${port}/register`, { method: "POST", body: "{}" });
      assert.equal(noAuth.status, 401);
      const wrongAuth = await fetch(`http://127.0.0.1:${port}/register`, {
        method: "POST",
        headers: { authorization: "Bearer nope" },
        body: "{}",
      });
      assert.equal(wrongAuth.status, 401);
      assert.deepEqual(registrations, []);
    } finally {
      server.close();
    }
  });

  test("路由与载荷：非 /register 或非 POST → 404；坏 JSON / 非法端口 → 400", async () => {
    const registrations: GuestRegistration[] = [];
    const server = new HostServer({ hostPort: 0, token: "tok123", onRegister: (r) => registrations.push(r) });
    const post = (path: string, body: string): Promise<Response> =>
      fetch(`http://127.0.0.1:${server.address()?.port}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer tok123" },
        body,
      });
    try {
      const port = await listenOn(server);
      const get = await fetch(`http://127.0.0.1:${port}/register`, {
        headers: { authorization: "Bearer tok123" },
      });
      assert.equal(get.status, 404);
      const wrongPath = await post("/other", "{}");
      assert.equal(wrongPath.status, 404);
      const badJson = await post("/register", "不是 JSON");
      assert.equal(badJson.status, 400);
      const badPort = await post("/register", JSON.stringify({ port: 70000 }));
      assert.equal(badPort.status, 400);
      assert.deepEqual(registrations, []);
    } finally {
      server.close();
    }
  });

  test("close 幂等；raw node http 客户端走 ::ffff: 也能归一化", async () => {
    const registrations: GuestRegistration[] = [];
    const server = new HostServer({ hostPort: 0, token: "tok123", onRegister: (r) => registrations.push(r) });
    const port = await listenOn(server);
    server.close();
    server.close();
    assert.equal(server.address(), null);
    assert.deepEqual(registrations, []);
    assert.ok(port > 0);
  });

  test("用 node:http 真客户端验证 remoteAddress 归一化（IPv4 栈）", async () => {
    const registrations: GuestRegistration[] = [];
    const server = new HostServer({ hostPort: 0, token: "tok123", onRegister: (r) => registrations.push(r) });
    try {
      const port = await listenOn(server);
      await new Promise<void>((resolve, reject) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/register", method: "POST", headers: { authorization: "Bearer tok123" } },
          (res) => {
            void res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ port: 1234 }));
      });
      assert.deepEqual(registrations, [{ ip: "127.0.0.1", port: 1234 }]);
    } finally {
      server.close();
    }
  });
});
