/**
 * 宿主侧 HTTP 服务 —— guest 桥回连的注册入口。
 *
 * 监听 52740，只绑 Windows Sandbox NAT 的 vEthernet 接口 IP（禁绑 0.0.0.0——
 * 这个服务只该被沙箱 NAT 网里的 guest 桥摸到，不该暴露给局域网）。
 * 所有请求都验 `Authorization: Bearer <token>`（token 每次沙箱会话随机生成），
 * 不对即 401——这是双向鉴权里宿主这一半。
 *
 * 唯一的业务路由：POST /register，body `{"port": <guest 监听端口>}` → 200 {"ok":true}，
 * 宿主从 socket remoteAddress 记下 guest IP（vEthernet NAT 内的 172.x 地址）+ port，
 * 之后经 bridge-client 反向调 guest。guest 桥可能重试注册，每次照常应答、照常回调。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** os.networkInterfaces() 的注入别名（测试喂 fixtures 用） */
export type ListInterfaces = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface BindAddress {
  /** 网卡名（形如「vEthernet (Windows Sandbox NAT)」），只用于日志 */
  name: string;
  ip: string;
}

/**
 * 找宿主该绑的 vEthernet IPv4 地址。优先名字带 sandbox 的（Windows Sandbox NAT），
 * 退而求其次取第一个 vEthernet 的 IPv4。找不到回 null——调用方给明确错误 / 继续等。
 *
 * 这块网卡可能要等沙箱启动后才出现，所以调用方（sandbox.ts）按 deadline 轮询本函数，
 * 而不是只在启动时查一次。
 */
export function findHostBindIp(listInterfaces: ListInterfaces = networkInterfaces): BindAddress | null {
  let fallback: BindAddress | null = null;
  for (const [name, infos] of Object.entries(listInterfaces())) {
    if (!/vethernet/i.test(name)) continue;
    for (const info of infos ?? []) {
      if (info.family !== "IPv4" || info.internal) continue;
      const candidate: BindAddress = { name, ip: info.address };
      if (/sandbox/i.test(name)) return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
}

/**
 * socket remoteAddress 归一化：IPv4-only 监听偶尔会给出 IPv6-mapped 形式
 * （"::ffff:172.16.0.1"），剥掉前缀才能直接拼进 http:// URL。
 */
export function normalizeRemoteAddress(remoteAddress: string | undefined): string {
  if (remoteAddress === undefined) return "";
  return remoteAddress.startsWith("::ffff:") ? remoteAddress.slice("::ffff:".length) : remoteAddress;
}

/** register 成功时上报给宿主的一条：guest 在 NAT 网里的 IP + 桥自己的监听端口 */
export interface GuestRegistration {
  ip: string;
  port: number;
}

export interface HostServerOptions {
  /** 监听端口（协议常量 52740；测试传 0 拿临时端口） */
  hostPort: number;
  /** 本次沙箱会话的鉴权 token（hex），register 请求必须 Bearer 它 */
  token: string;
  /** 每次合法 register 的回调（重复注册照常回调，由 controller 决定怎么记账） */
  onRegister: (registration: GuestRegistration) => void;
  log?: (message: string) => void;
}

const REGISTER_BODY_LIMIT = 64 * 1024;

export class HostServer {
  private server: Server | null = null;
  private errorHooked = false;
  private readonly options: HostServerOptions;

  constructor(options: HostServerOptions) {
    this.options = options;
  }

  /** 绑到 bindIp 上开始监听。已被 close 过的实例可以重新 listen（绑定重试就是这么用的）。 */
  async listen(bindIp: string): Promise<void> {
    const server = this.server ?? createServer((request, response) => this.handle(request, response));
    this.server = server;
    // 常驻 error 监听：没有 error 监听的 server 一旦出错会把整个进程炸掉。
    // （once 标记防止绑定重试时反复挂重复监听。）
    if (!this.errorHooked) {
      server.on("error", (cause: Error) => this.options.log?.(`宿主 HTTP 服务出错：${cause.message}`));
      this.errorHooked = true;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.hostPort, bindIp, () => {
        resolve();
      });
    });
  }

  /** 实际监听地址（hostPort 传 0 时这里才是真端口）；没在监听回 null。 */
  address(): { ip: string; port: number } | null {
    const addr = this.server?.address();
    if (addr === null || addr === undefined || typeof addr === "string") return null;
    return { ip: addr.address, port: addr.port };
  }

  /** 停止监听并掐断所有现存连接（guest 的 keep-alive 不许拖住退出）。幂等。 */
  close(): void {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.close();
    server.closeAllConnections();
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const fail = (code: number, message: string): void => {
      response.writeHead(code, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: message }));
    };
    // 鉴权先于一切路由：token 不对（包括没带）一律 401，不暴露路径信息。
    // 这里用普通字符串比较就够——token 是每次会话随机的 256 位值、只存在于
    // NAT 网内，没有时间侧信道可资利用的场景。
    const auth = request.headers.authorization ?? "";
    if (auth !== `Bearer ${this.options.token}`) {
      fail(401, "token 不对");
      return;
    }
    if (request.method !== "POST" || (request.url ?? "").split("?")[0] !== "/register") {
      fail(404, "not found");
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > REGISTER_BODY_LIMIT) {
        done = true;
        fail(413, "register body 过大");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => {
      if (!done) {
        done = true;
        fail(400, "register 请求读失败");
      }
    });
    request.on("end", () => {
      if (done) return;
      done = true;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        fail(400, "register body 不是 JSON");
        return;
      }
      const port = readPort(parsed);
      if (port === null) {
        fail(400, 'register body 需要 {"port": <1-65535>}');
        return;
      }
      const ip = normalizeRemoteAddress(request.socket.remoteAddress);
      if (ip === "") {
        fail(400, "拿不到来源 IP");
        return;
      }
      this.options.onRegister({ ip, port });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  }
}

function readPort(parsed: unknown): number | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const port = (parsed as { port?: unknown }).port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}
