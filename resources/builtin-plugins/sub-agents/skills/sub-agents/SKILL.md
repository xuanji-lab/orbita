---
name: sub-agents
description: How the workspace's main agent creates, edits and uses persistent sub-agents (planets in the workspace's galaxy) with create_sub_agent / update_sub_agent / list_sub_agents and delegate's subAgentId — how to settle the role with the user, how to write the role prompt, how to make the face-less avatar image, what the user sets in the Galaxy Design panel. Read it BEFORE the first create_sub_agent in a conversation. Use when the user wants a dedicated helper / sub-agent / 子智能体 / 行星 / 专门负责某件事的智能体, wants to change one, or when a task fits an existing sub-agent. Only works in orchestration mode inside a workspace. Not for one-off sub-sessions (plain delegate) or for designing the main star.
---

# Sub-agents — planets that keep a role

In orchestration mode each workspace is a galaxy: the main agent (you) is its one main star, persistent sub-agents are planets, sessions are rubble. A sub-agent is **a name + a role prompt + an avatar**, saved in the workspace folder (`planet/agents/<id>/agent.json`, roster and looks in `planet/galaxy.json`). The tools and the Galaxy Design panel (星系设计 in the Chinese UI) are built into Orbita; this file is the "how to do it well" part.

**Language**: name, role prompt and everything you tell the user are in the user's language.

## When to reach for it

- The user wants a helper that keeps doing one kind of work ("a sub-agent that handles meeting notes", "以后评测都交给一个专门的").
- The user wants to rename one, sharpen its role, or give it a default model → `update_sub_agent`.
- A task fits an existing sub-agent → `list_sub_agents`, then `delegate` with `subAgentId` (see the end).
- Not for: a one-off parallel chunk of work (plain `delegate` without `subAgentId`), or the main star itself.

If the tools are missing, you are not in orchestration mode or not in a workspace (the interstellar space has no main star, so it cannot have planets). Say so in one sentence and point the user to the 编排 / Orchestrate switch at the top of the sidebar; do not fake it with files.

## 1. Check what exists

Call `list_sub_agents` first. If one already covers the job (same name or overlapping role), ask whether to update that one or create another. Names must be unique (case-insensitive) and must not be the main star's name.

## 2. Settle the role with the user

Ask one or two short questions at a time, in this order, and stop as soon as you have enough:

1. **What it owns** — the kind of work, in the user's words ("会议录音整理成要点").
2. **How it works** — inputs it gets, tools or sources it should use, the shape of what it hands back, where outputs go.
3. **Limits** — what it must not do (touch other repos, change settings, decide for the user), when it should stop and ask.
4. **Name** — let the user name it, or propose two or three short names (≤ 24 characters) that fit the role.

Do not invent responsibilities the user did not ask for. Composition (rock / ice / gas) only changes its look, never its role — do not derive personality from it.

## 3. Write the role prompt and show it

Write it in second person, addressed to the sub-agent itself. Keep it short and concrete (usually 5–15 lines; hard limit 6000 characters):

```
你是「<名字>」，<工作区> 主智能体手下专门负责 <职能> 的子智能体。
负责：<它拥有的那类工作，用用户的原话>
做法：<输入从哪来、按什么步骤、用什么工具 / 资料、交回什么形状的结果、产出放哪>
边界：<不做什么；什么情况下先用 question 汇报再动手>
交付：<done 汇报里必须写清的东西>
```

Show the draft to the user and wait for a yes (or edits) before saving. Quote it in full; do not summarise it.

## 4. The avatar (face-less surface)

Eyes, rings and corona are drawn by code; the image is only the planet's **surface, with no face**. Never put eyes or a mouth in it (generated eyes come out the wrong size and colour, and a dark storm under the eyes reads as a mouth).

- If an image-generation tool is available (for example the Qwen image MCP's `qwen_generate`), make one surface image, following the planet-forge plugin's way if it is installed: transparent background (RGBA), one sphere centred and filling most of the frame, soft lighting from the upper left, a surface that matches the agreed look (rocky / icy / gas bands, colours), **no eyes, no mouth, no face, no text, no ring**. Look at the image yourself before using it; regenerate if it has a face or features that read as one. Pass its absolute path as `surfacePath`.
- If there is no such tool, or it fails, skip it. The planet gets a code-drawn default sphere and the panel marks it as image pending (待出图). Tell the user that in one sentence; you can add an image later with `update_sub_agent` + `surfacePath`.

## 5. Save it

Call `create_sub_agent` with `name`, `role`, and optionally `surfacePath`, `composition`, `model` (a model id from `model_costs`) and `massEarth`.

- **Do not choose an orbit or a position.** The app puts the new planet on a free default orbit (screen-safe, no collisions) and opens the Galaxy Design panel on it; the user sets orbit and mass there.
- `massEarth` is optional (default 2). A planet must stay well below the main star: at most 10% of the star's mass and at most 4 Earth masses. Leave it out unless the user asked for a mass.
- If the tool returns an error (name taken, mass too high, roster full at 8), fix that one thing and retry, or ask the user.

After it succeeds, tell the user in one or two sentences: what was saved (name and one line of the role), whether the avatar is pending, and that the panel on the right is where they set its orbit and mass. Do not paste the file path unless they ask.

## 6. Editing and deleting

- `update_sub_agent` changes only the fields you pass; `role` replaces the whole prompt, so send the full new text (show it to the user first).
- You cannot delete a sub-agent. Deleting is the user's call, in the Galaxy Design panel (it asks for confirmation; the files are moved aside, not erased).

## 7. Handing it work

When a task fits a sub-agent, call `delegate` as usual and add `subAgentId` (the id from `list_sub_agents`). The sub-session then runs as that sub-agent: its role is in the sub-session's system prompt, its default model is used unless you pass `model`, and the sidebar shows its avatar while it works. Still write a self-contained `task` — the role says who it is, not what this particular job is.
