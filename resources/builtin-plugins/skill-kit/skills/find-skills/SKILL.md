---
name: find-skills
description: Helps users discover and install agent skills when they ask "how do I do X", "is there a skill that can do X", "find a skill for X", or want to extend what the agent can do (有没有能做 X 的技能 / 帮我找个技能 / 怎么做 X). Searches skills.sh, GitHub and the local plugin marketplace snapshot, shows 2-3 candidates, and installs one the user picks as a skill or plugin. Not for building a new plugin (the plugin-creator flow has its own find-existing step), and not for writing a skill from scratch (use skill-creator).
version: "1.0.2-orbita"
---
# Find Skills

## 在 Orbita 里怎么用（先读这段，它覆盖下文的安装步骤）

- **什么时候用**：用户问「有没有能做 X 的技能」「怎么做 X」「帮我找个 X 的技能」，或想给你扩展能力时。**不要在做插件的流程里用它**——那里（plugin-creator 的第 2 步）有自己的 find-existing；这里只回应用户直接开口要找技能的场景。
- **去哪找**（按顺序）：① 用户已有的技能和插件（系统提示词里的技能索引，再调 `list_plugins`）；② 本机插件市场快照：`~/.zcode/cli/plugins/marketplaces/*/marketplace.json`（读清单找候选，对应插件目录里有 SKILL.md；没有这个目录就跳过）；③ `npx skills find <关键词>` 与 https://skills.sh/；④ GitHub（anthropics/skills、各类 awesome-claude-skills 列表）。
- **给用户看的是候选，不是安装命令**：列 2–3 个，写清每个能做什么、要改哪里才适合他、许可证、来源链接。用户选了再装。
- **不要用 `npx skills add -g`**：它装进 `~/.agents/skills/`（Windows 是用户目录下的 `.agents\skills\`），Orbita 故意不读这个目录，装了也不生效。
- **取回来再装**：先把候选取到会话工作台（`git clone --depth 1 <仓库>` 后只留那个技能的文件夹，或从 raw.githubusercontent.com 取单个文件），读一遍，按用户的情况改造，然后按形态走：
  - **只有 SKILL.md 的单文件技能** → 用 `create_skill` 工具写入（用户会看到审批）。
  - **带 scripts / references / assets 的多文件技能** → 整理成插件放在当前工作区的 `plugins/<名>/` 下（`.claude-plugin/plugin.json` + `skills/<slug>/…`，格式见 plugin-creator 的 plugin-layout.md），**先用一句话问用户能不能装**，同意后调 `install_plugin`。
  - 不要手工往 Orbita 的数据目录里复制文件或建符号链接；重名（用户已有同名技能）就停下来问。
- 保留上游的许可证与署名：改造后的技能在 SKILL.md 或 NOTICE 里写明来源与许可。

This skill helps you discover and install skills from the open agent skills ecosystem.

## When to Use This Skill

Use this skill when the user:

- Asks "how do I do X" where X might be a common task with an existing skill
- Says "find a skill for X" or "is there a skill for X"
- Asks "can you do X" where X is a specialized capability
- Expresses interest in extending agent capabilities
- Wants to search for tools, templates, or workflows
- Mentions they wish they had help with a specific domain (design, testing, deployment, etc.)

## What is the Skills CLI?

The Skills CLI (`npx skills`) is the package manager for the open agent skills ecosystem. Skills are modular packages that extend agent capabilities with specialized knowledge, workflows, and tools.

**Key commands:**

- `npx skills find [query]` - Search for skills interactively or by keyword
- `npx skills add <package>` - Install a skill from GitHub or other sources
- `npx skills check` - Check for skill updates
- `npx skills update` - Update all installed skills

**Browse skills at:** https://skills.sh/

## How to Help Users Find Skills

### Step 1: Understand What They Need

When a user asks for help with something, identify:

1. The domain (e.g., React, testing, design, deployment)
2. The specific task (e.g., writing tests, creating animations, reviewing PRs)
3. Whether this is a common enough task that a skill likely exists

### Step 2: Search for Skills

Run the find command with a relevant query:

```bash
npx skills find [query]
```

For example:

- User asks "how do I make my React app faster?" → `npx skills find react performance`
- User asks "can you help me with PR reviews?" → `npx skills find pr review`
- User asks "I need to create a changelog" → `npx skills find changelog`

The command will return results like:

```
Install with npx skills add <owner/repo@skill>

vercel-labs/agent-skills@vercel-react-best-practices
└ https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices
```

### Step 3: Present Options to the User

When you find relevant skills, present them to the user with:

1. The skill name and what it does
2. The install command they can run
3. A link to learn more at skills.sh

Example response:

```
I found a skill that might help! The "vercel-react-best-practices" skill provides
React and Next.js performance optimization guidelines from Vercel Engineering.

If you want it, I can fetch it, adapt it to your setup and install it here.

Learn more: https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices
```

### Step 4: Offer to Install

If the user wants to proceed, fetch the skill into the session workbench, read it, adapt it, and install it the Orbita way (single-file → `create_skill`; multi-file → a plugin folder, ask first, then `install_plugin`). Do not run `npx skills add -g`.

## Common Skill Categories

When searching, consider these common categories:

| Category        | Example Queries                          |
| --------------- | ---------------------------------------- |
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing         | testing, jest, playwright, e2e           |
| DevOps          | deploy, docker, kubernetes, ci-cd        |
| Documentation   | docs, readme, changelog, api-docs        |
| Code Quality    | review, lint, refactor, best-practices   |
| Design          | ui, ux, design-system, accessibility     |
| Productivity    | workflow, automation, git                |

## Tips for Effective Searches

1. **Use specific keywords**: "react testing" is better than just "testing"
2. **Try alternative terms**: If "deploy" doesn't work, try "deployment" or "ci-cd"
3. **Check popular sources**: Many skills come from `vercel-labs/agent-skills` or `ComposioHQ/awesome-claude-skills`

## When No Skills Are Found

If no relevant skills exist:

1. Acknowledge that no existing skill was found
2. Offer to help with the task directly using your general capabilities
3. Suggest writing their own skill (the skill-creator skill in this plugin can do it)

Example:

```
I searched for skills related to "xyz" but didn't find any matches.
I can still help you with this task directly! Would you like me to proceed?

If this is something you do often, I can help you write your own skill for it.
```
