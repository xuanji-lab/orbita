/**
 * app 里用的 WebSocket：React Native 自带的那一个，**Origin 头写成空串**。
 *
 * 口径（与契约 `MOBILE_PATH` 的注释一致）：电脑侧 **Origin 缺席或为空串放行，任何非空 Origin 一律
 * 403**——挡的是能跨源连 WebSocket 的浏览器网页，不是「原生 app 一定不带 Origin」。RN 安卓的
 * WebSocketModule 在调用方没给 Origin 时会自己补一个（`http://地址:端口`，见
 * node_modules/react-native/ReactAndroid/.../websocket/WebSocketModule.kt），所以这里显式给一个
 * 空的 Origin 头，RN 就不再补。空 Origin 不是认证凭据（认证走配对与握手），也不必换自定义头——
 * 不增加安全性；哪天某个 WebView 抑制不了非空 Origin，再考虑加 `X-Orbita-Client: native` 作路由标记。
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
