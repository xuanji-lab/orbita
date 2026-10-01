# pi patch 清单

适用精确锁版本 `@earendil-works/*` **0.84.3**。pi 升级后 patch 打不上时 `bun install`
会当场报错——按下面的意图在新版本上重打；重打前先确认新版是否已原生支持该行为，
支持了就直接删 patch。

## @earendil-works/pi-ai — 重试退避拍平为固定间隔

`dist/utils/retry.js`（`retryAssistantCall`）：

```diff
- const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);
+ const delayMs = policy.baseDelayMs;
```

## @earendil-works/pi-ai — api.kimi.com 认作 Moonshot 端点

`dist/api/openai-completions.js`（`detectCompat` 的 `isMoonshot`）：

```diff
- const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
+ const isMoonshot = provider === "moonshotai" ||
+     provider === "moonshotai-cn" ||
+     baseUrl.includes("api.moonshot.") ||
+     baseUrl.includes("api.kimi.com");
```

**为什么（2026-10-01）**：Kimi 官方 coding 端点迁到新域名 `api.kimi.com/coding/v1`，pi 0.84.3 的
域名识别表只认 `api.moonshot.*`——以 openai-compatible 自定义网关接入时被当标准 OpenAI 端点，
推理模型（k3 借目录参数 `reasoning:true`）的系统提示词以 `developer` 角色发出，Moonshot 服务端
400「role 'developer' is not allowed」。归入 `isMoonshot` 后一并继承该家族既有适配
（`supportsDeveloperRole:false`、不发 `reasoning_effort`、`max_tokens` 字段名等）。

**行为守卫**：`src/agent/kimi-compat-patch.test.ts`（`stream` + 假 fetch 断言首条消息角色，
同文件另有一条标准 OpenAI 端点仍用 `developer` 的反向断言）。

## @earendil-works/pi-coding-agent — 主对话链路重试退避拍平为固定间隔

`dist/core/agent-session.js`（`_prepareRetry`）：同一处指数公式 → 固定 `baseDelayMs`。

**为什么（2026-09-02，用户裁决）**：重试等待固定 5 秒一次，不要指数退避越等越久。
两条链路（主对话 auto_retry / 压缩摘要 summarization_retry）共用 `settings.retry`；
`src/agent/runtime.ts` 建会话时用 `applyOverrides` 显式注入 `maxRetries: 3, baseDelayMs: 5000`
——重试节奏由本应用自持，不继承用户 pi TUI 的 `~/.pi/agent/settings.json`。

**行为守卫**：`src/agent/retry-patch.test.ts`（pi-ai 链路；agent-session 的 `_prepareRetry`
无法脱离整套会话机器单测，pi 升级重打 patch 时人工核对这一处）。

## @earendil-works/pi-coding-agent — 公开入口导出 `resolveToCwd`

`dist/index.js` / `dist/index.d.ts`：追加一行 `export { resolveToCwd } from "./core/tools/path-utils.js"`。

**为什么（2026-10-01）**：会话回退的文件账（`src/agent/file-tracker.ts` 的 `resolveToolPath`）必须与
pi 的 write / edit 工具算出**同一个**绝对路径，而工具内部用的就是 `resolveToCwd`。它不在包的公开入口，
deep import 又被 `exports` 拦下（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。此前手抄的一份漏了 win32 的
MSYS 路径折算（`/c/Users/x` → `C:\Users\x`）、`~\` 展开与 `file://` 转换，工具写 A、账记 B，回退静默失效。

**行为守卫**：`src/agent/file-tracker.test.ts`（断言 `resolveToolPath === resolveToCwd`，并逐形态比对）。
pi 升级后若原生导出了它，删掉这两行 patch。
