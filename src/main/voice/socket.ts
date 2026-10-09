/**
 * 听写连接的生产依赖：带请求头的 undici WebSocket 与一次诊断 GET（dictation.ts 顶注释讲了
 * 为什么要诊断）。两样都与厂商无关——走 WebSocket + 请求头鉴权的厂商都用这两个。
 *
 * 用 undici 而不是 `ws` 包：undici 已是依赖，它的 WebSocket 支持自定义请求头（非标准的
 * `headers` 选项），豆包鉴权正需要这个——不为一条连接多引一个依赖。
 */
import { request, WebSocket } from "undici";
import type { VoiceFailure } from "../../shared/voice.ts";
import type { Diagnose, OpenSocket } from "./dictation.ts";

export const openUndiciSocket: OpenSocket = (url, headers, handlers) => {
  const socket = new WebSocket(url, { headers });
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => handlers.onOpen());
  socket.addEventListener("message", (event) => {
    // 豆包走二进制帧、阶跃走 JSON 文本（node 端 undici 对文本消息给 string）
    if (event.data instanceof ArrayBuffer) handlers.onMessage(new Uint8Array(event.data));
    else if (typeof event.data === "string") handlers.onMessage(event.data);
  });
  socket.addEventListener("error", () => handlers.onError());
  socket.addEventListener("close", () => handlers.onClose());
  return {
    send: (frame) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(frame.kind === "text" ? frame.data : frame.data);
    },
    close: () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
    },
  };
};

/** 服务端的原话截到这么长：够看清原因，不把整页 HTML 塞进设置页 */
const DETAIL_LIMIT = 200;

/**
 * 握手失败后问原因：wss → https，同样的请求头发一次 GET。401 / 403 = 凭证或开通问题
 * （正文是一句 JSON，豆包 `load grant: requested grant not found`；阶跃 2026-10 实测
 * `401 {"error":{"message":"Incorrect API key provided","type":"invalid_api_key"}}`）；
 * 别的状态归 rejected；GET 本身也失败 = 网络不通。
 */
export const diagnoseOverHttps: Diagnose = async (url, headers) => {
  try {
    const response = await request(url.replace(/^wss:/, "https:"), {
      headers,
      headersTimeout: 8_000,
      bodyTimeout: 8_000,
    });
    const body = (await response.body.text()).trim().slice(0, DETAIL_LIMIT);
    const detail = body === "" ? String(response.statusCode) : `${response.statusCode} ${body}`;
    const failure: VoiceFailure =
      response.statusCode === 401 || response.statusCode === 403
        ? { reason: "unauthorized", detail }
        : { reason: "rejected", detail };
    return failure;
  } catch {
    return { reason: "network" };
  }
};
