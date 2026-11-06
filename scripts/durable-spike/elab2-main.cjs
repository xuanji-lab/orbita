// Electron 壳：主进程只 fork 一个 utility 进程跑 bench 脚本（= orbita agent 进程的真实形态），
// stdio 继承让 JSON 行协议流回驱动。不开窗口、不碰硬件加速。
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
      stdio: "inherit",
    });
    const [exit] = await once(child, "exit");
    app.exit(exit === 0 ? 0 : 1);
  });
}
