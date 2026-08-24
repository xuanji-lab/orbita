const SESSIONS = [
  { id: "s1", title: "Unify the glass alphas", time: "14:22", running: true, project: "orbita-desktop", queries: ["Unify the glass alphas", "One opacity per layer", "Check the dark theme"] },
  { id: "s2", title: "Collapse tool output by default", time: "13:40", status: "done", project: "orbita-desktop", queries: ["Collapse tool output", "Keep thinking on one line"] },
  { id: "s3", title: "Split styles.css into tokens", time: "Aug 21", readOnly: true, project: "renderer", queries: ["Split styles.css", "Move fonts out", "Keep the theme scopes"] },
  { id: "s4", title: "Home screen lands in Agent mode", time: "Aug 21", status: "failed", project: "renderer" },
  { id: "s5", title: "Composer keeps its width", time: "Aug 20", project: "notes" },
  /* no project — these hang off the Tasks node */
  { id: "s6", title: "Name the sidebar hierarchy", time: "Aug 19", status: "done" },
  { id: "s7", title: "Check the dark theme contrast", time: "Aug 18" },
];

const PROJECTS = [
  { id: "p1", name: "orbita-desktop", branch: "main", count: 12, sessions: ["s1", "s2"] },
  { id: "p2", name: "renderer", branch: "feature/glass", count: 7, sessions: ["s3", "s4"] },
  { id: "p3", name: "notes", count: 3, sessions: ["s5"] },
];

const TRANSCRIPT = [
  { kind: "user", text: "Collapse tool output by default, and keep the composer the same width on both pages.", time: "14:19" },
  { kind: "thinking", subtitle: "Both pages read --content-max-width, so the box can keep its width…", duration: "3.1s", detail: "The home composer and the chat composer are the same component. If both read --content-max-width, the transition only needs to move the box, not resize it." },
  { kind: "tool", name: "read", subtitle: "src/renderer/src/styles.css", duration: "0.4s", icon: "file-text", detail: "23470 lines · --content-max-width: 1000px" },
  { kind: "tool", name: "edit", subtitle: "components/app/HomeView.tsx", status: "2 hunks", duration: "1.2s", icon: "pencil-line", detail: "+ width: min(100%, var(--content-max-width))" },
  { kind: "assistant", text: "Tool calls now collapse to one line — the name, its argument, and how long it took. Click any row to read the output.\n\nThe composer reads the same width token on both pages, so sending the first message only moves it: the slogan and session cards fade up, the box glides to the bottom, and nothing resizes." },
  { kind: "user", text: "Good. Now make the thinking block quiet too.", time: "14:22", delivery: "steer" },
  { kind: "tool", name: "bash", subtitle: "pnpm -C renderer typecheck", tone: "running", status: "running", icon: "terminal" },
];

const DRAWER_FILES = [
  { name: "styles.css", path: "src/renderer/src", state: "M", added: 128, removed: 41 },
  { name: "HomeView.tsx", path: "src/renderer/src/components/app", state: "M", added: 34, removed: 12 },
  { name: "tokens/glass.css", path: "src/renderer/src", state: "A", added: 22, removed: 0 },
  { name: "AgentSidebar.tsx", path: "src/renderer/src/features/agent/components", state: "M", added: 9, removed: 3 },
];

Object.assign(window, { SESSIONS, PROJECTS, TRANSCRIPT, DRAWER_FILES });
