---
name: terminal
description: How to use Orbita's visible terminal tools (terminal_open, terminal_execute, terminal_read, terminal_list, terminal_interrupt, terminal_close) — when a command belongs in the visible terminal instead of the headless bash tool, how to reuse a terminal safely, how to tell a command has finished, how to page through output, and how to stop or close. Read it BEFORE the first terminal_* call in a conversation. Use when the user wants to watch a command run, asks to start a dev server / watcher / long build / slow test run where they can see it, or wants a running command stopped (终端 / 起 dev server / 让我看着 / 跑慢测试看进度 / 停掉它). Not for just getting a command's output — use bash for that.
---

# Terminal — commands the user can watch and take over

The tools and the terminal panel on the right are built into Orbita; this file is the "how to use them well" part. A visible terminal is a real shell (PTY) shown as a tab in the terminal panel. The user sees every command and its output live and can type in the same shell at any time — whatever they type shares your shell.

## Choose the channel first

- **Headless `bash`** — you only need the command's output (count files, grep, run a quick script, read a version). The output goes straight into your context. This is the default for everything you just want an answer from.
- **Visible terminal** — the user should watch it, it runs long (dev server, watcher, build, slow test suite), or you may need to interrupt it. The user sees it; **you do not get the output back automatically** (see below).
- Never use the visible terminal to run something silently. Never use bash for a server or watcher the user asked to watch.

## The six tools

| Tool | What it does |
| --- | --- |
| `terminal_open` | Opens an interactive shell tab at a cwd; runs nothing. |
| `terminal_execute` | Types one complete command line into a terminal and presses Enter. Returns **immediately** — no output, no exit code (`outputSharedWithAgent: false`). Omit `terminalId` to open a new terminal at `cwd` (default: the session's working directory) and run there. |
| `terminal_read` | Returns buffered output as plain text (control sequences stripped). Nothing is pushed to you — you have to ask. |
| `terminal_list` | Lists the terminals this session owns: id, cwd, shell, `running` or `exited (code N)`. Never includes output. |
| `terminal_interrupt` | Sends Ctrl+C to a running terminal. The tab stays open and visible. |
| `terminal_close` | Kills the shell, discards its output buffer, and removes the tab from the user's panel. |

Only terminals this session opened can be driven. Terminals the user opened by hand are visible in the panel but not yours; writing to one fails with a clear error. `running` in the list means the **shell** is alive, not that a command is in progress — it says nothing about whether the shell is busy.

## Red line: never type into a busy terminal

Whatever you write into a terminal is typed into whatever is currently running there. So before every visible-terminal command:

1. Call **`terminal_list`**.
2. Reuse a terminal (pass its `terminalId`) only if it is owned by this session, still `running`, has a matching cwd, **and you observed its previous command finish**. A terminal running a dev server, watcher, REPL, `ssh`, a prompt waiting for input, or a command you have not confirmed finished is **not safe** — a new line would be fed to that program as input.
3. Otherwise omit `terminalId` (or call `terminal_open`) to get a fresh tab. Also open a new one when the cwd must differ, or when the user wants a separately visible concurrent session (e.g. server in one tab, tests in another).

Do not open a new tab for every command, though: reuse a safe idle terminal rather than piling up tabs.

## cwd rules

`cwd` is absolute or relative to the session's working directory, and must resolve (after following symlinks) inside the session's authorized directories — the working directory plus any attached directories. Outside them, the call fails and the error lists the authorized directories. Omit `cwd` to use the session's working directory. The session workbench is not an authorized directory for terminals. This limits where a terminal starts, not what a shell can reach once it is running.

## Running a command

1. `terminal_list` (see above), then `terminal_execute` with the **complete command line** — one line, no wrapper like `bash -c`; it is typed and submitted with Enter. Use the shell reported by `terminal_open` / `terminal_list` (e.g. `pwsh` on Windows) and write the line in that shell's syntax.
2. The panel lights up automatically; the user sees the command run.
3. Tell the user in one sentence what you started and where. Do not wait for it to "finish" inside `terminal_execute` — it cannot wait, and a dev server never finishes.
4. `terminal_read` when you need the result or need to confirm it finished.

## Reading output and knowing a command finished

- There is no exit-code event. A command has finished when the **shell prompt has come back after the output and nothing is running after it**. A tail that ends mid-output, with a spinner, or with `Listening on…` / `watching for changes` means it is still running.
- `terminal_read` returns the **last 12,000 characters** of the plain-text view by default. Start with the default tail. The result header says `characters A–B of TOTAL`, and either `(this is the end)` or `(more remains: call terminal_read again with offset N)`; use `offset` (character offset in the plain-text view; negative values are treated as 0) and `limit` (1–48,000, default 12,000; larger values are clamped) to page. Do not ask for 48,000 characters out of habit — two small reads cost less context than one huge one.
- `(no output yet)` means nothing was printed yet; wait and read again. To wait without blocking on the terminal, use bash (e.g. `sleep 20`) and then read — do not type `sleep` into a terminal you are about to read.
- You can still read a terminal after its shell has exited (`exited (code N)`), as long as the tab has not been closed — that is where a crashed server's last lines are. You cannot write to an exited terminal.

## Stopping and closing

- **`terminal_interrupt`** — the command is still running and should stop, but the shell and tab are worth keeping (the user told you to stop a test run or server; a command hangs). It sends Ctrl+C. Then `terminal_read` to confirm the prompt came back before you reuse that terminal. After an interrupt the terminal is idle again and safe to reuse once you have seen that prompt.
- **`terminal_close`** — the shell itself is stuck (ignores Ctrl+C, a REPL or full-screen program you started), or you no longer need the tab and the user does not want to look at it. Closing kills the shell and throws away its output, so read anything you still need first.
- Default to interrupt over close. A user who says "stop it" / "停掉" wants the command stopped, not the tab and its scrollback deleted.
- When you finish checking your own work, **leave the terminal open**: the user often wants to look at it themselves. Close only terminals you opened for a throwaway purpose that nobody needs to see, or that the user asked you to close.
- The user may close a tab by hand at any time; the next call on that id fails and says so — call `terminal_list` and start again rather than retrying the same id.

## Examples

- "Start the dev server so I can watch" → `terminal_list`; `terminal_execute` `bun run dev` (new tab); `terminal_read` once to confirm it printed its listening address; tell the user it is running in the panel. Leave it running.
- "Run the tests, they're slow, I want to see the progress" → visible terminal (the user wants to watch); `terminal_execute`; `terminal_read` periodically, reporting the tail; the run is done when the prompt returns.
- "That command is stuck, stop it" (after you started a long command) → `terminal_interrupt` that terminal's id, then `terminal_read` to confirm; do not open a new terminal and do not `close` first.
- "How many files are in this directory?" → `bash`, not a terminal: you only need the answer.
