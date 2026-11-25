/**
 * app 里用的 WebSocket：React Native 自带的那一个，**Origin 头写成空串**。
 *
 * 为什么：RN 安卓的 WebSocketModule 在调用方没给 Origin 时会自己补一个（`http://地址:端口`，
 * 见 node_modules/react-native/ReactAndroid/.../websocket/WebSocketModule.kt），而电脑侧对带
 * Origin 的握手一律回 403（防浏览器网页跨源连）。电脑侧的判断是「不带或为空串才放行」，
 * 所以这里显式给一个空的 Origin 头，RN 就不再补。
 */
import type { SocketFactory, SocketLike } from "./socket.ts";

/** RN 的 WebSocket 构造器比 DOM 的多一个 options（DOM 的类型里没有它） */
type RNWebSocketConstructor = new (
  url: string,
  protocols: string | string[] | undefined,
  options: { headers: Record<string, string> },
) => SocketLike;

export const rnSocketFactory: SocketFactory = (url) => {
  const Ctor = WebSocket as unknown as RNWebSocketConstructor;
  return new Ctor(url, undefined, { headers: { origin: "" } });
};
