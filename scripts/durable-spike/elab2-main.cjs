// Electron 壳：主进程只 fork 一个 utility 进程跑 bench 脚本（= orbita agent 进程的真实形态），
// stdio 用 pipe 再手动转发：Windows 上 utilityProcess 的 stdio: "inherit" 不透传（2026-11-06 G14 实测），
// Mac 两种都行。不开窗口、不碰硬件加速。
// 用法：<electron> elab2-main.cjs   （BENCH_UTILITY 环境变量指向 bench-du.mjs / bench-ca.mjs）
const { app, utilityProcess } = require("electron");
const path = require("node:path");
const { once } = require("node:events");

const utilityScript = process.env.BENCH_UTILITY;
if (!utilityScript) {
  console.error("需要环境变量 BENCH_UTILITY（被测脚本路径）");
  app.exit(2);
} else {
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const child = utilityProcess.fork(path.resolve(utilityScript), [], {
      serviceName: "orbita-spike2-agent",
      stdio: "pipe",
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    const [exit] = await once(child, "exit");
    app.exit(exit === 0 ? 0 : 1);
  });
}
