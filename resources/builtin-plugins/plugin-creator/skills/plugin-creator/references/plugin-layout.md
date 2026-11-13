# 插件的目录、清单与约定

## 目录

```
<工作区根>/plugins/<name>/
├── .claude-plugin/plugin.json     清单（Claude Code 兼容 + Orbita 的 orbita 扩展）
├── skills/
│   └── <skill-slug>/SKILL.md      每条技能一个文件夹；还可以带 references/、scripts/、assets/
├── scripts/                       插件级脚本（技能通过命令行调用）
├── board/<卡id>.html              看板卡模板（可选，见 board-style）
├── board/<卡id>.sample.json       那张卡的样例数据：data 文件还不存在 / 为空时用它渲染（界面标「样例」）
├── board/spec.md                  看板说明（可选）：给人看的短 markdown
├── board/preview.html 等          做卡过程中的预览 / 草稿，定稿删掉
├── data/<卡id>.json               脚本产出、卡片读取的数据（可选；脚本写好之前不存在）
├── intent.md                      意图 / 验收清单（你写的，给后来的人和后来的你）
├── taste.md                       用户把卡片定稿时的取舍与原话
└── NOTICE                         复用了别人的技能或脚本时，写署名与许可证
```

`.mcp.json`（可选）放 MCP 服务配置，详见下文。除了 `.claude-plugin/plugin.json`，其余都是可选的；技能放哪个目录由清单决定，默认 `skills/`。

## 名字

插件名 `name` 是标识：**小写字母、数字、点、短横、下划线，字母或数字开头，最长 64 位**（如 `lit-tracker`）。目录名最好等于它。技能的目录名同样用小写短横；SKILL.md 头里的 `name` 默认写成和目录名一样。**卡的 id**：`[a-z0-9-]{1,32}`，本插件内唯一。**插件名、技能名不要与用户已有的撞**（先看系统提示词里的技能索引和 `list_plugins`）。

## plugin.json 样例（完整）

```json
{
  "name": "lit-tracker",
  "displayName": "文献追踪",
  "version": "0.1.0",
  "description": "每天从 arXiv 取 cs.CL 最新的论文，给每篇一句话摘要，看板上每天一张卡。",
  "author": { "name": "你的名字" },
  "userConfig": {
    "max_items": { "type": "number", "title": "每次取几篇", "description": "1–20", "default": 5, "min": 1, "max": 20 }
  },
  "orbita": {
    "workflow": [
      { "title": "取 arXiv RSS", "skill": "lit-fetch", "detail": "cs.CL 前 5 篇" },
      { "title": "每篇写一句话摘要", "skill": "lit-summarize" },
      { "title": "你标记哪篇有用", "skill": "lit-fetch", "wait": "board" },
      { "title": "写进看板数据", "output": "data/today.json" }
    ],
    "io": {
      "reads":  [ { "path": "intent.md", "note": "10 条选文理念" } ],
      "writes": [ { "path": "data/today.json", "note": "「今日一篇」这张卡读它", "when": "每天" } ]
    },
    "external": [
      { "name": "Semantic Scholar API", "kind": "api", "account": false, "resident": false, "note": "只在跑的时候联网" }
    ],
    "board": {
      "title": "文献追踪",
      "spec": "./board/spec.md",
      "cards": [
        { "id": "today", "title": "今日一篇", "size": "1x1",
          "template": "./board/today.html",
          "data": "${CLAUDE_PLUGIN_ROOT}/data/today.json",
          "sample": "./board/today.sample.json" },
        { "id": "week", "title": "本周各方向", "size": "2x1",
          "template": "./board/week.html",
          "data": "${CLAUDE_PLUGIN_ROOT}/data/week.json",
          "sample": "./board/week.sample.json",
          "repeat": "topics" }
      ]
    },
    "tuned": false
  }
}
```

字段说明：

- `name`（必填）、`displayName`、`version`（semver）、`description`（一句话：做什么、给谁）、`author`：元数据。**description 会显示在插件列表里，写人话。**
- `userConfig`：要用户填的配置（API key、邮箱、目录）。`sensitive: true` 的值进系统密钥库，不落盘；`type` 可以是 `string`/`number`/`boolean`/`directory`/`file`。**不要把密钥写进清单默认值。**
- `skills`（可选）：默认读 `skills/`；想放别处写 `"skills": "./my-skills"`（路径必须在插件里面）。
- `orbita.workflow`：**给人看的步骤列表，不执行**。每步 `{ title（必填）, skill?, detail?, output?, wait? }`：
  - `skill` 写本插件里某条技能的**目录名或 SKILL.md 里的 name**。对不上，详情页会标「这个插件里没有这条技能」，`install_plugin` 也会把它退回给你（`preview_plugin` 只提醒、不拦：草稿阶段技能还没写很正常）；
  - `detail` 一句话说这步具体做什么；`output` 是这步产出的文件（相对插件根，只是展示）；
  - `wait` 标 **Human in the loop 在哪里**：`"board"` = 这一步等用户在看板上点（卡上有动作按钮）；`"chat"` = 等用户在对话里回；不写 / null = 自动往下跑。详情页里等用户的步骤带手形标「等你」。
  - 一般 4–8 步。写「人眼里的步骤」，不是函数调用栈。
- `orbita.io`：输入与输出（给人看，不执行）。`reads` 每项 `{ path, note }`；`writes` 每项 `{ path, note, when? }`（`when` 多久一次：每天 / 每次跑 / 每周五…）。
- `orbita.external`：外接服务 / 命令行（给人看）。每项 `{ name, kind, account, resident, note }`：`kind` 是 `"api" | "cli" | "mcp" | "service"`；`account` 要不要账号；`resident` 会不会常驻（后台一直跑）。
- `orbita.board`：看板。`title` 显示在看板上；`spec`（可选）给人看的短 markdown；`cards` 每项：
  - `id`（本插件内唯一，`[a-z0-9-]{1,32}`）、`title`、`size`：四档 `"1x1" | "2x1" | "1x2" | "2x2"`（宽×高，格子宽高比 10:9）、`template`：卡模板 HTML（插件根内）；
  - `data`（可选）：数据文件路径；`sample`（可选）：样例数据，**形状 = 以后脚本写进 `data` 的形状**。`data` 文件不存在 / 为空 → 用 `sample` 渲染，卡外标「样例」；
  - `repeat`（可选）：`data` JSON 里某个数组的字段名——数组里**每一项各画一张同尺寸卡**（模板收到的 data 是其中一项）；不写就整份数据画一张。
  - 卡片数上限 12；`repeat` 展开后最多 24 张。
  - **默认 `data` 用 `${CLAUDE_PLUGIN_ROOT}/data/<卡id>.json`**：你现在就能算出真实路径、脚本直接写进去、试跑就能看真数据（安装是链接，装完照旧有效）。`${CLAUDE_PLUGIN_DATA}`（插件数据目录，`actions.jsonl` 在那）是另一个合法去处，要等装上才知道路径（装完 `install_plugin` 返回里会给）。
- `orbita.tuned`：`false`（初始）。用户磨合好了（跑完只要卡、不用解释）才改 `true`——**改之前先问一句**。它影响对话里的呈现：`false` 时每次跑完你用一两句说明做了什么、请用户挑错；`true` 时只一行加卡。
- `orbita` 下除上述键之外的（含旧的 `panel`——**已改名为 `board`**），Orbita 不认：详情页会报问题或列进「暂不支持」。
- 不支持的 Claude Code 组件（commands、agents、hooks 等）可以写，但 Orbita 现在不运行，详情页会标出来；做给 Orbita 用的插件就别写。

## 对话里显示看板：show_plugin_board

插件装好（或草稿在本会话工作区里）之后，agent 工具 `show_plugin_board({ plugin: "<插件名>", cards?: ["today"] })` 把它的卡**显示在当前对话里**（数据快照进会话，以后模板改了旧会话仍按当时的样子画）。**每条技能跑完的最后一步都调它**，不写 `cards` 就是全部卡。返回会按 `tuned` 提醒你怎么说（false → 一两句说明 + 请用户挑错；true → 不解释）。

## 技能怎么写

见 `skill-writing.md`。放这里的要点：**一条技能做一件事**，description 里写清触发场景，SKILL.md 正文里写步骤，具体脚本的调用命令写成能复制的整行。技能的 SKILL.md 开头必须有：

```markdown
---
name: arxiv-fetch
description: 取 arXiv 某个分类的最新论文并给每篇写一句话摘要。用户说“看看今天 cs.CL 有什么新论文”“更新文献追踪”时使用。
---
```

**没有 description 的技能 Orbita 不加载**（模型看不到它），`install_plugin` 会退回。

## 脚本约定

- 放 `scripts/`，**只用标准库**（Python 3 的 `urllib`/`json`/`xml.etree`；Node 的 `fetch`）。先 `python3 --version` / `node --version` 看用户机器上有什么，别假设。
- 输出路径**相对脚本自己的位置**算（`Path(__file__).resolve().parent.parent / "data" / "today.json"`），或用参数传入。别硬编码绝对路径——用户可能把工作区挪个地方。
- 写文件走「先写临时文件再改名」，卡片可能正好在读。
- 失败要大声：非零退出码 + 一句人话到 stderr（「arXiv 返回 503，稍后再试」），不要吞掉错误写个空文件。
- 技能 SKILL.md 里调用脚本：技能文件在 `skills/<slug>/SKILL.md`，插件根就是它往上两级。写成「脚本在本文件往上两级的 `scripts/xxx.py`（先用本 SKILL.md 的绝对路径算出插件根）」，并给一行能整行复制的命令样例。不要写死绝对路径。

## 样例与数据文件（每张卡一对）

`board/<卡id>.sample.json` 与 `data/<卡id>.json` **形状相同**：sample 是你写卡时磨样子的（1 条真记录最好），data 是脚本写的真数据。形状自由（`repeat` 卡的 data 是数组）；建议带 `generatedAt`。大小各 ≤ 2 MB（超了卡不显示）。需要历史就另存 `data/archive/…jsonl`，卡只读最近一份。

## 卡片动作回流

卡上用户点「有用 / 不相关」这类按钮，模板发 `orbita:action`，Orbita 把一行 `{"at","action","payload","card"}` 追加到**插件数据目录**的 `actions.jsonl`（只追加，不做别的）。你的脚本下一轮去读它，才能「根据反馈收窄」。数据目录的路径在 `install_plugin` 的返回里；之后也可以 `list_plugins` 查到（「data folder」）。**不做回流的插件就别在卡上放动作按钮。**

## MCP（需要时才加）

大多数「取数据 + 写摘要」的插件不需要 MCP，用脚本更简单。真要接外部服务时在插件根放 `.mcp.json`：

```json
{ "mcpServers": { "arxiv": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"], "env": { "API_KEY": "${user_config.api_key}" } } } }
```

对话里会出一行**带完整命令行**的「装上 X　[安装]」，用户点了才装（`install_plugin` 不会替他装）；命令以用户的权限运行，所以：能不用就不用，命令别藏复杂的 shell 一行。

## 路径与上限（清单里所有路径）

- 可用变量：`${CLAUDE_PLUGIN_ROOT}`（插件根）、`${CLAUDE_PLUGIN_DATA}`（插件数据目录）、`${user_config.KEY}`、`${workspaceFolder}`（会话所在工作区根）。
- `template` / `spec` / `sample` 必须在插件根里面；`data` 解析后必须落在插件根 / 插件数据目录 / 工作区根 / directory 型配置值之内。**不能 `..`、不能绝对路径、不能指到插件外的符号链接**——一律被拒。
- 上限（每张卡各自算）：模板 ≤ 1 MB、数据与样例各 ≤ 2 MB、spec ≤ 64 KB；动作名 ≤ 64 字符、载荷 ≤ 16 KB、每 10 秒 ≤ 20 条；actions.jsonl ≤ 4 MB。

## 常见坑

1. **插件名/技能名与用户已有的重名**：装不上。先看技能索引。
2. **description 写成一句空话**（「处理文件」）：模型永远想不起来用它。写触发场景、写用户会怎么说。
3. **workflow 的 skill 写错**：`install_plugin` 会退回。
4. **卡的 `data` 和脚本写的路径不是同一个**：卡永远停在样例上。
5. **把数据文件写在 `~/` 或工作区之外**：`data` 会被拒读。
6. **JSON 里写注释 / 尾逗号**：清单读不了，整个插件被当成没有清单。写完用 `python3 -c "import json,sys;json.load(open(sys.argv[1]))" .claude-plugin/plugin.json` 校验。
7. **技能目录里放了第二个 SKILL.md 当示例**：会被当成另一条技能。示例放 `references/` 里并改名。
8. **写了旧的 `orbita.panel`**：已改名 `board`，Orbita 读到会报问题、不渲染。
9. **卡的 id 不合法 / 重复**：`[a-z0-9-]{1,32}`、本插件内唯一。
