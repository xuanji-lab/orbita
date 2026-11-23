/**
 * 对话里要读盘上文件的那几处（回答里的本地图、过程行的缩略图、结尾产物的「打开」）共用的会话范围。
 *
 * 读文件一律走文件面板同一道白名单（`fs:roots` 回过的根 + realpath 判前缀，都在主进程）：
 * renderer 这边只是把绝对路径对到它所在的根上，传什么主进程都不信。不在任何根里的路径 = 读不到。
 */
import { createContext, useContext, useEffect, useState } from "react";
import type { FilePreview, FileRoot } from "@shared/files";
import { api } from "../../api";
import { rootOf } from "./chat-paths.ts";

export { resolveChatPath } from "./chat-paths.ts";

export interface ChatFileScope {
  sessionId: string | null;
  workspaceId: string | null;
  /** 回答里写相对路径时按它解析 */
  cwd: string | null;
}

export const ChatFileScopeContext = createContext<ChatFileScope | null>(null);

export function useChatFileScope(): ChatFileScope | null {
  return useContext(ChatFileScopeContext);
}

const rootsCache = new Map<string, Promise<FileRoot[]>>();

function rootsFor(scope: ChatFileScope): Promise<FileRoot[]> {
  const key = `${scope.sessionId ?? ""}|${scope.workspaceId ?? ""}`;
  const hit = rootsCache.get(key);
  if (hit !== undefined) return hit;
  const promise = api.files.roots({ sessionId: scope.sessionId, workspaceId: scope.workspaceId }).catch(() => [] as FileRoot[]);
  rootsCache.set(key, promise);
  // 取失败 / 取到空清单不缓存：以前失败也存 60 秒，期间这条会话的图一律读不到、停在占位
  // （2026-11-23 用户：回复里的图要等再发一条消息才画出来）
  void promise.then((roots) => {
    if (roots.length === 0 && rootsCache.get(key) === promise) rootsCache.delete(key);
  });
  // 根清单会变（加了附加目录）：一分钟后丢掉，下次现取
  window.setTimeout(() => rootsCache.delete(key), 60_000);
  return promise;
}

const imageCache = new Map<string, Promise<string | null>>();
const MAX_IMAGES = 80;

/** 读一张本地图成 data URL；不在根里、不是图、太大都是 null */
export function loadChatImage(scope: ChatFileScope, path: string): Promise<string | null> {
  const key = `${scope.sessionId ?? ""}|${path}`;
  const hit = imageCache.get(key);
  if (hit !== undefined) return hit;
  const promise = rootsFor(scope)
    .then((roots) => {
      const root = rootOf(path, roots);
      if (root === null) return null;
      return api.files
        .read({ sessionId: scope.sessionId, workspaceId: scope.workspaceId, root: root.path, dir: path })
        .then((data) => (data.kind === "image" ? `data:${data.mime};base64,${data.base64}` : null));
    })
    .catch(() => null);
  imageCache.set(key, promise);
  void promise.then((url) => {
    if (url === null) imageCache.delete(key);
  });
  while (imageCache.size > MAX_IMAGES) {
    const oldest = imageCache.keys().next().value;
    if (oldest === undefined) break;
    imageCache.delete(oldest);
  }
  return promise;
}

/** 读一个文件给临时预览用（状态卡的产物预览）：同一道白名单；不在根里 / 读失败 = null */
export async function readChatFile(scope: ChatFileScope, path: string): Promise<FilePreview | null> {
  const root = rootOf(path, await rootsFor(scope));
  if (root === null) return null;
  try {
    return await api.files.read({ sessionId: scope.sessionId, workspaceId: scope.workspaceId, root: root.path, dir: path });
  } catch {
    return null;
  }
}

/** 读一份 PDF 的字节给缩略图画首页（状态面板的产物行）：同一道白名单；不在根里 / 太大 / 读失败 = null */
export async function readChatPdf(scope: ChatFileScope, path: string): Promise<Uint8Array | null> {
  const root = rootOf(path, await rootsFor(scope));
  if (root === null) return null;
  try {
    const file = await api.files.readPdf({ sessionId: scope.sessionId, workspaceId: scope.workspaceId, root: root.path, dir: path });
    return file.kind === "pdf" ? file.data : null;
  } catch {
    return null;
  }
}

/** 用系统默认应用打开一个文件（同一道白名单）；打不开返回 false */
export async function openChatFile(scope: ChatFileScope, path: string): Promise<boolean> {
  const root = rootOf(path, await rootsFor(scope));
  if (root === null) return false;
  try {
    await api.files.open({ sessionId: scope.sessionId, workspaceId: scope.workspaceId, root: root.path, dir: path });
    return true;
  } catch {
    return false;
  }
}

/** 在系统文件管理器里显示一个文件（同一道白名单）；打不开返回 false */
export async function revealChatFile(scope: ChatFileScope, path: string): Promise<boolean> {
  const root = rootOf(path, await rootsFor(scope));
  if (root === null) return false;
  try {
    await api.files.reveal({ sessionId: scope.sessionId, workspaceId: scope.workspaceId, root: root.path, dir: path });
    return true;
  } catch {
    return false;
  }
}

/** 本地图的 data URL：undefined = 还在读，null = 读不到 */
/** 读不到时再试的间隔（毫秒）：根清单没取到、刚写完的图还没落盘这类一时的失败，等一下往往就好 */
const IMAGE_RETRY_DELAYS = [1500, 4000];

export function useChatImage(path: string | null): string | null | undefined {
  const scope = useChatFileScope();
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (scope === null || path === null) {
      setUrl(null);
      return undefined;
    }
    let alive = true;
    let timer: number | undefined;
    setUrl(undefined);
    // 读到 null 不立刻认输：按 IMAGE_RETRY_DELAYS 再试两次（null 结果不进缓存，重试是真的重读），
    // 都不行才画占位。以前一次失败就停在占位，要等这条消息重挂（用户再发一条）才会重读
    const attempt = (round: number): void => {
      void loadChatImage(scope, path).then((value) => {
        if (!alive) return;
        if (value === null && round < IMAGE_RETRY_DELAYS.length) {
          timer = window.setTimeout(() => attempt(round + 1), IMAGE_RETRY_DELAYS[round]);
          return;
        }
        setUrl(value);
      });
    };
    attempt(0);
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [scope, path]);
  return url;
}

/**
 * 回答里本地图的尺寸偏好（settings.chatImageSize）与改它的口子，App 注入。
 * 每张图挂载时读一次 size 当自己的初值；右键改的是那一张，同时把选择记成之后新图的默认。
 */
export interface ChatImageSizePref {
  size: "large" | "small";
  setSize: (size: "large" | "small") => void;
}

export const ChatImageSizeContext = createContext<ChatImageSizePref>({ size: "large", setSize: () => undefined });
