# 插件的目录、清单与约定

## 目录

```
<工作区根>/plugins/<name>/
├── .claude-plugin/plugin.json     清单（Claude Code 兼容 + Orbita 的 orbita 扩展）
├── skills/
│   └── <skill-slug>/SKILL.md      每条技能一个文件夹；还可以带 references/、scripts/、assets/
├── scripts/                       插件级脚本（技能通过命令行调用）
├── panel/index.html               右栏面板模板（可选，见 panel-style）
├── panel/sample.json              样例数据：data 文件还不存在 / 为空时右栏用它渲染（界面标「样例」）
├── panel/spec.md                  模板说明：显示哪些字段、怎么排、数据从哪来（给人看的短 markdown）
├── data/panel.json                脚本产出、面板读取的数据（可选；脚本写好之前不存在）
├── intent.md                      意图 / 验收清单 / 品味参照（你写的，给后来的人和后来的你）
├── taste.md                       用户把卡片定稿时的取舍与原话（第 4 步写）
└── NOTICE                         复用了别人的技能或脚本时，写署名与许可证
```

`.mcp.json`（可选）放 MCP 服务配置，详见下文。除了 `.claude-plugin/plugin.json`，其余都是可选的；技能放哪个目录由清单决定，默认 `skills/`。

## 名字

插件名 `name` 是标识：**小写字母、数字、点、短横、下划线，字母或数字开头，最长 64 位**（如 `lit-tracker`）。目录名最好等于它。技能的目录名同样用小写短横。技能 SKILL.md 头里的 `name` 默认写成和目录名一样。**插件名、技能名不要与用户已有的撞**（先看系统提示词里的技能索引和 `list_plugins`）。

## plugin.json 样例（完整）

```json
{
  "name": "lit-tracker",
  "displayName": "文献追踪",
  "version": "0.1.0",
  "description": "每天从 arXiv 取 cs.CL 最新的论文，给每篇一句话摘要，结果显示在右栏。",
  "author": { "name": "你的名字" },
  "userConfig": {
    "max_items": { "type": "number", "title": "每次取几篇", "description": "1–20", "default": 5, "min": 1, "max": 20 }
  },
  "orbita": {
    "workflow": [
      { "title": "取 arXiv RSS", "skill": "arxiv-fetch", "detail": "cs.CL 前 5 篇" },
      { "title": "每篇写一句话摘要", "skill": "arxiv-fetch" },
      { "title": "写进面板数据", "output": "data/panel.json" }
    ],
    "panel": {
      "title": "文献追踪",
      "template": "./panel/index.html",
      "data": "${CLAUDE_PLUGIN_ROOT}/data/panel.json",
      "spec": "./panel/spec.md",
      "sample": "./panel/sample.json"
    }
  }
}
```

字段说明：

- `name`（必填）、`displayName`、`version`（semver）、`description`（一句话：做什么、给谁）、`author`：元数据。**description 会显示在插件列表里，写人话。**
- `userConfig`：要用户填的配置（API key、邮箱、目录）。`sensitive: true` 的值进系统密钥库，不落盘；`type` 可以是 `string`/`number`/`boolean`/`directory`/`file`。脚本里要用时，通过 MCP 的 `${user_config.KEY}` 或让技能指示用户设置环境变量。**不要把密钥写进清单默认值。**
- `skills`（可选）：默认读 `skills/`；想放别处写 `"skills": "./my-skills"`（路径必须在插件里面，不能 `..`、不能绝对路径）。
- `orbita.workflow`：**给人看的步骤列表，不执行**。每步 `{ title（必填）, skill?, detail?, output? }`：
  - `skill` 写本插件里某条技能的**目录名或 SKILL.md 里的 name**。对不上，详情页会标“这个插件里没有这条技能”，`install_plugin` 也会把它退回给你（`preview_plugin` 只提醒、不拦：草稿阶段技能还没写很正常）；
  - **UI 先行时（第 3 步）先不写 workflow**，技能写好（第 5 步）再补；
  - `detail` 一句话说这步具体做什么；`output` 是这步产出的文件（相对插件根，只是展示）；
  - 一般 4–8 步。写“人眼里的步骤”，不是函数调用栈。
- `orbita.panel`：右栏面板。`template` 是插件里的 HTML 文件；`spec`（可选）是给人看的模板说明（markdown，显示在面板下方）；`sample`（可选）是样例数据（JSON，**形状 = 以后脚本写进 `data` 的形状**）；`data` 是 JSON 文件路径，**可用变量** `${CLAUDE_PLUGIN_ROOT}`（插件根）、`${CLAUDE_PLUGIN_DATA}`（插件数据目录）、`${user_config.KEY}`、`${workspaceFolder}`（会话所在工作区根）。`data` 解析后必须落在插件根 / 插件数据目录 / 工作区根 / directory 型配置值之内。
  - **默认用 `${CLAUDE_PLUGIN_ROOT}/data/panel.json`**：你现在就能算出它的真实路径、能让脚本直接写进去、第 5 步就能试跑。`spec` / `sample` / `template` 的路径同样必须在插件根里面（不能 `..`、不能绝对路径）。`${CLAUDE_PLUGIN_DATA}` 要等装上之后才知道在哪（装完 `install_plugin` 的返回里会给出），用它做**输入**的目录（比如面板动作 `actions.jsonl`）。
- 面板模板怎么写（接收 `orbita:data`、主题变量、空态、动作回传、八条规则）见 `../../panel-style/SKILL.md`，骨架在它的 `assets/panel-template.html`。
- `orbita` 下除 `workflow`、`panel` 之外的键，Orbita 现在不认，会在详情页列进“暂不支持”。
- 不支持的 Claude Code 组件（commands、agents、hooks 等）可以写，但 Orbita 现在不运行，详情页会标出来；做给 Orbita 用的插件就别写。

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
- 输出路径**相对脚本自己的位置**算（`Path(__file__).resolve().parent.parent / "data" / "panel.json"`），或用参数传入。别硬编码绝对路径——用户可能把工作区挪个地方。
- 写文件走“先写临时文件再改名”，面板可能正好在读。
- 失败要大声：非零退出码 + 一句人话到 stderr（“arXiv 返回 503，稍后再试”），不要吞掉错误写个空文件。
- 技能 SKILL.md 里调用脚本：技能文件在 `skills/<slug>/SKILL.md`，插件根就是它往上两级。写成“脚本在本文件往上两级的 `scripts/xxx.py`（先用本 SKILL.md 的绝对路径算出插件根）”，并给一行能整行复制的命令样例。不要写死绝对路径。

## 样例与数据文件（sample.json / panel.json）

两个文件**形状相同**：`panel/sample.json` 是第 3 步你写的样例（1 篇真文章或几条样例，用来和用户磨卡片），`data/panel.json` 是第 5 步脚本写的真数据。`data` 文件存在且非空时右栏用它，否则用 `sample`（界面会标“样例”，所以数据里不用再标 `sample`）。形状自由，建议带元信息，面板好显示“更新于”：

```json
{
  "generatedAt": "2026-11-05T09:00:12Z",
  "source": "arXiv cs.CL RSS",
  "items": [
    { "id": "2511.01234", "title": "…", "venue": "arXiv cs.CL", "summary": "一句话摘要", "tags": ["memory"], "url": "https://arxiv.org/abs/2511.01234" }
  ]
}
```

大小 ≤ 2 MB（超了面板不显示）。需要历史就另存 `data/archive/…jsonl`，面板只读最近一份。

## 面板动作回流

面板里用户点“有用 / 不相关”这类按钮，模板发 `orbita:action`，Orbita 把一行 `{"at","action","payload"}` 追加到**插件数据目录**的 `actions.jsonl`（只追加，不做别的）。你的脚本下一轮去读它，才能“根据反馈收窄”。数据目录的路径在 `install_plugin` 的返回里；之后也可以 `list_plugins` 查到（“data folder”）。**不做回流的插件就别在模板里放动作按钮。**

## MCP（需要时才加）

大多数“取数据 + 写摘要”的插件不需要 MCP，用脚本更简单。真要接外部服务时在插件根放 `.mcp.json`：

```json
{ "mcpServers": { "arxiv": { "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/server.js"], "env": { "API_KEY": "${user_config.api_key}" } } } }
```

对话里会出一行**带完整命令行**的“装上 X　[安装]”，用户点了才装（`install_plugin` 不会替他装）；命令以用户的权限运行，所以：能不用就不用，命令别藏复杂的 shell 一行。

## 常见坑

1. **插件名/技能名与用户已有的重名**：装不上。先看技能索引。
2. **description 写成一句空话**（“处理文件”）：模型永远想不起来用它。写触发场景、写用户会怎么说。
3. **workflow 的 skill 写错**：`install_plugin` 会退回。
4. **panel.data 和脚本写的路径不是同一个**：面板永远停在样例上。
5. **把数据文件写在 `~/` 或工作区之外**：panel.data 会被拒读。
6. **JSON 里写注释 / 尾逗号**：清单读不了，整个插件被当成没有清单。写完用 `python3 -c "import json,sys;json.load(open(sys.argv[1]))" .claude-plugin/plugin.json` 校验。
7. **技能目录里放了第二个 SKILL.md 当示例**：会被当成另一条技能。示例放 `references/` 里并改名。
8. **绝对路径、`..`、指到插件外的符号链接**：一律被拒。
