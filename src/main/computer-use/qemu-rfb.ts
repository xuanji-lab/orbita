/**
 * L3 的**指针输入**：走 guest 里 Xvnc 自己的 RFB 设备，不走 xdotool。
 *
 * 为什么不用 xdotool 的 XTEST 注入（这是本仓踩过的真坑，别再改回去）：
 * XTEST 造出来的按键事件在 GTK 眼里是**二等公民**。实测（P3-3，同一台 VM、同一个坐标）：
 *   - 点按钮 / 图标 / 侧栏条目：XTEST 能用；
 *   - **点菜单栏（Xvnc 的 File、面板的 Applications）：菜单闪一下就关**——GTK 把「开启菜单
 *     的那一次 press 之后到来的 release」认成「点在菜单外」，于是立刻收起。压/放间隔
 *     从 1ms 到 500ms 全试过，稳定复现；反过来按住不放时菜单是在的（证明 press 生效了）。
 * 而 P3-2 用 RFB 走同一条链（Applications → System → Terminal）是通的，画面还能截图。
 * 差别就在设备：RFB 事件由 Xvnc 作为**它自己的输入设备**注入，与真鼠标同级，grab 语义正常。
 *
 * 所以这里只做一件事：**指针**（移动 / 按键 / 滚轮）。键盘与打字仍走 guest 的 CGI
 * （xdotool type/key 实测可用，且它替我们处理了任意 Unicode 与组合键名），截图与 shell 同理。
 * 一个后端两条通道是有点别扭，但这是「按原语的语义选通道」，而不是按方便选。
 *
 * 协议只用到输入部分：握手（None 认证）→ 之后只发 PointerEvent（type 5）。
 * 不请求 FramebufferUpdate，所以服务端不会推画面；进来的一切字节都丢掉。
 */
import net from "node:net";

/** RFB 的按钮掩码：bit0 左、bit1 中、bit2 右、bit3 滚轮上、bit4 滚轮下 */
const BUTTON_MASK = { left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16 } as const;

export type VncButton = "left" | "middle" | "right";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class ByteReader {
  #buffer = Buffer.alloc(0);
  #waiters: { size: number; resolve: (buffer: Buffer) => void }[] = [];
  #closed = false;

  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#flush();
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(Buffer.alloc(0));
  }

  #flush(): void {
    while (this.#waiters.length > 0) {
      const next = this.#waiters[0];
      if (next === undefined || this.#buffer.length < next.size) return;
      const head = this.#buffer.subarray(0, next.size);
      this.#buffer = this.#buffer.subarray(next.size);
      this.#waiters.shift();
      next.resolve(head);
    }
  }

  async read(size: number): Promise<Buffer> {
    if (this.#buffer.length >= size) {
      const head = this.#buffer.subarray(0, size);
      this.#buffer = this.#buffer.subarray(size);
      return head;
    }
    if (this.#closed) throw new Error("RFB 连接已断开");
    return new Promise<Buffer>((resolve) => {
      this.#waiters.push({ size, resolve });
      this.#flush();
    });
  }
}

/**
 * 一条只发输入的 RFB 连接。**每条命令自己建连**（几毫秒）：常驻连接会在 VM 重启、
 * 桌面重启之后变成一条死管道，而那时点击会「成功」地打在空气上——宁可慢一点，不可静默错。
 */
export class VncPointer {
  readonly #socket: net.Socket;
  readonly #reader: ByteReader;
  readonly width: number;
  readonly height: number;

  private constructor(socket: net.Socket, reader: ByteReader, width: number, height: number) {
    this.#socket = socket;
    this.#reader = reader;
    this.width = width;
    this.height = height;
  }

  static async connect(port: number, timeoutMs = 8_000): Promise<VncPointer> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.connect({ host: "127.0.0.1", port });
      const timer = setTimeout(() => {
        candidate.destroy();
        reject(new Error(`连不上 guest 的 RFB（127.0.0.1:${port}）`));
      }, timeoutMs);
      candidate.once("connect", () => {
        clearTimeout(timer);
        resolve(candidate);
      });
      candidate.once("error", (cause) => {
        clearTimeout(timer);
        reject(cause);
      });
    });
    const reader = new ByteReader();
    // 握手之后一律不理服务端说的东西：我们不请求画面，所以也没有画面要来。
    socket.on("data", (chunk: Buffer) => reader.push(chunk));
    socket.on("close", () => reader.close());
    socket.on("error", () => reader.close());

    const send = (buffer: Buffer): void => {
      socket.write(buffer);
    };
    try {
      const version = (await reader.read(12)).toString("ascii");
      if (!version.startsWith("RFB ")) throw new Error(`不是 RFB 服务：${JSON.stringify(version)}`);
      send(Buffer.from("RFB 003.008\n", "ascii"));
      const sectionCount = (await reader.read(1))[0] ?? 0;
      if (sectionCount === 0) throw new Error("RFB 服务拒绝了连接");
      const types = [...(await reader.read(sectionCount))];
      if (!types.includes(1)) {
        throw new Error(`guest 的 RFB 只接受 None 认证之外的方案（${types.join(",")}），本机镜像应该用 -SecurityTypes None`);
      }
      send(Buffer.from([1])); // 选 None
      // 版本 ≥ 3.8 时 None 也会回一个 SecurityResult（4 字节 0 = 通过）
      const result = (await reader.read(4)).readUInt32BE(0);
      if (result !== 0) throw new Error("RFB 的 None 认证被拒（SecurityResult != 0）");
      send(Buffer.from([1])); // ClientInit: shared

      const head = await reader.read(24);
      const width = head.readUInt16BE(0);
      const height = head.readUInt16BE(2);
      const nameLength = head.readUInt32BE(20);
      if (nameLength > 0) await reader.read(nameLength);

      // SetPixelFormat + SetEncodings（一条都不登记）：只是让服务端知道这个客户端形态正常。
      // 不登记任何编码 → 它不会按 raw 帧给我们灌画面。
      const setPixelFormat = Buffer.alloc(20);
      setPixelFormat[4] = 32;
      setPixelFormat[5] = 24;
      setPixelFormat[7] = 1;
      setPixelFormat.writeUInt16BE(255, 8);
      setPixelFormat.writeUInt16BE(255, 10);
      setPixelFormat.writeUInt16BE(255, 12);
      setPixelFormat[14] = 16;
      setPixelFormat[15] = 8;
      setPixelFormat[16] = 0;
      send(setPixelFormat);
      const encodings = Buffer.alloc(4);
      encodings[0] = 2; // SetEncodings
      encodings.writeUInt16BE(0, 2); // 个数 0
      send(encodings);
      return new VncPointer(socket, reader, width, height);
    } catch (cause) {
      socket.destroy();
      throw cause;
    }
  }

  #pointer(x: number, y: number, mask: number): void {
    const message = Buffer.alloc(6);
    message[0] = 5; // PointerEvent
    message[1] = mask;
    message.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(x))), 2);
    message.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(y))), 4);
    this.#socket.write(message);
  }

  /**
   * 点一下。**按压必须停够 ~200ms**：P3-2 实测 90ms 的 press/release 会被 xfce4-panel
   * 当成没发生（菜单不弹）；250ms 稳定。RFB 这边不怕 GTK 那个「release 关菜单」的坑
   * ——那是 XTEST 才有的（见文件头）。
   */
  async click(
    x: number,
    y: number,
    options: { button?: VncButton; double?: boolean; holdMs?: number; settleMs?: number } = {},
  ): Promise<void> {
    const button = options.button ?? "left";
    const mask = BUTTON_MASK[button];
    const holdMs = options.holdMs ?? (options.double === true ? 40 : 220);
    // 先落一次位置，并且**停够**再按：Xvnc 下「第一个绝对坐标 + 立刻按下」会丢 enter；
    // 菜单项上还要长一点——指针刚落下就按，GTK 会当成「点在菜单外」把菜单收掉（实测）。
    this.#pointer(x, y, 0);
    await sleep(options.settleMs ?? 150);
    const rounds = options.double === true ? 2 : 1;
    for (let round = 0; round < rounds; round += 1) {
      this.#pointer(x, y, mask);
      await sleep(holdMs);
      this.#pointer(x, y, 0);
      if (round + 1 < rounds) await sleep(90); // 两下之间的间隔要短于系统双击阈值（默认 250ms）
    }
  }

  /** 滚轮：notches > 0 = 向下（与工具契约一致：正数向下） */
  async scroll(x: number, y: number, notches: number): Promise<void> {
    const mask = notches > 0 ? BUTTON_MASK.wheelDown : BUTTON_MASK.wheelUp;
    this.#pointer(x, y, 0);
    await sleep(60);
    for (let step = 0; step < Math.abs(notches); step += 1) {
      this.#pointer(x, y, mask);
      await sleep(20);
      this.#pointer(x, y, 0);
      await sleep(30);
    }
  }

  /**
   * 收尾用 `end()` 而不是 `destroy()`：我们只写不读，最后一条 PointerEvent 可能还在
   * socket 的发送缓冲里——destroy 会把它丢掉，于是「点了但没反应」。
   */
  close(): void {
    this.#socket.end();
  }
}
