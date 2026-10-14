/**
 * 受管浏览器页面的身份补丁（preload）。先于页面脚本、在每个文档（含首个文档与 iframe）
 * 的主世界跑——PAGE_PREFERENCES 为它关了 contextIsolation：它不 require、不持任何能力，
 * 只做属性补丁，主世界里没有可被页面抢走的东西。
 *
 * 为什么存在：`session.setUserAgent()` 清洗 UA 后，Chromium 停发 Sec-CH-UA 系列头、
 * `navigator.userAgentData` 里也没有 "Google Chrome" 品牌——UA 字符串自称 Chrome/150，
 * 头与 JS 两侧却对不上，Google 登录风控据此拒绝（/v3/signin/rejected，2026-10-14 实测）。
 * HTTP 头侧在主进程 `main/browser/identity.ts` 的 browserClientHints() 补；这里补 JS 侧。
 *
 * 版本号与平台值全部从原生对象现场取（UA 字符串、原生 userAgentData），只往里塞
 * "Google Chrome" 品牌——Electron / Chromium 升级不需要回来改这里。
 *
 * 之前走过 CDP `Page.addScriptToEvaluateOnNewDocument` 的弯路：注册晚于 tab 首个文档的
 * 创建，恰恰漏掉登录页那一跳（2026-10-14 隔离实例验收实测）。preload 没有这个问题。
 */

interface BrandVersion {
  brand: string;
  version: string;
}

interface NativeUserAgentData {
  brands: BrandVersion[];
  mobile: boolean;
  platform: string;
  getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>>;
}

(() => {
  const nav = navigator as Navigator & { userAgentData?: NativeUserAgentData };
  const nativeData = nav.userAgentData;
  if (nativeData === undefined) return;
  const major = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? "";
  const fullVersion = navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "";
  if (major === "") return;
  // 已经有 Google Chrome 品牌（真 Chrome）就不动
  if (nativeData.brands.some((b) => b.brand === "Google Chrome")) return;

  const brands = Object.freeze([...nativeData.brands, { brand: "Google Chrome", version: major }]);
  const mobile = nativeData.mobile;
  const platform = nativeData.platform;
  const nativeGet = nativeData.getHighEntropyValues.bind(nativeData);
  const userAgentData = {
    brands,
    mobile,
    platform,
    // 高熵值全走原生（platformVersion / arch 等原生值本来就是对的，自己算只会算错），
    // 只往 brands / fullVersionList 里塞 Google Chrome
    getHighEntropyValues: (hints: string[]) =>
      nativeGet(hints).then((values) => {
        const patched = { ...values };
        if (Array.isArray(values.fullVersionList)) {
          patched.fullVersionList = [...values.fullVersionList, { brand: "Google Chrome", version: fullVersion }];
        }
        if (values.brands !== undefined) patched.brands = brands;
        return patched;
      }),
    toJSON: () => ({ brands, mobile, platform }),
  };
  try {
    Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get: () => userAgentData });
  } catch {
    // 装不上就保持原生：登录可能被拒，但不影响浏览
  }

  // window.chrome：真 Chrome 有 app / csi / loadTimes / runtime，Electron 只有一个空对象——
  // 缺什么补什么地 merge（"chrome" in window 在 Electron 里恒真，不能靠它判断）
  try {
    const w = globalThis as unknown as { chrome?: Record<string, unknown> };
    const chromeTarget = w.chrome ?? (w.chrome = {});
    if (!("app" in chromeTarget)) {
      chromeTarget.app = {
        isInstalled: false,
        InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
        RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
        getDetails: () => null,
        getIsInstalled: () => false,
        installState: "not_installed",
        runningState: "cannot_run",
      };
    }
    if (!("csi" in chromeTarget)) {
      chromeTarget.csi = () => ({ onloadT: Date.now(), pageT: 0, startE: Date.now(), tran: 15 });
    }
    if (!("loadTimes" in chromeTarget)) {
      chromeTarget.loadTimes = () => ({
        commitLoadTime: 0,
        connectionInfo: "h2",
        finishDocumentLoadTime: 0,
        finishLoadTime: 0,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: 0,
        navigationType: "Other",
        npnNegotiatedProtocol: "h2",
        requestTime: 0,
        startLoadTime: 0,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      });
    }
    if (!("runtime" in chromeTarget)) {
      chromeTarget.runtime = {
        OnInstalledReason: {
          CHROME_UPDATE: "chrome_update",
          INSTALL: "install",
          SHARED_MODULE_UPDATE: "shared_module_update",
          UPDATE: "update",
        },
        OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
        PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
        PlatformOs: {
          ANDROID: "android",
          CROS: "cros",
          FUCHSIA: "fuchsia",
          LINUX: "linux",
          MAC: "mac",
          OPENBSD: "openbsd",
          WIN: "win",
        },
        RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
      };
    }
  } catch {
    // 同上：装不上就保持原生
  }
})();
