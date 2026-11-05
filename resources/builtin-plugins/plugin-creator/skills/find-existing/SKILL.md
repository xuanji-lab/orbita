---
name: find-existing
description: 在动手写新插件、新技能或新的界面风格之前，先主动去找有没有现成的可以复用或改造——用户已有的技能和插件、本机的插件市场快照、skills.sh、GitHub。做插件的流程（plugin-creator）第 2 步用它；用户问“有没有现成的 XX 技能”“找找有没有人做过”时也用它。找完给 2–3 个候选，说清各自能复用什么，不直接安装。
---

# 主动找现成的（再动手）

用户的原话（2026-11-05）：创建插件时，agent 应该**自己**去看有没有对应的技能，拉过来改造成适合他的，而不是等他提醒才去找。所以这一步不是可选项：动手写之前先找，找不到再从头写，并且要把“找过了、没找到”也告诉他。

## 找的顺序（每一处花不超过几分钟，别在这里耗）

1. **用户已有的技能和插件**——不需要搜索：
   - 系统提示词里的技能索引（名字 + description），看有没有相关的；
   - 调用 `list_plugins`，看这个工作区里已装的插件。
   这一步最常见的收获是：他其实已经有 70% 的东西，只缺把它们串起来。
2. **本机插件市场快照**（离线，快）：
   ```bash
   ls ~/.zcode/cli/plugins/marketplaces/
   # 每个目录里有 marketplace.json，plugins 数组里每项有 name、description、source、category
   rg -i "<关键词1>|<关键词2>" ~/.zcode/cli/plugins/marketplaces/*/marketplace.json | head -40
   ```
   没有 `rg` 就用 `grep -i -E`。命中后去对应插件目录（`.../plugins/<name>/` 或 marketplace 里 `source` 指的路径）读它的 `skills/*/SKILL.md` 和 `.claude-plugin/plugin.json`。
3. **skills.sh**（社区技能目录）：
   ```bash
   npx skills find <关键词>      # 需要有 node/npx；没有就跳到浏览器搜索
   ```
   或用浏览器工具打开 `https://skills.sh/` 搜关键词。只看，不装。
4. **GitHub**：搜 `<关键词> claude skill` / `agent skill`，常见合集 `anthropics/skills`、各类 `awesome-claude-skills`。用 `web_search` 或浏览器工具。

找界面风格 / 面板样子时（第 5 步），去处不同：看 `../panel-style/SKILL.md`，别在这里找。

## 怎么把候选给用户

2–3 个，每个一行回答四件事（表格或列表都行），用大白话：

| 候选 | 来自哪 / 许可证 | 能复用什么 | 要改哪里才合你用 |
|---|---|---|---|
| 例：`arxiv-digest` 技能 | claude-plugins-official · MIT | 取 RSS + 去重的整段脚本 | 它出的是英文摘要，要改成一句中文；输出格式要换成 panel.json |

- “能复用什么”要具体到文件或步骤，不要写“可以参考”。
- 许可证看仓库或技能目录里的 LICENSE；**看不到就写“没找到许可证”**，不要猜。宽松许可证（MIT / Apache-2.0）复用要在插件的 `NOTICE` 里署名；没有许可证的只能参考思路、不能抄代码。
- 一个都不合适就直说：“我在你已有的技能、本机市场、skills.sh 里找过，没有合适的，我从头写。”这句话本身有价值。

**然后停下来，等他选**（或说“从头写”）。

## 选中之后怎么拉进来

1. 先把它放到**会话工作台**（或临时目录）里读一遍：SKILL.md、scripts、有没有可疑的联网 / 写文件 / 执行外部命令。**读完才决定用不用**，不要先跑它的脚本。
2. 拷进插件：`plugins/<名字>/skills/<新技能名>/`，只拷需要的文件；SKILL.md 的 `name` 改成不与用户已有技能撞的名字；按用户的情况改造（语言、输出格式、路径）。
3. 在插件根写 `NOTICE`：来源链接、原作者、许可证、你改了什么。
4. 在 `intent.md` 里记一行“复用了谁的什么”。

**不要用 `npx skills add -g`**：它装进 `~/.agents/skills/`，Orbita 故意不读那里，装了也不生效，还会污染用户的全局目录。要拉远程技能，用不带 `-g` 的方式拉到工作台，或从 `raw.githubusercontent.com` 取单个文件。

改编自 find-skills（vercel-labs，MIT），见插件根目录 NOTICE。
