/**
 * 主进程入口。职责边界（AGENTS.md「架构边界」）：只负责窗口、IPC 与持久化。
 * agent runtime 将跑在独立 utility 进程，不在这里 —— 见 docs/single-agent-guideline.md §二。
 */
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { AgentHost, resolveRuntimePath } from "./agent/host.ts";
import { broadcastAgentEvent, registerAgentIpc } from "./agent/ipc.ts";
import { registerProviderIpc } from "./provider/ipc.ts";
import { registerWorkspaceIpc } from "./workspace/ipc.ts";
import { WorkspaceStore } from "./workspace/store.ts";
import { SafeStorageSecrets } from "./provider/safe-storage-secrets.ts";
import { ProviderStore } from "./provider/store.ts";

/** 26-entry-layer §9.2 安全不变量：三条都不许放松。 */
const SECURITY_INVARIANTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    // 首帧之前窗口是空的；给一个中性底色，避免白闪（深浅由渲染层接管）
    backgroundColor: "#f3f4f1",
    webPreferences: {
      ...SECURITY_INVARIANTS,
      preload: join(__dirname, "../preload/index.js"),
    },
  });

  // 只在内容就绪后显示，避免空窗口先出现
  window.once("ready-to-show", () => window.show());

  // 外链走系统浏览器，不在应用内开新窗
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl) void window.loadURL(devServerUrl);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));

  return window;
}

void app.whenReady().then(() => {
  // 配置落在 Electron 的 userData 目录，不再依赖 pi 的 ~/.pi/agent。
  // 从旧 models.json / auth.json 的迁移等到真有旧数据的用户时再单独立项（落库纪律：没有消费者不写）。
  const configDir = app.getPath("userData");
  const providers = new ProviderStore(configDir, new SafeStorageSecrets(configDir));
  registerProviderIpc(providers);
  registerWorkspaceIpc(new WorkspaceStore(configDir));

  // agent 跑在独立 utility 进程；主进程只转发事件，不加工（guideline §二）
  const agentHost = new AgentHost(resolveRuntimePath(__dirname), broadcastAgentEvent);
  registerAgentIpc(agentHost, providers);
  app.on("before-quit", () => agentHost.dispose());

  createMainWindow();

  // macOS：点 dock 图标且无窗口时重开
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
