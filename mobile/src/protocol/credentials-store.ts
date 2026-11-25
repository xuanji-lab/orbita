/**
 * 配对凭据的存取：整份 JSON（含设备私钥）放进 expo-secure-store——安卓上是用 Android Keystore
 * 里的钥匙加密后存在应用私有的 SharedPreferences 里，卸载即清；`allowBackup` 在 app.json 里关掉了，
 * 不跟着系统备份出去。
 *
 * 只存一台电脑（第一刀不做换主机）。读出来形状不对就当没配过。
 */
import * as SecureStore from "expo-secure-store";
import type { Credentials } from "./pair.ts";

const KEY = "orbita.pairing.v1";

export async function loadCredentials(): Promise<Credentials | null> {
  let text: string | null;
  try {
    text = await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const fields = raw as Record<string, unknown>;
  const { address, port, deviceId, devicePrivate, hostPublic, hostName, pairedAt } = fields;
  if (
    typeof address !== "string" ||
    typeof port !== "number" ||
    typeof deviceId !== "string" ||
    typeof devicePrivate !== "string" ||
    typeof hostPublic !== "string" ||
    typeof hostName !== "string" ||
    typeof pairedAt !== "number"
  ) {
    return null;
  }
  return { address, port, deviceId, devicePrivate, hostPublic, hostName, pairedAt };
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(credentials));
}

export async function clearCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
