/**
 * 主进程入口。职责边界（AGENTS.md「架构边界」）：只负责窗口、IPC 与持久化。
 * agent runtime 将跑在独立 utility 进程，不在这里 —— 见 docs/single-agent-guideline.md §二。
 */
import { preferIPv4 } from "../shared/dial-v4.ts";
import { app, BrowserWindow, shell } from "electron";
import { join } from "node:path";
import { AgentHost, resolveRuntimePath } from "./agent/host.ts";
import { broadcastAgentEvent, registerAgentIpc } from "./agent/ipc.ts";
import { registerProviderIpc } from "./provider/ipc.ts";
import { registerSessionIpc } from "./session/ipc.ts";
import { registerMcpIpc } from "./mcp/ipc.ts";
import { McpStore } from "./mcp/store.ts";
import { registerSkillIpc } from "./skill/ipc.ts";
import { SkillStore } from "./skill/store.ts";
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
  if (devServerUrl) {
    // 两类 dev 首载故障都会把窗口留在底色上（真实事故 2026-09-10：白屏只能手动 Ctrl+R）：
    // ① server 未就绪 loadURL 拒绝——退避重试；ready-to-show 没到窗口不可见，重试无感。
    // ② 首帧合成失败——页面加载零错误、DOM 完整，但画面停在窗口底色（reload 能救活）；
    //    落定后 executeJavaScript 探到内容即 invalidate() 强制重绘上屏。
    const load = (attempt: number): void => {
      window.loadURL(devServerUrl).catch(() => {
        if (window.isDestroyed() || attempt >= 10) return;
        setTimeout(() => load(attempt + 1), 500 * attempt);
      });
    };
    load(0);
    window.webContents.on("did-finish-load", () => {
      setTimeout(() => {
        void window.webContents
          .executeJavaScript(`Boolean(document.getElementById("root")?.children.length)`)
          .then((hasContent) => {
            if (hasContent) window.webContents.invalidate();
          })
          .catch(() => {});
      }, 1500);
    });
  } else void window.loadFile(join(__dirname, "../renderer/index.html"));

  return window;
}

void app.whenReady().then(() => {
  // 配置落在 Electron 的 userData 目录，不再依赖 pi 的 ~/.pi/agent。
  // 从旧 models.json / auth.json 的迁移等到真有旧数据的用户时再单独立项（落库纪律：没有消费者不写）。
  const configDir = app.getPath("userData");
  const providers = new ProviderStore(configDir, new SafeStorageSecrets(configDir));
  registerProviderIpc(providers);
  // workspace 的 IPC 在下面注册（要一并注入 skills 的连带清理，见 registerWorkspaceIpc）

  // 主题先于窗口生效：晚一步的话第一帧会用系统外观画出 vibrancy，然后当着用户的面跳一下
  const settings = new SettingsStore(configDir);
  registerSettingsIpc(settings);
  void settings.read().then(applyNativeTheme);

  // agent 跑在独立 utility 进程；主进程只转发事件，不加工（guideline §二）——
  // 唯一的例外是**落盘**，那本来就是主进程的职责，挂在同一条转发路径上是最短的一跳。
  const sessions = new SessionStore(join(configDir, "sessions"));
  const record = createSessionRecorder(sessions);
  const mcp = new McpStore(configDir);
  const agentHost = new AgentHost(resolveRuntimePath(__dirname), (event) => {
    // MCP 的连接状态由 agent 进程报上来（连接是它建的），主进程缓存最后一次快照给管理面看
    if (event.type === "mcp") mcpIpc.onAgentSnapshot(event.servers);
    // 续轮开机的 created 没有等待者（submit 带 resume 时不等）：在这里把 pi 本子
    // 真值校准回 meta——open 失败退回新建时 pi 会换文件，按轮自愈。
    // 首轮的 created 由 submit handler 等待并建 meta，不经过这里。
    if (event.type === "created" && event.piSessionFile !== null) {
      void sessions.setPiSessionFile(event.sessionId, event.piSessionFile).catch(() => undefined);
      return;
    }
    record(event);
    broadcastAgentEvent(event);
  });
  // MCP 的 IPC 面（1-1 起含热重载）。reload 回调闭包引用 agentHost——
  // 事件回调只在事件到达时执行，那时两边都已定义，不存在 TDZ 问题
  const mcpIpc = registerMcpIpc(mcp, (servers) => agentHost.mcpReload(servers));
  // 删除会话时把 runtime 里那条 pi 会话也放掉——不然每开一条任务就多一份驻留，
  // 活到退出应用（刀 0-4 债务 A）。会话分支（session:branch）也要走 agent 进程裁 pi 本子
  registerSessionIpc(sessions, (id) => agentHost.disposeSession(id), agentHost);
  // pi 的本子和我们的记录分开放，一眼看得出哪份归谁（guideline §四）
  /*
   * 中心存储与 global 集合先建出来：**空目录就是说明书**——用户打开 userData 看到
   * `skills/` 与 `skill-links/global/` 并排，「放进去、链上就生效」不需要再解释。
   * 建不出来不拦启动：没有目录是合法状态（一个都没装）。但要留日志——
   * 不打印的话，一个权限坏掉的目录会表现成「skill 放了但没生效」，那是最难查的一类。
   */
  const skills = new SkillStore(configDir);
  void skills.ensureDirs().catch((error: unknown) => {
    console.error("[main] 建不了 skills 目录，skills 可能不生效", error);
  });
  registerSkillIpc(skills);
  // 工作区移除时连带删它的 skill 集合目录（只是链接，不伤中心存储）
  registerWorkspaceIpc(new WorkspaceStore(configDir), (id) => skills.removeWorkspace(id));
  registerAgentIpc(
    agentHost,
    providers,
    sessions,
    join(configDir, "pi-sessions"),
    (workspaceId) => skills.linkDirs(workspaceId),
    mcp,
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
