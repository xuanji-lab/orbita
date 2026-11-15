/**
 * 应用图标的 PNG 缓存与校验（electron 无关，node --test 可直接加载）。
 *
 * renderer 选中一款图标后把画好的 PNG 经 `app-icon:apply` 发来；主进程校验后原子写进
 * userData/app-icon.png。下次启动在 ready 之后、窗口出现之前先读它应用，Dock / 任务栏
 * 不会先闪一下打包的默认图标。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_ICON_PNG_MAX_BYTES, APP_ICON_PNG_SIZE } from "../../shared/app-icon.ts";
import { writeBytesAtomic } from "../atomic-write.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 校验 renderer 发来的字节确实是 512×512 的 PNG。回 null = 合格，否则回原因。
 * 只看签名与 IHDR 的宽高，不解码像素：真正的解码由 nativeImage 做，解不出来同样拒绝（见 ipc.ts）。
 * 这道闸门的用途是挡掉「不是图标的东西」——这条 IPC 的载荷来自 renderer，不当作可信输入。
 */
export function validateAppIconPng(bytes: unknown): string | null {
  if (!(bytes instanceof Uint8Array)) return "PNG 数据不是字节数组";
  if (bytes.byteLength === 0) return "PNG 数据为空";
  if (bytes.byteLength > APP_ICON_PNG_MAX_BYTES) return "PNG 数据过大";
  // 24 字节 = 8 签名 + 4 长度 + 4 "IHDR" + 4 宽 + 4 高
  if (bytes.byteLength < 24) return "不是 PNG（数据太短）";
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return "不是 PNG（签名不对）";
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return "不是 PNG（缺 IHDR）";
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width !== APP_ICON_PNG_SIZE || height !== APP_ICON_PNG_SIZE) {
    return `PNG 尺寸应为 ${APP_ICON_PNG_SIZE}×${APP_ICON_PNG_SIZE}，收到 ${width}×${height}`;
  }
  return null;
}

export class AppIconStore {
  private readonly filePath: string;

  constructor(dir: string) {
    this.filePath = join(dir, "app-icon.png");
  }

  /** 读缓存。没有 / 读不出 / 不合格都回 null（应用就停在打包的默认图标上，不报错） */
  async read(): Promise<Uint8Array | null> {
    try {
      const bytes = new Uint8Array(await readFile(this.filePath));
      return validateAppIconPng(bytes) === null ? bytes : null;
    } catch {
      return null;
    }
  }

  async write(png: Uint8Array): Promise<void> {
    await writeBytesAtomic(this.filePath, png);
  }
}
