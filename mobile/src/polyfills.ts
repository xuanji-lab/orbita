/**
 * React Native（Hermes）里给 `@noble/*` 补的全局。
 *
 * - `crypto.getRandomValues`：Hermes 没有 Web Crypto；noble 的 `randomBytes` 只认这一个口子。
 *   用 Expo 自家的 expo-crypto（系统 SecureRandom），不引第三方的随机数补丁。
 *   已经有了（Node 测试、以后别的引擎）就不动。
 *
 * TextEncoder / TextDecoder、atob / btoa、setTimeout 在 RN 0.88 的 Hermes 上都是现成的，
 * 不补（模拟器里实测，见报告）。这个文件只在 app 入口 import 一次，测试不走它。
 */
import { getRandomValues } from "expo-crypto";

interface CryptoLike {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

const host = globalThis as { crypto?: Partial<CryptoLike> };
if (typeof host.crypto?.getRandomValues !== "function") {
  const fill = <T extends ArrayBufferView | null>(array: T): T => {
    if (array === null) return array;
    // expo-crypto 只收整数类型数组；noble 传进来的都是 Uint8Array
    getRandomValues(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  };
  host.crypto = { ...(host.crypto ?? {}), getRandomValues: fill };
}
