/**
 * local-file-guard.test.ts 的 Electron 端：在真 Chromium 里验 file:// 闸（#365）。
 * 由测试用 Electron 二进制起（`electron local-file-guard.electron.cjs`），不是产品代码，也不进打包。
 *
 * 夹具：<base>/root/page.html（根内）+ root/assets/*（根内子资源）+ <base>/outside/secret.txt（根外），
 * root/linkout 是指向 outside 的 junction（#365 原样）。page.html 用四种方式去够根外的文件：
 * 绝对地址的 iframe / fetch、穿过 linkout 的 iframe / fetch；加载完再用 JS 把自己跳到根外。
 *
 * 跑两遍：先在**没装闸**的 partition 上跑——证明这份夹具不设防时确实读得到根外（前提断言，
 * 不然「装闸后读不到」可能只是夹具本身就读不到）；再在装了产品闸（guardLocalFileRequests）的
 * partition 上跑同一页。结果一行 `RESULT <json>` 打到 stdout。
 *
 * **为什么是 CJS、产品模块在 try 里 require**：入口脚本加载失败（比如产品函数被改名）时，
 * Electron 的 default_app 会弹「Error launching app」模态框并一直等人点——跑测试时它会出现在
 * 用户桌面上抢焦点（2026-10-28 写这个测试时在未修复代码上真弹过一次，60 秒后被超时杀掉）。
 * 这里把加载失败、之后的未捕获异常、超时全部接住，打一行 RESULT 就退出，永远不弹框。
 *
 * 不碰桌面：窗口 show:false、Dock 图标先藏、userData 指到临时目录、partition 不持久化。
 */
const { app, BrowserWindow, session } = require("electron");
const { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

if (app.dock !== undefined) app.dock.hide();
// 第一遍的窗口销毁后不能让应用自己退出（默认「窗口全关 = 退出」，第二遍的加载会 ERR_FAILED）；
// 什么时候退由 finish() 说了算
app.on("window-all-closed", () => {});

let base = "";
let finished = false;
/** 打一行结果就退：成功、失败、超时都走这里，绝不留进程、绝不弹框。等 stdout 写完再退（mac 上管道是异步写） */
function finish(output, code) {
  if (finished) return;
  finished = true;
  try {
    if (base !== "") rmSync(base, { recursive: true, force: true });
  } catch {
    // 临时目录删不掉不影响结论
  }
  process.stdout.write(`RESULT ${JSON.stringify(output)}\n`, () => app.exit(code));
}
const describeError = (cause) => String(cause && cause.stack ? cause.stack : cause);
process.on("uncaughtException", (cause) => finish({ error: describeError(cause) }, 1));
process.on("unhandledRejection", (cause) => finish({ error: describeError(cause) }, 1));
setTimeout(() => finish({ error: "timeout: probe did not finish in 25 s" }, 1), 25_000);

let guardLocalFileRequests = null;
try {
  guardLocalFileRequests = require("./local-file.ts").guardLocalFileRequests;
} catch (cause) {
  finish({ error: `cannot load ./local-file.ts: ${describeError(cause)}` }, 1);
}
if (typeof guardLocalFileRequests === "function") main();
else finish({ error: "./local-file.ts does not export guardLocalFileRequests" }, 1);

/** 夹具 + 两遍运行：只在产品模块加载成功后才走到这里 */
function main() {
  base = realpathSync(mkdtempSync(join(tmpdir(), "orbita-file-guard-")));
  app.setPath("userData", join(base, "userData"));

  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-SECRET");
  writeFileSync(join(root, "assets", "inside.txt"), "INSIDE-OK");
  writeFileSync(join(root, "assets", "app.js"), "window.scriptRan = true;");
  symlinkSync(outside, join(root, "linkout"), "junction");
  const outsideUrl = pathToFileURL(join(outside, "secret.txt")).href;
  writeFileSync(
    join(root, "page.html"),
    `<!doctype html><title>guard</title><body>
<iframe id="abs" src="${outsideUrl}"></iframe>
<iframe id="rel" src="linkout/secret.txt"></iframe>
<iframe id="ok" src="assets/inside.txt"></iframe>
<script src="assets/app.js"></script>
<script>
window.results = {};
const grab = (key, url) => fetch(url).then((r) => r.text()).then((t) => { results[key] = t; }, (e) => { results[key] = "ERR " + e; });
window.fetched = Promise.all([
  grab("fetchAbs", ${JSON.stringify(outsideUrl)}),
  grab("fetchRel", "linkout/secret.txt"),
  grab("fetchOk", "assets/inside.txt"),
]);
window.addEventListener("load", () => {
  for (const id of ["abs", "rel", "ok"]) {
    try { results["iframe_" + id] = document.getElementById(id).contentDocument.body.innerText; }
    catch (e) { results["iframe_" + id] = "ERR " + e.message; }
  }
  results.scriptRan = window.scriptRan === true;
});
</script></body>`,
  );

  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 在一个 partition 上跑一遍夹具页，返回页面里收集到的结果 + 跳转与主进程加载的结局 */
  async function run(partitionName, guarded) {
    const partition = session.fromPartition(partitionName);
    // 闸先装、窗口后建——与产品同序（BrowserSandbox.createWindow 先 guardSession 再建 tab）
    let tabId = -1;
    if (guarded) guardLocalFileRequests(partition, (id) => (id === tabId ? [root] : []));
    const win = new BrowserWindow({
      show: false,
      webPreferences: { partition: partitionName, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    const contents = win.webContents;
    tabId = contents.id;
    await contents.loadURL(pathToFileURL(join(root, "page.html")).href);
    await contents.executeJavaScript("window.fetched");
    await pause(300);
    const page = JSON.parse(await contents.executeJavaScript("JSON.stringify(window.results)"));
    // 页面自己跳到根外：agent 的 browser_extract 读的就是跳过去之后的正文
    await contents.executeJavaScript(`location.href = ${JSON.stringify(outsideUrl)}; 1`);
    await pause(600);
    const afterNav = await contents.executeJavaScript("document.body ? document.body.innerText : ''");
    // 主进程直接 loadURL 根外（闸对主框架同样生效：tab 的放行根里没有它）
    const mainLoad = await contents.loadURL(outsideUrl).then(
      () => "loaded",
      (cause) => `rejected ${cause && cause.code ? cause.code : String(cause)}`,
    );
    win.destroy();
    return { page, afterNav, mainLoad };
  }

  app.whenReady().then(async () => {
    try {
      const unguarded = await run("orbita-guard-probe-open", false);
      const guarded = await run("orbita-guard-probe-guarded", true);
      finish({ unguarded, guarded }, 0);
    } catch (cause) {
      finish({ error: describeError(cause) }, 1);
    }
  });
}
