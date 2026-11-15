/**
 * 应用图标的 IPC —— 四层契约的第 2 层，外加把图标交给系统的那几行。
 *
 * - macOS：`app.dock.setIcon(image)`——只换运行时 Dock 里的图标；退出后 Finder / 启动台
 *   显示的仍是 .app 包里的默认图标（系统限制，设置页写了这句话）。
 * - Windows / Linux：每个主窗口 `setIcon`（任务栏图标）；之后新建的窗口建窗时就带上。
 *   托盘图标 `build/tray.png` 不动。
 *
 * 图标画在 renderer（SVG → canvas → PNG），主进程不碰 SVG：mac 的 Dock 不会替图标加圆角，
 * 网格由 renderer 按平台画好。
 */
import { app, ipcMain, nativeImage, type NativeImage } from "electron";
import {
  appIconChannels,
  type AppIconApplyRequest,
  type AppIconApplyResult,
  isAppIconId,
} from "../../shared/app-icon.ts";
import { mainWindows } from "../window/main-windows.ts";
import { AppIconStore, validateAppIconPng } from "./store.ts";

/** 当前生效的图标；null = 还没应用过任何一款（停在打包的默认图标上） */
let current: NativeImage | null = null;

function present(image: NativeImage): void {
  current = image;
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
    return;
  }
  for (const window of mainWindows.list()) window.setIcon(image);
}

/**
 * 启动时读缓存应用。在 ready 之后、第一扇窗口创建之前调用：Dock 一出现就是用户选的款式。
 * 没缓存 / 缓存坏了 = 什么都不做，停在打包的默认图标上。
 */
export async function applyCachedAppIcon(store: AppIconStore): Promise<void> {
  const bytes = await store.read();
  if (bytes === null) return;
  const image = nativeImage.createFromBuffer(Buffer.from(bytes));
  if (image.isEmpty()) return;
  present(image);
  console.info(`[app-icon] 启动时读缓存应用（${bytes.byteLength} 字节，${process.platform}）`);
}

export function registerAppIconIpc(store: AppIconStore): void {
  ipcMain.handle(
    appIconChannels.appIconApply,
    async (_event, request: AppIconApplyRequest): Promise<AppIconApplyResult> => {
      if (typeof request !== "object" || request === null || !isAppIconId(request.id)) {
        return { ok: false, error: "不认识的图标款式" };
      }
      const invalid = validateAppIconPng(request.png);
      if (invalid !== null) return { ok: false, error: invalid };
      const image = nativeImage.createFromBuffer(Buffer.from(request.png));
      if (image.isEmpty()) return { ok: false, error: "PNG 解不出图像" };
      try {
        // 先落盘再换：落盘失败就不换，设置页据此不记这次选择（盘上与界面不分叉）
        await store.write(request.png);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      present(image);
      console.info(`[app-icon] 已应用 ${request.id}（${request.png.byteLength} 字节，${process.platform}）`);
      return { ok: true };
    },
  );
}

/** 新建主窗口时的图标选项（Windows / Linux 才有意义；没应用过就不传，用打包图标） */
export function windowIconOption(): { icon: NativeImage } | Record<string, never> {
  const image = current;
  return process.platform !== "darwin" && image !== null ? { icon: image } : {};
}
