/**
 * 网页缩略图：开一个隐藏窗口真的把页面跑起来、截一张图。
 *
 * 为什么不用 renderer 里的 iframe：空 sandbox 的 srcDoc 不跑脚本、也丢了页面所在目录——用户的网页多是
 * 脚本填内容、相对路径引图 / CSS 的，缩略图就是一片空白。放开脚本又意味着在 renderer 里跑不可信页面。
 * 所以交给主进程的隔离窗口：
 * - 不显示（show:false）、不抢焦点、不进任务栏 / Dock；沙箱、无 node、无 preload，上下文隔离；
 * - 专属的内存 partition：不碰用户的 cookie / 浏览器登录态；一切网络请求拒绝，file:// 只放行这条会话的白名单根
 *   （与内置浏览器「页面闸」同一个判定 localRequestAllowed）；权限请求、弹窗、导航到别处一律拒；
 * - 并发 1、总超时 5 秒、截完立刻销毁窗口；结果按「路径 + mtime + 大小」进 LRU。
 */
import { BrowserWindow, session, type Session } from "electron";
import { stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LruCache } from "../../shared/lru.ts";
import type { WebThumb } from "../../shared/files.ts";
import { localRequestAllowed } from "../browser/local-file.ts";
import { createDedupe, createLimiter, webThumbKey } from "./web-thumb-queue.ts";

/** 按这个视口宽排版（像一张桌面浏览器截图），截完缩到 THUMB_WIDTH */
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const THUMB_WIDTH = 640;
/** did-finish-load 之后再等这么久，让脚本把内容填上、图片解码完 */
const SETTLE_MS = 600;
/** 从开始加载算起的总上限 */
const TIMEOUT_MS = 5000;
const CACHE_LIMIT = 40;
const JPEG_QUALITY = 78;

const cache = new LruCache<WebThumb>(CACHE_LIMIT);
const limit = createLimiter(1);
const dedupe = createDedupe<WebThumb | null>();

/** 每个截图窗口（按 webContents id）当前放行的 file:// 根；窗口销毁就移除 */
const rootsByContents = new Map<number, readonly string[]>();
let guarded: Session | null = null;

function thumbSession(): Session {
  if (guarded !== null) return guarded;
  // 不带 persist: 前缀 = 内存 partition，退出即丢
  const partition = session.fromPartition("orbita-web-thumb");
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith("file:")) {
      // 网络、data:、blob: 之外的都不让出门；data: / blob: / devtools 之类内部地址放行
      const internal = /^(data|blob|about):/i.test(details.url);
      callback({ cancel: !internal });
      return;
    }
    const roots = details.webContentsId === undefined ? [] : (rootsByContents.get(details.webContentsId) ?? []);
    void localRequestAllowed(details.url, roots).then(
      (allowed) => callback({ cancel: !allowed }),
      () => callback({ cancel: true }),
    );
  });
  guarded = partition;
  return partition;
}

/** 真截一张：path 已过白名单（realpath 后的网页文件），roots 是这条会话的放行根 */
async function capture(path: string, roots: readonly string[]): Promise<Omit<WebThumb, "modifiedAt"> | null> {
  const window = new BrowserWindow({
    show: false,
    focusable: false,
    skipTaskbar: true,
    width: VIEWPORT_WIDTH,
    height: VIEWPORT_HEIGHT,
    useContentSize: true,
    frame: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      session: thumbSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      autoplayPolicy: "user-gesture-required",
    },
  });
  const contents = window.webContents;
  const id = contents.id;
  rootsByContents.set(id, roots);
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // 页面自己跳去别处（含同根里的另一页）也不跟：缩略图只画这一页
  contents.on("will-navigate", (event) => event.preventDefault());
  try {
    const url = pathToFileURL(path).toString();
    const result = await Promise.race([
      (async () => {
        await contents.loadURL(url);
        await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
        if (window.isDestroyed()) return null;
        const image = await contents.capturePage();
        if (image.isEmpty()) return null;
        const small = image.resize({ width: THUMB_WIDTH, quality: "good" });
        return { mime: "image/jpeg" as const, base64: small.toJPEG(JPEG_QUALITY).toString("base64") };
      })(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS)),
    ]);
    return result;
  } catch {
    return null;
  } finally {
    rootsByContents.delete(id);
    if (!window.isDestroyed()) window.destroy();
  }
}

/**
 * 给一个已通过白名单的网页文件出缩略图。读不到 / 超时 / 页面加载失败 = null。
 * 命中缓存不开窗口；同一份文件同时只截一次；全局同时只开一个窗口。
 */
export async function webThumbOf(path: string, roots: readonly string[]): Promise<WebThumb | null> {
  let info: { mtimeMs: number; size: number };
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  const key = webThumbKey(path, info.mtimeMs, info.size);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  return dedupe(key, () =>
    limit(async () => {
      const shot = await capture(path, roots);
      if (shot === null) return null;
      const thumb: WebThumb = { ...shot, modifiedAt: info.mtimeMs };
      cache.set(key, thumb);
      return thumb;
    }),
  );
}
