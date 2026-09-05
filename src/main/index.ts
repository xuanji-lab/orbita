/**
 * 主进程入口。职责边界（AGENTS.md「架构边界」）：只负责窗口、IPC 与持久化。
 * agent runtime 将跑在独立 utility 进程，不在这里 —— 见 docs/single-agent-guideline.md §二。
 */
import { preferIPv4 } from "../shared/dial-v4.ts";
import { app, BrowserWindow, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AgentHost, resolveRuntimePath } from "./agent/host.ts";
import { broadcastAgentEvent, registerAgentIpc } from "./agent/ipc.ts";
import { registerProviderIpc } from "./provider/ipc.ts";
import { registerSessionIpc } from "./session/ipc.ts";
import { createSessionRecorder } from "./session/recorder.ts";
import { SessionStore } from "./session/store.ts";
import { applyNativeTheme, registerSettingsIpc } from "./settings/ipc.ts";
import { SettingsStore } from "./settings/store.ts";
import { registerWorkspaceIpc } from "./workspace/ipc.ts";
import { WorkspaceStore } from "./workspace/store.ts";
import { SafeStorageSecrets } from "./provider/safe-storage-secrets.ts";
import { ProviderStore } from "./provider/store.ts";

// 出站固定 IPv4：双栈 WAF + 本机无全局 v6 的间歇超时，见 dial-v4.ts 的取证
preferIPv4();

/** 启用中的 skills。pi 只看这一个目录。 */
const SKILLS_DIR = "skills";
/** 停用的 skills。**仅供存放**，不交给 pi——启停就是在这两个目录间 rename。 */
const SKILLS_INACTIVE_DIR = "skills-inactive";

/**
 * 把两个 skills 目录先建出来。
 *
 * 建不出来不拦启动：没有 skills 目录是合法状态（一个都没装），为它让整个应用
 * 起不来是过度反应。但要留日志——不打印的话，一个权限坏掉的目录会表现成
 * 「skill 放了但没生效」，而那是最难查的一类问题。
 */
async function ensureSkillDirs(configDir: string): Promise<void> {
  for (const name of [SKILLS_DIR, SKILLS_INACTIVE_DIR]) {
    try {
      await mkdir(join(configDir, name), { recursive: true });
    } catch (error) {
      console.error(`[main] 建不了 ${name} 目录，skills 可能不生效`, error);
    }
  }
}

/** 26-entry-layer §9.2 安全不变量：三条都不许放松。 */
const SECURITY_INVARIANTS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
} as const;

/**
 * macOS 上的窗口形态。**边界卡就是窗口本身**——我们不画背景，背景是用户自己的桌面。
 *
 * 三个选项各有各的必须：
 *  - `titleBarStyle: "hidden"` —— 去掉标题栏但**留下红黄绿三个键**，让它们落进边界卡里。
 *    渲染层给侧栏顶部留出净空并标 `-webkit-app-region: drag`，否则窗口就拖不动了。
 *  - `vibrancy` —— CSS 的 `backdrop-filter` **模糊不了窗口背后的桌面**（合成器里根本没有那块内容），
 *    真正的「透出桌面」只能由系统材质给。边界卡在它上面再画一层 `--glass-bg`，
 *    合出来就是设计系统要的 layer 1。
 *  - `backgroundColor` 全透明 —— 否则不透明底色会盖掉 vibrancy。
 *
 * 非 macOS 没有等价物，退回不透明底色；边界卡的圆角那时由渲染层自己画。
 */
const MAC_WINDOW = {
  titleBarStyle: "hidden",
  trafficLightPosition: { x: 18, y: 19 },
  vibrancy: "under-window",
  // 失焦不要把整面 UI 变灰——安静的工作台不该闪
  visualEffectState: "active",
  backgroundColor: "#00000000",
} as const;

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "darwin"
      ? MAC_WINDOW
      : // 首帧之前窗口是空的；给一个中性底色，避免白闪（深浅由渲染层接管）
        { backgroundColor: "#f3f4f1" }),
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

  // 主题先于窗口生效：晚一步的话第一帧会用系统外观画出 vibrancy，然后当着用户的面跳一下
  const settings = new SettingsStore(configDir);
  registerSettingsIpc(settings);
  void settings.read().then(applyNativeTheme);

  // agent 跑在独立 utility 进程；主进程只转发事件，不加工（guideline §二）——
  // 唯一的例外是**落盘**，那本来就是主进程的职责，挂在同一条转发路径上是最短的一跳。
  const sessions = new SessionStore(join(configDir, "sessions"));
  const record = createSessionRecorder(sessions);
  const agentHost = new AgentHost(resolveRuntimePath(__dirname), (event) => {
    record(event);
    broadcastAgentEvent(event);
  });
  // 删除会话时把 runtime 里那条 pi 会话也放掉——不然每开一条任务就多一份驻留，
  // 活到退出应用（刀 0-4 债务 A）。会话分支（session:branch）也要走 agent 进程裁 pi 本子
  registerSessionIpc(sessions, (id) => agentHost.disposeSession(id), agentHost);
  // pi 的本子和我们的记录分开放，一眼看得出哪份归谁（guideline §四）
  // 两个 skills 目录先建出来：**空目录就是说明书**——用户打开 userData 看到
  // `skills/` 与 `skills-inactive/` 并排，「放进去生效、移出去失效」不需要再解释。
  // 只建 `skills/` 的话，停用该往哪儿移就得去翻文档了。
  void ensureSkillDirs(configDir);
  registerAgentIpc(
    agentHost,
    providers,
    sessions,
    join(configDir, "pi-sessions"),
    join(configDir, SKILLS_DIR),
  );
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
