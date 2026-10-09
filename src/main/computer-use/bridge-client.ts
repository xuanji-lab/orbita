/**
 * guest 桥的 HTTP 客户端 —— 宿主反向调沙箱里的桥。
 *
 * 协议（与 guest 桥实现严格一致）：GET http://<guestIP>:<port>/screenshot?maxWidth=<n>，
 * header 带 `Authorization: Bearer <token>`（双向鉴权里宿主出的这一半）；
 * 成功回 `image/jpeg` + 响应头 `X-Native-Width` / `X-Native-Height`（沙箱桌面的原始尺寸，
 * 模型换算点击坐标要用它与回图宽度的比值）。401 = token 对不上（桥和宿主不属于同一次会话）。
 */
import type { GuestRegistration } from "./host-server.ts";

export interface BridgeEndpoint {
  ip: string;
  port: number;
  token: string;
}

export interface GuestScreenshot {
  jpeg: Uint8Array;
  nativeWidth: number;
  nativeHeight: number;
}

/** 桥不回话时的放弃线。桌面截图不是快操作，放宽到 15s（PR1 无注入动作，只有这一种调用）。 */
export const GUEST_SCREENSHOT_TIMEOUT_MS = 15_000;

/**
 * 向 guest 桥要一张截图。所有失败都以 Error 抛出（消息已是人话，调用方直接展示）：
 * 超时 / 连不上 / 401 / 其他状态码 / 缺尺寸头 / 空响应。
 */
export async function fetchGuestScreenshot(
  endpoint: BridgeEndpoint,
  maxWidth: number,
  timeoutMs: number = GUEST_SCREENSHOT_TIMEOUT_MS,
): Promise<GuestScreenshot> {
  const url = `http://${endpoint.ip}:${endpoint.port}/screenshot?maxWidth=${maxWidth}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause: unknown) {
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new Error(`guest 桥 ${timeoutMs}ms 内没有响应（截图超时）`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`连不上 guest 桥（${endpoint.ip}:${endpoint.port}）：${message}`);
  }

  if (response.status === 401) {
    throw new Error("guest 桥拒绝了 token（401）——桥和宿主不属于同一次沙箱会话，重启沙箱再试");
  }
  if (!response.ok) {
    throw new Error(`guest 桥返回了 ${response.status}`);
  }
  const nativeWidth = Number(response.headers.get("x-native-width"));
  const nativeHeight = Number(response.headers.get("x-native-height"));
  if (!Number.isFinite(nativeWidth) || !Number.isFinite(nativeHeight) || nativeWidth <= 0 || nativeHeight <= 0) {
    throw new Error("guest 桥的响应缺少 X-Native-Width / X-Native-Height 头");
  }
  const jpeg = new Uint8Array(await response.arrayBuffer());
  if (jpeg.length === 0) {
    throw new Error("guest 桥返回了空截图");
  }
  return { jpeg, nativeWidth, nativeHeight };
}
