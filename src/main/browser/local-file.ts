/**
 * 内置浏览器里的本地文件（file://）——两道闸都在这里：
 *
 * 1. **入口闸**（resolveLocalPage）：打开一个本地网页之前，它得在本会话能用的目录里。
 *    browser_navigate 打开本地文件（agent 写的 HTML 预览——Canvas 的替代：画东西就写一页 HTML，
 *    在受管浏览器里打开给用户看）与轮尾卡「在 orbita 打开」都走它：只放行**本会话能用的目录**
 *    里的网页类文件——会话工作台、工作目录（cwd）、工作区附加目录、浏览器下载目录，和 agent 每轮
 *    被告知的目录清单一致，不开新口子。判定在 realpath 之后：目录里放一个指向外面的软链接，
 *    不能借它跳出去；改名成 .html 的链接指向别的类型，同样不放。
 *
 * 2. **页面闸**（guardLocalFileRequests）：入口闸只管第一个地址。页面打开之后，它自己还能 fetch、
 *    iframe、img、script 任意 file://，或者把自己跳到根外——Electron 默认给 file:// 页面这些特权
 *    （GrantFileProtocolExtraPrivileges 熔丝），#365 实测四种方式都读得到根外。所以受管浏览器的
 *    partition 上，每一个 file:// 请求（主框架、子框架、子资源）都要 realpath 后落在**这个 tab 的
 *    放行根**里——放行根是把它打开的那道入口闸认的那几个根；从没经入口闸打开过本地网页的 tab
 *    （以及弹窗、未知来源）一律不放。
 *
 * 用户地址栏不收本地路径（address.ts 的 resolveAddressOrSearch）：「你的」tab 只能经文件面板的
 * 「在内置浏览器打开」（files/ipc.ts，文件面板白名单）或轮尾卡打开本地网页。
 */
import { realpath as fsRealpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "electron";
import { isWebPageFile } from "../../shared/files.ts";
import type { LocalPageRefusal } from "../../shared/browser.ts";
import { realpathInside } from "../path-boundary.ts";

/** 形如本地路径的输入：绝对路径（POSIX / Windows 盘符 / UNC 与设备路径 `\\…`）或 file:// 地址 */
export function looksLikeLocalPath(input: string): boolean {
  const text = input.trim();
  // Windows 的绝对路径除了盘符还有两类不以盘符开头：UNC（\\server\share\…）与设备路径（\\?\C:\…）。
  // 不认它们的话它们会漏到网址/搜索那条路：UNC 被解析成 https://server/share/… 并对该主机发请求，
  // \\?\C:\… 整条被 URL 编码后送进搜索——本地路径外泄给第三方。
  return /^file:\/\//i.test(text) || text.startsWith("/") || /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("\\\\");
}

/**
 * 入口闸的结论。拒绝带稳定原因码（轮尾卡按码出文案）与英文原句（browser_navigate 原样给模型）。
 */
export type LocalFileResult =
  | { ok: true; path: string }
  | { ok: false; reason: LocalPageRefusal; error: string };

/**
 * 输入 → 可以加载的本地文件真实路径。roots 是本会话能用的目录（不必存在——不在的跳过）。
 * realpath 可注入，测试用。
 */
export async function resolveLocalPage(
  input: string,
  roots: readonly string[],
  realpath: (path: string) => Promise<string> = fsRealpath,
): Promise<LocalFileResult> {
  const text = input.trim();
  const outside = (display: string): LocalFileResult => ({
    ok: false,
    reason: "outside",
    error:
      `${display} is outside the directories this session can use ` +
      "(session workbench, working directory, attached directories, browser downloads).",
  });
  // UNC 预判，必须在任何 fs 调用之前（与页面闸 localRequestAllowed 同一口径）：带主机名的
  // file:// 就是 UNC——Windows 的 fileURLToPath 会把它转成 \\\\host\\share\\…；裸输入的
  // \\\\host\\share\\…、//host/share/…（Windows 里两种分隔符等价）与 \\\\?\\UNC\\host\\share\\…
  // （设备命名空间的同一网络路径）同理。realpath 这种路径会让 Windows 先对那台主机发起 SMB
  // 连接（可能顺手把 NTLM 凭据送出去）再被根判定拒绝——连接不该发生。只有放行根本身就在
  // 那台主机的共享上（工作区在 NAS）才继续往下判。file:// 的主机名用 new URL 取：
  // fileURLToPath 自己也是这么解析的，两处判定不会分叉。
  let fileUrl: URL | null = null;
  if (/^file:\/\//i.test(text)) {
    try {
      fileUrl = new URL(text);
    } catch {
      fileUrl = null;
    }
  }
  const host = fileUrl?.hostname.toLowerCase() ?? uncHostOf(text);
  if (host !== null && host !== "" && host !== "localhost" && !roots.some((root) => uncHostOf(root) === host)) {
    return outside(text);
  }
  let path: string;
  try {
    path = /^file:\/\//i.test(text) ? fileURLToPath(text) : text;
  } catch {
    return { ok: false, reason: "invalid", error: `"${input}" is not a valid file address.` };
  }
  if (!isAbsolute(path)) return { ok: false, reason: "invalid", error: `"${input}" is not an absolute path.` };
  const notWebPage = (): LocalFileResult => ({
    ok: false,
    reason: "not-web-page",
    error: `Only web pages (.html, .htm, .xhtml, .svg) can be opened from disk; "${path}" is not one.`,
  });
  if (!isWebPageFile(path)) return notWebPage();
  let exists = true;
  try {
    await realpath(path);
  } catch {
    exists = false;
  }
  if (!exists) return { ok: false, reason: "missing", error: `The file ${path} does not exist.` };
  const real = await realpathInside(path, roots, realpath);
  if (real === null) return outside(path);
  // 类型也按真身判：改名成 foo.html 的链接指向 .txt / .pdf，浏览器会按真身渲染（与 fs:open-in-browser 同口径）
  if (!isWebPageFile(real)) return notWebPage();
  return { ok: true, path: real };
}

/**
 * UNC 根的主机名，小写；不是 UNC 回 null。认四种写法：`\\host\share`、`//host/share`
 * （Windows 里两种分隔符等价）、`\\?\\UNC\\host\\share` 与 `\\.\\UNC\\host\\share`（设备
 * 命名空间里同一网络路径的转写——不认它就绕得过 UNC 预判）；`\\?\\C:\…` 这类本地盘
 * 设备路径仍回 null。
 */
function uncHostOf(root: string): string | null {
  const device = /^\\\\[?.]\\unc\\([^\\/?.][^\\/]*)[\\/]/i.exec(root);
  if (device?.[1] !== undefined) return device[1].toLowerCase();
  const plain = /^[/\\]{2}([^\\/?.][^\\/]*)[\\/]/.exec(root);
  return plain?.[1]?.toLowerCase() ?? null;
}

/**
 * 页面闸的判定：一个 file:// 请求（主框架跳转、iframe、fetch、脚本、图片……）放不放行——
 * realpath 之后必须落在 roots 之一里。roots 为空（tab 从没经入口闸打开过本地网页）、
 * 不是 file://、地址坏了、文件不存在，一律不放。realpath 可注入，测试用。
 */
export async function localRequestAllowed(
  url: string,
  roots: readonly string[],
  realpath: (path: string) => Promise<string> = fsRealpath,
): Promise<boolean> {
  if (roots.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return false;
  // 带主机名的 file:// 就是 UNC（\\host\share\…）：realpath 它会让 Windows 去连那台主机（SMB，
  // 可能顺手把 NTLM 凭据送出去）。只有某个放行根本身就在那台主机的共享上才往下判，否则不碰盘直接拒
  const host = parsed.hostname.toLowerCase();
  if (host !== "" && host !== "localhost" && !roots.some((root) => uncHostOf(root) === host)) return false;
  let path: string;
  try {
    path = fileURLToPath(parsed);
  } catch {
    return false;
  }
  return (await realpathInside(path, roots, realpath)) !== null;
}

/**
 * 给受管浏览器的 partition 装页面闸（BrowserSandbox.guardSession 调，装一次）。rootsOf 按发起请求的
 * webContents 找它所在 tab 的放行根；找不到（弹窗、已关的 tab、没有 webContentsId 的请求）回空 = 不放。
 * Electron 对 file:// 的主框架、子框架与子资源都触发 onBeforeRequest（43.7 实测，见
 * local-file-guard.test.ts——Electron 升级若改了这个行为，那条测试会红）。
 */
export function guardLocalFileRequests(
  partition: Session,
  rootsOf: (webContentsId: number | undefined) => readonly string[],
): void {
  partition.webRequest.onBeforeRequest({ urls: ["file://*/*"] }, (details, callback) => {
    void localRequestAllowed(details.url, rootsOf(details.webContentsId)).then(
      (allowed) => callback({ cancel: !allowed }),
      () => callback({ cancel: true }),
    );
  });
}
