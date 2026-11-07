---
name: automation
description: Full guide to Orbita's automation tools (automation_create / list / cancel / update): schedule format and examples, this_session vs new_session, writing the instruction, watching a long-running job, maxRuns / until, write access, the plugin parameter. Read it BEFORE the first automation_create in a conversation. Use when the user wants something scheduled, recurring, reminded or checked later (every Friday…, remind me tomorrow at 9, tell me when the build is done; 定时 / 提醒 / 每周 / 过一会儿回来看 / 跑完告诉我). Not for waits of a few seconds.
---

# Automation — scheduling work to come back later

The tools and the Automations panel are built into Orbita; this file is the "how to use them well" part. An automation is a scheduled task of **this workspace**: when it is due, an instruction you wrote is handed to an agent. It takes effect immediately and the user sees a card in the conversation; they can pause, edit or delete it in the Automations panel (自动化 in the Chinese UI; name it in the user's language).

**Language**: write the title and the instruction in the language the user writes in (the user reads the card; a future run reads the instruction).

## When to reach for it

- The user asks for something **later or repeatedly**: "every Friday morning check the pi repo for new releases", "remind me tomorrow at 9 to hand in the weekly report", "keep an eye on this every hour".
- **You** started something slow (a build, a training run, a server booting, a download) and would otherwise wait for it. **Do not `sleep` or poll in a bash call** — it blocks the whole turn and the foreground command has a timeout. Start the job in the background, create a `this_session` automation that checks on it, and **end your turn**.
- "Remind me" works too: a reminder is just a one-shot automation whose instruction says what to tell the user.

Before creating anything, call **`automation_list`** — if a task for the same thing already exists (any status), tell the user instead of making a duplicate.

## `automation_create` parameters

| parameter | required | meaning |
|---|---|---|
| `title` | yes | short name on the card |
| `prompt` | yes | the instruction each run receives (see "Writing the instruction") |
| `schedule` | yes | when to run (see "Schedule format") |
| `maxRuns` / `until` | no | how long it lives (see "How long it lives") |
| `target` | no | `this_session` (default) or `new_session` |
| `mode` | no | `plan` / `skip`, only for `new_session`; do not pass `skip` yourself (see "Write access") |
| `model` | no | model id for the runs, only for `new_session` |
| `plugin` | no | a plugin whose board each run should fill (see "The `plugin` parameter") |

## Choosing the target

| | `this_session` (default) | `new_session` |
|---|---|---|
| Each run goes… | back into **this** conversation, which keeps all its history | into a **fresh session** in this workspace (not shown in the sidebar; reachable from the automation's row in the Automations panel, where the user can turn it into a normal conversation) |
| Use for | watching a job you started; reminders; follow-ups to what you just did | routines independent of this conversation ("every Friday scan X and report what is new") |
| Permission | the conversation's own permission; `mode` is ignored | read-only (**Plan**) unless the user lets it write — see "Write access" |
| Instruction must be | enough for **you, with this conversation's history** | **fully self-contained**: the run cannot see this conversation |
| Previous result | already in the conversation | the previous successful final answer (up to about 2,000 characters) is attached as "上次结果" so the run can say what is new |
| If still busy / still running | the delivery waits until the conversation is idle; several due times while waiting merge into one | the new run is **skipped** (recorded, not queued) |

Other facts: a `new_session` run is stopped after 60 minutes. `model` (a model id) only works with `new_session`; leave it out to use the sub-session default. An automation run (and any sub-session) cannot create or manage automations.

## Schedule format

`schedule` is an object with `kind`:

| kind | fields | meaning |
|---|---|---|
| `once` | `at`: ISO 8601 **with offset**, in the future | one run, then it is finished |
| `interval` | `unit`: `minute` \| `hour` \| `day`, `every`: integer ≥ 1 | every N units, counted from the previous trigger; **total ≥ 5 minutes**, at most one year. `{"kind":"interval","everyMinutes":15}` is accepted as shorthand |
| `hourly` | `minute`: 0–59 | every hour at that minute |
| `daily` | `time`: `"HH:MM"` 24-hour; optional `weekdays`: array of 0–6, **0 = Sunday** | every day, or only on those weekdays (weekdays only: `[1,2,3,4,5]`; weekly: one number) |
| `monthly` | `day`: 1–31; `time`: `"HH:MM"` | every month; day 31 falls on the last day of shorter months |

All clock times are the user's **local time**. Examples:

- Every Friday 09:00: `{"kind":"daily","time":"09:00","weekdays":[5]}`
- Weekdays 18:30: `{"kind":"daily","time":"18:30","weekdays":[1,2,3,4,5]}`
- Tomorrow 09:00 reminder (today 2026-11-08, UTC+8): `{"kind":"once","at":"2026-11-09T09:00:00+08:00"}` — work out the date and offset from the current date/time and timezone you were given; do not guess.
- Check a job every 10 minutes: `{"kind":"interval","unit":"minute","every":10}`
- Each month on the 1st: `{"kind":"monthly","day":1,"time":"09:00"}`

## How long it lives (maxRuns / until)

A task you create **always has an end**. `maxRuns` (1–100) stops it after that many runs; `until` (ISO 8601 with offset, in the future) stops it at that time; if both are given, whichever comes first. If you give neither, it stops after **12 runs**. A `once` task ends after its run. For a "check every 5 minutes" job, set `maxRuns` to what you actually need (or `until`), not the default; for an open-ended weekly routine, say so with `maxRuns` (e.g. 26) and tell the user it will stop then.

Guard rails (the tool refuses beyond them): intervals of at least 5 minutes; at most 24 real runs per rolling 24 hours per automation (skipped ones do not count); at most 5 active `this_session` tasks per conversation; at most 20 automations in total, **finished ones included** (only the user can delete finished ones, in the Automations panel — if you hit the limit, tell them); title at most 40 characters; instruction at most 8,000 characters. **Three consecutive failed runs** stop the task in a "failed" state; the user can restart it from the panel. Do not try to work around a limit by creating many small tasks.

## Writing the instruction

The instruction is what the run receives when due (prefixed by a header line with the title and run number). Write it for a reader who has nothing but this text (plus, for `this_session`, the conversation).

- **State the goal and the exact check**: which file, log, URL, repo or command to look at, and what "done" and "still running" look like.
- **State what to do in each outcome**: still running → say nothing much or one line and stop; finished → report the result to the user (what, where, numbers), then **call `automation_cancel` with this task's id** (put the id in the instruction after creating it, or tell yourself to look it up with `automation_list`); failed → say what failed and the last lines of the log.
- **For `new_session`**: include every path, name and URL; say what to report and in what shape (the attached previous result lets it say "what is new since last time"). Do not write "as discussed above".
- Keep it short and imperative; no need to repeat the schedule.

Example (`new_session`, weekly): "Check https://github.com/earendil-works/pi/releases. List releases published since the previous result below (all of them if there is none). For each: version, date, 2–3 bullets of what changed. If nothing is new, answer in one line: nothing new."

## Watching a long-running job

1. Start it **in the background**, with output redirected to a log file and (when useful) the process id saved: `nohup <command> > /tmp/job.log 2>&1 & echo $! > /tmp/job.pid`. (On Windows use the PowerShell equivalent, e.g. `Start-Process` with redirected output.) Do not wrap it in `sleep`.
2. Create a `this_session` automation:
   - schedule: `once` a little after the expected finish, or `interval` of 5–10 minutes for jobs of unknown length (never below 5 minutes); give `maxRuns` that covers the expected duration with margin (a 20-minute build checked every 5 minutes → `maxRuns: 6`);
   - instruction: "Read the last 40 lines of /tmp/job.log and check whether process <pid> is still running (`kill -0 <pid>` / `ps`). If it is still running, reply with one short line and stop. If it finished, summarise the result (success or the error and the last lines), tell the user, then call automation_cancel for this task (id …)."
3. Tell the user in one sentence what is running, where the log is, and that you will come back on your own. Then **end your turn** — do not wait.

## The `plugin` parameter

`plugin` is the name of an installed plugin that is enabled in this workspace and has a board. Each run is then told to use that plugin and to finish with `show_plugin_board`, so its cards appear on the user's weekly board. Only pass it when the user wants that plugin's output on the board; check the plugin exists first (`list_plugins`). A plugin's scripts usually have to **write** data, which a read-only run cannot do — see below.

## Write access (`mode`) — ask first

A `new_session` run is **read-only (Plan)** by default: it cannot write files or run commands. If the routine must write (save notes or cards, run a plugin's scripts):

1. Create the automation (do **not** pass `mode: "skip"` yourself).
2. **Ask the user in one plain sentence** whether it may run with write access, unattended ("Skip"). Never request it before they agree.
3. Only after they agree, call `automation_update` with `mode: "skip"` (`"plan"` is always applied at once).
4. An automation can never get more permission than this conversation has. If this conversation is in Skip mode, the change is made and the user sees a row with an "undo" button. Otherwise **nothing is changed**: a row with an allow button is left in the conversation for the user to click. Refer to that button in the user's language (a Chinese user sees 「允许」), then **end your turn and do not call `automation_update` again**.

`this_session` tasks have no mode of their own; they run with the conversation's permission.

## The other tools

- **`automation_list`** — all automations of this workspace, every status (active, paused, failed, completed) with schedule, target, run count and next run. Ids come from here or from `automation_create`'s result.
- **`automation_cancel`** — `automationId`; the task will not run again (sessions it already started stay). Use it as soon as the job a `this_session` task was watching is done, or when the user says to stop. Cancelling an already finished task is harmless.
- **`automation_update`** — only the permission (`mode`) of a `new_session` task. Nothing else can be changed: to change a schedule or instruction, cancel and create a new one (or let the user edit it in the panel).

## After creating

The result tells you the first run time and when it ends. Say to the user, in one or two sentences: what will happen, when the first run is, and when it stops. Do not poll, and do not call the tool again to "confirm".
