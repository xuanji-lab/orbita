/**
 * 指针输入（qemu-rfb.ts）的单测：一个假 RFB 服务，验握手与 PointerEvent 的字节。
 *
 * 为什么值得单测：这是唯一的**指针**通道，菜单能不能点开全靠它（XTEST 那条路点不开，
 * 见 qemu-rfb.ts 头注释）。字节错一位（掩码、大小端、坐标顺序）的后果是「点在了别处」
 * 而回执照旧成功——这种错不写测试就只能靠肉眼发现。
 */
import assert from "node:assert/strict";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { VncPointer } from "./qemu-rfb.ts";

interface PointerEvent {
  mask: number;
  x: number;
  y: number;
}

interface FakeServer {
  port: number;
  events: PointerEvent[];
  /** 客户端选认证之后收到的字节（用来验 ClientInit 的 shared 位） */
  clientInit: number[];
  close: () => Promise<void>;
}

/** 一个只做 RFB 3.8 + None 认证、只解析 PointerEvent 的假服务 */
async function startFakeRfb(options: { securityTypes?: number[] } = {}): Promise<FakeServer> {
  const events: PointerEvent[] = [];
  const clientInit: number[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    /** 握手阶段的状态机：等待的字节数 + 收到后做什么 */
    let stage: "version" | "auth" | "client-init" | "stream" = "version";
    socket.write(Buffer.from("RFB 003.008\n", "ascii"));

    const pump = (): void => {
      for (;;) {
        if (stage === "version") {
          if (buffer.length < 12) return;
          buffer = buffer.subarray(12);
          const types = options.securityTypes ?? [1];
          socket.write(Buffer.from([types.length, ...types]));
          stage = "auth";
          continue;
        }
        if (stage === "auth") {
          if (buffer.length < 1) return;
          socket.write(Buffer.from([0, 0, 0, 0])); // SecurityResult: ok
          buffer = buffer.subarray(1);
          stage = "client-init";
          continue;
        }
        if (stage === "client-init") {
          if (buffer.length < 1) return;
          clientInit.push(buffer[0] ?? 0);
          buffer = buffer.subarray(1);
          const head = Buffer.alloc(24);
          head.writeUInt16BE(1280, 0);
          head.writeUInt16BE(800, 2);
          head.writeUInt32BE(4, 20); // 名字长度
          socket.write(Buffer.concat([head, Buffer.from("test", "ascii")]));
          stage = "stream";
          continue;
        }
        // 之后是客户端消息流：0=SetPixelFormat(20) 2=SetEncodings(4+4n) 5=PointerEvent(6) 4=KeyEvent(8)
        if (buffer.length < 1) return;
        const type = buffer[0];
        if (type === 0) {
          if (buffer.length < 20) return;
          buffer = buffer.subarray(20);
          continue;
        }
        if (type === 2) {
          if (buffer.length < 4) return;
          const count = buffer.readUInt16BE(2);
          const size = 4 + count * 4;
          if (buffer.length < size) return;
          buffer = buffer.subarray(size);
          continue;
        }
        if (type === 5) {
          if (buffer.length < 6) return;
          events.push({ mask: buffer[1] ?? 0, x: buffer.readUInt16BE(2), y: buffer.readUInt16BE(4) });
          buffer = buffer.subarray(6);
          continue;
        }
        if (type === 4) {
          if (buffer.length < 8) return;
          buffer = buffer.subarray(8);
          continue;
        }
        // 不认识的客户端消息：断开，免得卡在这里（真服务也会因为流错位断）
        socket.destroy();
        return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(typeof address === "object" && address !== null);
  return {
    port: address.port,
    events,
    clientInit,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("VncPointer：指针输入走 Xvnc 的设备", () => {
  let server: FakeServer;

  before(async () => {
    server = await startFakeRfb();
  });

  after(async () => {
    await server.close();
  });

  it("握手：None 认证 + shared；ServerInit 的尺寸被读出来", async () => {
    const pointer = await VncPointer.connect(server.port);
    assert.equal(pointer.width, 1280);
    assert.equal(pointer.height, 800);
    assert.deepEqual(server.clientInit.slice(-1), [1]);
    pointer.close();
  });

  it("单击：先落位置（掩码 0）再按下抬起，坐标按像素原样发", async () => {
    const pointer = await VncPointer.connect(server.port);
    server.events.length = 0;
    await pointer.click(60, 12);
    pointer.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const masks = server.events.map((event) => event.mask);
    assert.equal(masks[0], 0, "第一次必须是移动（Xvnc 下第一个绝对坐标 + 立刻按下会丢 enter）");
    assert.ok(masks.includes(1), "要有左键按下");
    assert.equal(masks.at(-1), 0, "最后必须抬起");
    for (const event of server.events) {
      assert.deepEqual({ x: event.x, y: event.y }, { x: 60, y: 12 });
    }
  });

  it("右键用掩码 4，中键用 2（不是 1）", async () => {
    const pointer = await VncPointer.connect(server.port);
    server.events.length = 0;
    await pointer.click(10, 20, { button: "right" });
    await pointer.click(10, 20, { button: "middle" });
    pointer.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const masks = server.events.map((event) => event.mask);
    assert.ok(masks.includes(4));
    assert.ok(masks.includes(2));
    assert.ok(!masks.includes(1));
  });

  it("双击：两对按下抬起（间隔要短于系统双击阈值）", async () => {
    const pointer = await VncPointer.connect(server.port);
    server.events.length = 0;
    await pointer.click(55, 65, { double: true });
    pointer.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const downs = server.events.filter((event) => event.mask === 1);
    assert.equal(downs.length, 2);
  });

  it("滚轮：向下 = 掩码 16，向上 = 掩码 8，按格数重复", async () => {
    const pointer = await VncPointer.connect(server.port);
    server.events.length = 0;
    await pointer.scroll(100, 100, 2);
    await pointer.scroll(100, 100, -1);
    pointer.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const masks = server.events.map((event) => event.mask);
    assert.equal(masks.filter((mask) => mask === 16).length, 2);
    assert.equal(masks.filter((mask) => mask === 8).length, 1);
  });

  it("服务端只给 VNC 认证时：连不上要明说，不要静默发事件", async () => {
    const vncOnly = await startFakeRfb({ securityTypes: [2] });
    try {
      await assert.rejects(VncPointer.connect(vncOnly.port), /None 认证/);
    } finally {
      await vncOnly.close();
    }
  });
});
