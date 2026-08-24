[AI 生成]

# Provider 单一定义（Provider Schema）提案

> 状态：**proposal**（2026-08-24，wafo 会话产出；等 R10 访谈答复后定稿，定稿前**不改任何 UI**）
> 维护：wafo
> 讨论：`docs/orbita-ui-decision-interview.md` Round 10（R10-01 … R10-07）
> 待决：R10 全部
> 关系：设置页/模型配置面的重做是**症状**，病根是「provider 没有单一定义」——本文先给定义，再谈界面（与 UI 重构同法：spec → 决策 → 表面）。

---

## 0. 一句话

今天「一个 provider」被四份互不相识的类型描述（renderer `configTypes.ts` / main `ConfigManager.ts` / `SdkProcess.PiModelsFileLite` / pi-adapter `CustomProviderConfig`），散落在三个文件（`models.json` / `auth.json` / `settings.json`）与一张 renderer 硬编码表（`KNOWN_PROVIDER_ENDPOINTS`），**写入由 renderer 决定形状、main 只做最薄的存在性校验、内核读的是第五种形状**。提案：Provider 是 main 进程独占的一等配置对象，有单一 schema、在 IPC 边界校验、声明模型与发现模型分离、能力旗标按模型归属，renderer 只拿 DTO。

---

## 1. 现状盘点（只读，file:line）

### 1.1 读 / 写点总表

| # | 层 | 位置 | 做什么 | 字段 | 存储 | 备注 |
|---|---|---|---|---|---|---|
| 1 | main | `src/main/config/ConfigManager.ts:25-66` | 定义 `PiModelItem` / `PiProviderConfig` / `PiModelsFile` / `PiAuthFile` / `PiSettings` | baseUrl / api / apiKey / models（含 cost） / `[key:string]:unknown` | 类型 | **形状 ①**（main 视角，开放字段） |
| 2 | main | `ConfigManager.ts:98-112` | 读四个 JSON 文件（带 diagnostic） | 全部 | `~/.pi/agent/{models,auth,settings,trust}.json` | 目录常量 `PI_AGENT_DIR`:16 |
| 3 | main | `ConfigManager.ts:190-196` | `saveModelsConfig`：validateModels → normalizeModelsForPi → 写 | providers / models[].id / api 别名迁移 | models.json | **校验只查 providers 存在 + models 为数组 + id 为字符串**（:231-255）；不校验 baseUrl/apiKey/compat/headers |
| 4 | main | `ConfigManager.ts:198-207` | `saveAuthConfig` / `saveSettingsConfig` | 任意 | auth.json / settings.json | **零校验**直写 |
| 5 | main | `ConfigManager.ts:210-228` | `saveRawConfig`：仅 `JSON.parse` 可解析 + 文件名白名单 | 任意 | 四文件任一 | **绕过 validateModels** 的后门（RawTab 用） |
| 6 | main | `ConfigManager.ts:317-322` | `writeJsonFile` = `mkdir` + `writeFile` | — | 四文件 | **非原子写**（违反 AGENTS.md 工程约定「关键元数据走临时文件+rename」） |
| 7 | main | `ConfigManager.ts:330-521` | `fetchProviderModels`：按 apiType 构造 `/models` 请求（多路径回退）、解析 | baseUrl / apiKey / apiType | 网络（electron `net.fetch`） | 「发现模型」唯一实现；结果只回 renderer，不落盘 |
| 8 | main | `ConfigManager.ts:523-630, 830-935` | `buildTestRequest` / `testProviderConnection`：最小聊天请求（`max_tokens:1`），45s 超时，返回 model/snippet/tokens/latency、建议 baseUrl | baseUrl / apiKey / model / apiType / headers | 网络 | 验证的是「HTTP 可达 + 鉴权通过 + 该 model 能回 1 token」；**不验** compat 旗标、流式、工具调用、reasoning |
| 9 | main | `ConfigManager.ts:650-672` | `normalizeApiType`：6 种 api 名归一（含历史别名） | api | — | renderer 另有一份 `PROVIDER_API_OPTIONS`（#20） |
| 10 | main | `ConfigManager.ts:682-712` | 请求头归一 + 按 api 补 SDK 默认 `User-Agent` + `redactSecret`（把 apiKey 从 url/body 里替换成 `***`） | headers / apiKey | — | 脱敏只覆盖**测试结果回显**；其它路径 apiKey 明文往返 |
| 11 | main | `ConfigManager.ts:936-986` | `exportConfig` / `importConfig`（打包四文件） | 全部 | 四文件 | 导入同样无 schema 校验 |
| 12 | main | `src/main/config/ipc.ts:18-60` | 注册 `config:*` 12 条通道 handler | — | — | IPC 第 ② 层；`config:fetch-models` / `config:test-provider` 参数由 renderer 拼（#18/#19） |
| 13 | main | `src/main/orbita/sdk/SdkProcess.ts:176-256` | `PiModelsFileLite` + `readCustomModelConfig`：读 models.json → `Model[]`（含 compat、baseUrl）+ `apiKeys` Map + `CustomProviderConfig[]` | baseUrl / api / apiKey / compat / models | models.json（直读，不经 ConfigManager） | **形状 ②**；api 只认 3 种，`google-generative-ai` / `mistral-conversations` / `openai-codex-responses` **静默折叠为 `openai-completions`**（:219-224）；**不读 headers** |
| 14 | main | `SdkProcess.ts:898-900, 944-951` | 装配：`createPiAIStreamFn({ customProviders, credentialStore })` | — | 内存 | 每个 tab 的 SdkProcess 各读一遍 models.json（无缓存、无监听） |
| 15 | main | `SdkProcess.ts:1267-1290` | `createCredentialStore`：**只读**桥，models.json 的 `apiKey` → pi-ai `api_key` 凭证 | apiKey | 内存 | 注释明写「写路径未接入」；**`auth.json` 不在此链路**（SdkProcess 头注释 :19「auth.json 接入为后续工作」） |
| 16 | main | `SdkProcess.ts:1355-1399` | `listAvailableModels`：custom（models.json 全量）+ builtin（pi-ai `getAvailable()` 按凭证过滤；失败回退目录全量） | models | 内存 | 「可用模型」= 声明 ∪ 内置已鉴权，**不含 fetchProviderModels 的发现结果** |
| 17 | main | `src/main/sessions/session-summarizer.ts:21, 46-62` | 复用 `readCustomModelConfig` 装配摘要模型；取 `apiKeys` **首个值**做凭证 | apiKey / models | models.json | 多 provider 时取首个 key（与 custom-providers.ts 头注释点名的旧病同型） |
| 18 | renderer | `src/renderer/src/ConfigModal.tsx:340-395` | 打开设置时：auth 有 key 而 models 无模型的 provider → 用 `KNOWN_PROVIDER_ENDPOINTS` 或 models.json baseUrl **自动拉模型**（后台、静默失败） | apiKey（来自 auth.json）/ baseUrl / apiType | 内存 | renderer 持有 auth.json 明文 key 并拿它发 IPC |
| 19 | renderer | `ConfigModal.tsx:655-700, 720-745` | 手动「获取模型」/「测试连接」：把 provider 的 baseUrl/apiKey/api/headers 原样塞进 IPC | baseUrl / apiKey / api / headers / modelId | — | 测试成功且返回 `suggestedBaseUrl` 时 **renderer 自动改写** provider.baseUrl（:735-742） |
| 20 | renderer | `ConfigModal.tsx:861-880` | `handleSaveModels`：保存前给每个 provider 补 `compat:{supportsDeveloperRole:false,supportsReasoningEffort:false,...}` | compat | → `config:save-models` | **形状由 renderer 决定**：两个布尔默认值写死在 renderer |
| 21 | renderer | `ConfigModal.tsx:975-1000` | `handleSaveAuth` / `handleSaveSettings` / `handleSaveTrust` / `handleSaveRaw` | 全部 | → 四文件 | trust 走 `saveRaw` 文本写入 |
| 22 | renderer | `src/renderer/src/config/configTypes.ts:9-36` | `ProviderCompat` / `ModelItem` / `ProviderConfig` / `ModelsFile` / `AuthFile` / `SettingsFile` | compat（supportsDeveloperRole / supportsReasoningEffort / `[key]:unknown`）/ thinkingLevelMap / input / contextWindow / maxTokens | 类型 | **形状 ③**（renderer 视角，唯一声明 compat 两个旗标名的地方） |
| 23 | renderer | `src/renderer/src/config/ModelsTab.tsx:16-41` | `KNOWN_PROVIDER_FIELDS`（baseUrl/api/apiKey/headers/authHeader/models/modelOverrides/compat/oauth）/ `KNOWN_MODEL_FIELDS`（…/headers/compat） | 字段白名单 | — | 「未知字段」只是 UI 折叠到「其它」区，不拒绝 |
| 24 | renderer | `ModelsTab.tsx:208-216, 714-752` | compat 编辑（两个 checkbox，互相 `??= false`） | compat | 内存 → #20 | 旗标是 **provider 级**；KNOWN_MODEL_FIELDS 允许 model 级 compat 但**无 UI** |
| 25 | renderer | `ModelsTab.tsx:540-580` | apiKey 用 `SecretInput`（`type=password` + 眼睛 + 复制）；User-Agent 走 `headers["User-Agent"]`（预设下拉 + 自定义） | apiKey / headers | 内存 | 脱敏 = 输入框遮罩；state 与 IPC 里都是明文 |
| 26 | renderer | `src/renderer/src/config/providerHeaders.ts:1-64` | User-Agent 预设表、`getProviderHeaders/getHeaderValue/setHeaderValue` | headers | — | 这些 headers 只进 #8 测试请求；**不进内核会话**（#13 不读、pi-adapter `buildCustomProvider` 不带 headers，见 #29） |
| 27 | renderer | `providerHeaders.ts:66-110` | `PROVIDER_API_OPTIONS`（6 种）/ `API_TYPE_LABELS` / 描述 | api | — | 与 #9（main 6 种）一致，与 #13（内核 3 种）**不一致** |
| 28 | renderer | `providerHeaders.ts:112-142` | `KNOWN_PROVIDER_ENDPOINTS`：18 家 → baseUrl + apiType | baseUrl / api | **硬编码在 renderer** | 「已知 provider 目录」住在 UI 层，main/内核不知道 |
| 29 | sdk | `orbita-sdk/pi-adapter/src/custom-providers.ts:26-46, 64-100` | `CustomProviderConfig`（api 仅 3 种）→ `buildCustomProvider`：模型只带 id/name/api/provider/baseUrl/contextWindow/maxTokens/reasoning，**丢 compat / headers / input / cost** | — | 内存 | **形状 ④**；显式 apiKey 优先，否则 `envApiKeyAuth` |
| 30 | sdk | `orbita-sdk/pi-adapter/src/stream-fn.ts:210-229` | `constructPiModel`：`Model.compat` / `Model.headers` 透传给 pi-ai | compat / headers | — | 但 #13 装配的 `Model` 没有 headers；compat 有（来自 provider.compat 复制到每个 model）。**两条路径不一致**：自定义 provider 走 #29（丢 compat）还是走 #30（带 compat），取决于 pi-ai 解析时命中哪个 Model 对象 —— 待本机实测 |
| 31 | shared | `src/shared/ipc.ts:223-236` | `config:get/save-{models,auth,settings}` / `save-raw` / `export` / `import` / `fetch-models` / `test-provider` | — | — | 契约层只有通道名，**没有 payload 类型**（`src/shared/types.ts` 里只有 `AvailableModel`:314 / `AppSettings`:335，无 Provider 类型） |
| 32 | preload | `src/preload/api/content.ts` / `settings.ts` | 透传 | — | — | 无校验（按设计） |
| 33 | renderer | `src/renderer/src/config/AuthTab.tsx:138+` | 编辑 auth.json（provider → `{type, key}`） | apiKey | auth.json | 写入后**内核不读**（#15）；只被 #18 的自动发现消费 |
| 34 | renderer | `src/renderer/src/config/RawTab.tsx` | 源文件编辑器 → `config:save-raw` | 任意 | 四文件 | 绕过校验（#5） |
| 35 | renderer | `src/renderer/src/previewApi.ts` | preview mock：`config.*` 返回空/假数据 | — | — | `?browserPreview=1` 时设置页可开但无真实数据 |

### 1.2 compat 类旗标（谁定义、谁消费）

| 旗标 | 定义处 | 写入处 | 消费处 | 结论 |
|---|---|---|---|---|
| `supportsDeveloperRole` | renderer `configTypes.ts:10` | renderer `ModelsTab.tsx:720-726` → models.json `providers.*.compat` | pi-ai（经 #13 `Model.compat` → #30 透传；#29 路径丢失） | provider 级写、model 级透传；内核是否真读到取决于 #29/#30 哪条命中 |
| `supportsReasoningEffort` | 同上 :11 | 同上 :739-745 | 同上 | 同上 |
| `reasoning`（模型能推理） | main `PiModelItem.reasoning`、renderer `ModelItem.reasoning`、sdk `CustomModelConfig.reasoning` | renderer 模型编辑 | #13 `Model.reasoning` → #29/#30 | model 级，三处类型各写一遍 |
| `thinkingLevelMap` | renderer `configTypes.ts:5-7, 18` | renderer | **无消费者**（main/sdk 均未出现） | 死字段（pi CLI 时代遗留） |
| `input`（text/image） | main/renderer 类型 | renderer | #29 写死 `["text"]`；#13 不读 | 声明了也不生效 |
| `cost` | main `PiModelItem.cost` | renderer（KNOWN_MODEL_FIELDS） | #29/#30 写死 0 | 声明了也不生效 |
| `headers`（provider/model 级） | renderer `configTypes`（开放字段） | renderer `providerHeaders.ts` | 仅 #8 测试连接 | **不进会话** |
| `authHeader` / `modelOverrides` / `oauth` | renderer `KNOWN_PROVIDER_FIELDS` | 无 UI | 无 | 白名单里的幽灵字段 |

### 1.3 存储文件

| 文件 | 路径 | 读者 | 写者 | 校验 |
|---|---|---|---|---|
| models.json | `~/.pi/agent/models.json`（WSL 时经 `configureWsl` 改目录，ConfigManager.ts:92） | ConfigManager（UI）、SdkProcess（内核，每 tab 一读）、session-summarizer | ConfigManager.saveModelsConfig / saveRawConfig / importConfig | 仅 providers/models/id 存在性 |
| auth.json | 同目录 | ConfigManager（UI 自动发现） | saveAuthConfig / saveRaw / import | 无 |
| settings.json | 同目录 | ConfigManager（RawTab 默认文件） | saveSettingsConfig / saveRaw / import | 无 |
| trust.json | 同目录 | ConfigManager trust API | saveRaw / ensureTrustedDirectory | 无 |
| 环境变量 | `OPENAI_API_KEY` 等 | pi-ai `envApiKeyAuth`（#29 无显式 key 时） | — | — |

### 1.4 「测试连接」今天验证什么

`ConfigManager.testProviderConnection`（#8）：用 provider 的 baseUrl+apiKey+apiType+headers 对**一个指定 model** 发一条 `max_tokens:1` 的最小聊天请求（openai-completions/responses/codex/anthropic/google/mistral 各自端点），成功 = HTTP 2xx 且能解析出 model/snippet；附带 `suggestedBaseUrl`（检测补了 `/v1` 而配置没有时提示）。**不验证**：compat 旗标是否正确、流式是否可用、工具调用是否可用、reasoning 参数是否被接受、该 provider 下其它模型。

### 1.5 secrets 脱敏

- UI：`SecretInput` 遮罩（#25），可一键显示/复制。
- IPC：`config:get-models` / `config:get-auth` 把明文 key 整文件送进 renderer；renderer state 长期持有。
- 日志/回显：只有测试连接结果做了 `redactSecret`（#10）。
- 内核：models.json 的 key 经只读 CredentialStore 给 pi-ai（#15）；auth.json 的 key **不到内核**。

### 1.6 renderer 绕过 main 校验的写路径

1. `RawTab` → `config:save-raw`（#5/#34）：任意 JSON 直写四文件。
2. `config:save-auth` / `config:save-settings`（#4）：main 无校验等于 renderer 直写。
3. `handleSaveModels` 的 compat 默认值（#20）与 `applySuggestedBaseUrl` 自动改 baseUrl（#19）：业务规则住在 renderer。

---

## 2. 提案：Provider 是什么（一页）

### 2.1 定义

```ts
// 唯一真源：src/shared/provider.ts（契约层；main 拥有实现，renderer 只拿 DTO）
type ProviderId = string;                         // 稳定标识（用户可改显示名，id 不改）

interface Provider {
  id: ProviderId;
  displayName: string;
  endpoint: {
    baseUrl: string;                              // 规范化后（main 负责 /v1 归一，renderer 不再自动改写）
    api: "openai-completions" | "openai-responses" | "openai-codex-responses"
       | "anthropic-messages" | "google-generative-ai" | "mistral-conversations";
    headers?: Record<string, string>;             // 进会话也进测试（同一份）
  };
  auth:
    | { scheme: "api_key"; secretRef: SecretRef }  // 不内联明文
    | { scheme: "env"; envKeys: string[] }
    | { scheme: "oauth"; oauthId: string }
    | { scheme: "none" };
  models: {
    declared: ModelDecl[];                        // 用户/导入声明，持久化
    discovered?: { fetchedAt: number; items: ModelDecl[] }; // /models 发现结果，缓存可过期，可提升为 declared
  };
  defaults?: Partial<ModelCapabilities>;          // provider 级默认，被 model 级覆盖
}

interface ModelDecl {
  id: string; name?: string;
  contextWindow?: number; maxTokens?: number;
  capabilities?: Partial<ModelCapabilities>;      // 覆盖 provider.defaults
}

interface ModelCapabilities {                     // 今天散落的 compat/reasoning/input 收敛于此
  reasoning: boolean;
  developerRole: boolean;                         // ← supportsDeveloperRole
  reasoningEffort: boolean;                       // ← supportsReasoningEffort
  input: Array<"text" | "image">;
  toolCalling: boolean;                           // 新：测试连接可探测
  streaming: boolean;                             // 新：测试连接可探测
}

type SecretRef = { kind: "keychain"; account: string } | { kind: "file"; id: string }; // R10-03 决定
```

### 2.2 主权与边界

| 规则 | 含义 | 替代今天的 |
|---|---|---|
| **main 独占** | Provider 对象只在 main 构造/变更/持久化；renderer 经 `provider:list/upsert/remove/test/discover` 拿 `ProviderDTO`（secret 永远是 `SecretRef` + `masked: "sk-…abcd"`） | #18/#19/#20/#25 renderer 持明文、定形状 |
| **边界校验** | `provider:upsert` 入口用 schema（zod，已在 cell-base 依赖）校验；非法 → 结构化错误回 renderer，不落盘 | #3 的存在性校验、#4/#5 零校验 |
| **原子写** | 临时文件 + rename（AgentManager 既有模式） | #6 `writeFile` |
| **一份 api 枚举** | 六种 api 名只在 shared 定义；内核不支持的三种在 **装配时显式报错/降级并告知**，不再静默折叠 | #9/#13/#27 三份 |
| **声明 vs 发现** | `discovered` 是缓存（带 fetchedAt），列表 UI 区分两者；发现结果需用户「提升」才进 declared | #7 结果不落盘、#16 可用模型不含发现 |
| **能力旗标按模型归属** | provider.defaults + model.capabilities 覆盖；UI 编辑 model 级，provider 级只是默认 | #24 provider 级两个 checkbox |
| **headers 同源** | 测试与会话用同一份 `endpoint.headers` | #26 只进测试 |
| **内核读 Provider 不读文件** | SdkProcess/session-summarizer 经 main 的 ProviderRegistry 取装配参数，不再各自 `readFile(models.json)` | #13/#17 |

### 2.3 迁移（现有用户设置）

1. 启动时若 `~/.pi/agent/providers.json`（新文件，R10-07 决定名字）不存在：从 `models.json` + `auth.json` **一次性推导**——
   `providers.*` → `Provider`；`apiKey` → 迁入 secret store 并写 `SecretRef`；`auth.json[provider].key` 若 models.json 无对应 → 生成 `declared: []` 的 provider（auth-only），补 `endpoint` 用 `KNOWN_PROVIDER_ENDPOINTS`（表迁到 main）；`compat.*` → `defaults`；`thinkingLevelMap` / `authHeader` / `modelOverrides` / `oauth` → 记入 `migration.dropped[]` 并在 UI 提示一次。
2. 迁移后 models.json **继续写**（只读兼容镜像，供 pi CLI / 旧路径）还是冻结 → R10-07。
3. RawTab 保留但只编辑 `providers.json`，且保存走同一 schema 校验（不再有后门）。

### 2.4 明确不做（本提案范围外）

- 不动设置页 UI（R10 答复后单独整面 slice + 截图验收）。
- 不碰编排侧模型选择（若 R10-05 决定共用 schema，则编排只是另一个读者）。
- 不实现 oauth 流程（只预留 `auth.scheme: "oauth"`）。

---

## 3. 与 R10 访谈的对应

| R10 | 本文待决点 |
|---|---|
| R10-01 | 声明 vs 发现（§2.1 `models.declared/discovered`、§2.2 第 5 条） |
| R10-02 | 能力旗标归属（§2.1 `defaults` + `capabilities`、§2.2 第 6 条） |
| R10-03 | secrets 住哪、怎么遮（§2.1 `SecretRef`、§2.2 第 1 条） |
| R10-04 | 测试连接验什么（§2.1 `toolCalling/streaming` 可探测旗标） |
| R10-05 | 对话与编排一份 schema 还是两份（§2.4） |
| R10-06 | 现有设置页保留多少（§2.4、迁移 §2.3 第 3 条） |
| R10-07 | 新文件名 + models.json 镜像策略（§2.3） |
