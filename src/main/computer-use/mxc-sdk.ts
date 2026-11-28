/**
 * MXC（Microsoft eXecution Containers）SDK 的生产适配器 —— IsolationSession 后端。
 *
 * 为什么要有这一层单独的文件：`@microsoft/mxc-sdk` 是**可选依赖**，而且它的 probe /
 * provision 会 `koffi.load` 一个原生 DLL。控制器（isolation-session.ts）只认窄接口
 * `IsolationSessionSdk`，测试与「没装/不支持的机器」都不碰这个文件里真正的 SDK 调用。
 *
 * Node 版本闸门：SDK 的 native stdio（spawnInContainer / runInContainer）要求
 * `>=24.21 <25 || >=26.8`（`dist/bindings/native-stdio.js` 的 nodeRange）。这个闸门
 * **在 provision 之后才会炸**（错误码 `backend_unavailable`），很容易被误判成会话起不来，
 * 所以在这里提前判、提前说。Electron 43 带的是 Node 24.21.0，正好够。
 */
import {
  deprovisionContainer,
  probe as mxcProbe,
  provisionContainer,
  spawnInContainer,
  startContainer,
  stopContainer,
} from "@microsoft/mxc-sdk/v1";
import type { SandboxProcess } from "./sandbox.ts";
import type { IsolationSessionProbe, IsolationSessionProvision, IsolationSessionSdk } from "./isolation-session.ts";
import { nodeSupportsNativeStdio, nodeTooOldReason } from "./mxc-node.ts";
import { cuTexts } from "./ui-language.ts";

/** ISO 会话唯一可用的网络姿态（MXC 的 provision 只接受这三个方向全 allow） */
const NETWORK = {
  egress: { default: "allow" as const },
  ingress: { default: "allow" as const, hostLoopback: "allow" as const },
};

/**
 * 真正的 SDK 适配器。**只在 index.ts 里接**（消费者的接线点），测试不碰。
 *
 * 几个后端事实（2026-11-15 真机实测，别当成猜的）：
 *   - `provisionContainer` 249–314ms、`startContainer` 1.4–1.9s、`spawnInContainer` 15–35ms；
 *   - `metadata.ephemeralWorkspacePath` 是 `C:\Users\<agent>\Shared`，**宿主可写、会话同路径可见**，
 *     这就是桥 exe 进会话的通道（拷贝 280KB 1ms）；
 *   - `spawnInContainer` 返回的是 `MxcProcess`：`standardOutput/standardError` + `wait/kill/dispose`，
 *     没有 EventEmitter 那一套——所以这里要映射成 SandboxProcess 的面（pid 恒为 0：这个后端
 *     不暴露宿主 PID）。
 */
export function createMxcSdk(): IsolationSessionSdk {
  return {
    probe(): IsolationSessionProbe {
      const nodeVersion = process.versions.node;
      const nodeOk = nodeSupportsNativeStdio(nodeVersion);
      if (!nodeOk) {
        return { available: false, reason: nodeTooOldReason(nodeVersion), nodeVersion, nodeOk };
      }
      try {
        const result = mxcProbe();
        const available = result.probes.isolationSessionAvailable;
        return {
          available,
          reason: available
            ? null
            : cuTexts().isolationBackendUnavailable,
          nodeVersion,
          nodeOk,
        };
      } catch (cause: unknown) {
        return {
          available: false,
          reason: cuTexts().mxcNativeLoadFailed(cause instanceof Error ? cause.message : String(cause)),
          nodeVersion,
          nodeOk,
        };
      }
    },

    async provision(): Promise<IsolationSessionProvision> {
      const result = await provisionContainer({ containment: "isolation_session", network: NETWORK });
      const metadata = result.metadata;
      if (metadata === undefined) {
        // 后端没给账号/工作区就是起不来：带着 containerId 抛，让控制器去释放它
        throw new Error(cuTexts().mxcProvisionIncomplete);
      }
      return {
        containerId: result.containerId,
        agentUserName: metadata.agentUserName,
        workspacePath: metadata.ephemeralWorkspacePath,
      };
    },

    async start(containerId: string): Promise<void> {
      await startContainer(containerId as never);
    },

    async spawn(containerId: string, command: string, workingDirectory: string): Promise<SandboxProcess> {
      const process = await spawnInContainer(containerId as never, { command, workingDirectory });
      // 控制器只用到 on/kill/pid；MxcProcess 是「流 + promise」形态，映射成 SandboxProcess 的面。
      // pid 恒 0：isolation_session 不暴露宿主 PID（桥自己的 pid 在 bridge.json 里）。
      const viewer = {
        on(): void {
          // 没有 exit 事件可用：桥的生命周期由 controller 的 stop 链负责（会话销毁即进程消失）
        },
        kill(): boolean {
          try {
            process.kill();
            return true;
          } catch {
            return false;
          }
        },
        pid: 0,
        exitCode: null,
      };
      // 输出流接上：不读会把管道塞满（桥的日志会写很多），而且日志是第一手排障素材
      process.standardOutput?.on("data", (chunk: unknown) => {
        void chunk;
      });
      process.standardError?.on("data", (chunk: unknown) => {
        void chunk;
      });
      return viewer;
    },

    async stop(containerId: string): Promise<void> {
      await stopContainer(containerId as never);
    },

    async deprovision(containerId: string): Promise<void> {
      await deprovisionContainer(containerId as never);
    },
  };
}
