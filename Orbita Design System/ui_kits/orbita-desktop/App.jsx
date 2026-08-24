const { GlassCard, IconButton, Icon } = window.OrbitaDesignSystem_994749;

/* Session actions live on a right-hand rail, mirroring the sidebar: both sit
   directly on layer 1 with no surface of their own. */
function ActionRail({ drawerOpen, onToggleDrawer }) {
  return (
    <aside style={{ flex: "0 0 auto", width: 32, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--space-3)", padding: "var(--space-2) var(--space-3)", background: "transparent", overflow: "hidden" }}>
      <IconButton label={drawerOpen ? "Close files panel" : "Open files panel"} active={drawerOpen} onClick={onToggleDrawer} style={{ background: "var(--color-bg-panel)", border: 0, boxShadow: "none" }}>
        <Icon name="panel-right" size={16} />
      </IconButton>
      <IconButton label="Copy transcript" style={{ background: "var(--color-bg-panel)", border: 0 }}><Icon name="copy" size={16} /></IconButton>
      <IconButton label="Terminal" style={{ background: "var(--color-bg-panel)", border: 0 }}><Icon name="terminal" size={16} /></IconButton>
    </aside>
  );
}
const { Sidebar, HomeScreen, ChatScreen, Drawer, SettingsDialog } = window;

function App() {
  const [page, setPage] = React.useState("home");
  const [exiting, setExiting] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [reply, setReply] = React.useState("");
  const [collapsed, setCollapsed] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [theme, setTheme] = React.useState("light");
  const [wall, setWall] = React.useState("light");
  const [activeId, setActiveId] = React.useState(undefined);
  const [transcript, setTranscript] = React.useState([]);
  const [running, setRunning] = React.useState(false);
  const [readOnly, setReadOnly] = React.useState(["s3"]);

  React.useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);

  const send = (text) => {
    setExiting(true);
    window.setTimeout(() => {
      setTranscript([
        { kind: "user", text, time: "14:31" },
        { kind: "thinking", subtitle: "Reading the composer and the home view…", duration: "2.4s", detail: "Both read --content-max-width; only the position changes." },
        { kind: "tool", name: "read", subtitle: "src/renderer/src/styles.css", duration: "0.4s", icon: "file-text", detail: "23470 lines" },
      ]);
      setActiveId("new");
      setPage("chat");
      setDraft("");
      setExiting(false);
      setRunning(true);
      window.setTimeout(() => {
        setRunning(false);
        setTranscript((t) => [...t, { kind: "assistant", text: "Done. The composer keeps its width; the slogan and session cards fade out and the box glides to the bottom of the window." }]);
      }, 1600);
    }, 240);
  };

  const openSession = (s) => {
    setActiveId(s.id);
    setPage("chat");
    setTranscript(window.TRANSCRIPT);
    setRunning(true);
  };

  const newSession = () => { setPage("home"); setActiveId(undefined); setTranscript([]); setRunning(false); };
  const openTask = window.SESSIONS.find((s) => s.id === activeId);
  const title = page === "chat" ? (openTask?.title ?? "Keep the composer width fixed") : "";
  /* a task with no workspace shows no badge rather than a borrowed one */
  const workspace = openTask?.project;

  return (
    <div className={wall === "dark" ? "desk wall-dark" : "desk"}>
      <div className="probe">
        <button aria-pressed={theme === "light"} onClick={() => setTheme("light")}>Light UI</button>
        <button aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>Dark UI</button>
        <span style={{ width: 1, background: "var(--color-border-subtle)", margin: "4px 2px" }}></span>
        <button aria-pressed={wall === "light"} onClick={() => setWall("light")}>Light wall</button>
        <button aria-pressed={wall === "dark"} onClick={() => setWall("dark")}>Dark wall</button>
      </div>
      <GlassCard layer={1} style={{ height: "100%", maxWidth: "none", display: "flex", gap: "var(--space-3)", padding: "var(--space-3)", overflow: "hidden", position: "relative", border: 0 }}>
        <Sidebar
          collapsed={collapsed}
          onCollapse={() => setCollapsed(true)}
          onExpand={() => setCollapsed(false)}
          activeId={activeId}
          onOpen={openSession}
          onNewSession={newSession}
          onSettings={() => setSettingsOpen(true)}
          sessions={window.SESSIONS}
          readOnly={readOnly}
          onToggleReadOnly={(id) => setReadOnly((r) => (r.includes(id) ? r.filter((x) => x !== id) : [...r, id]))}
        />
        <GlassCard layer={2} as="main" style={{ flex: 1, minWidth: 0, overflow: "hidden", border: 0 }}>
          {page === "home" ? (
            <HomeScreen value={draft} onChange={setDraft} onSubmit={send} exiting={exiting} onOpenSession={openSession} />
          ) : (
            <ChatScreen
              title={title}
              workspace={workspace}
              transcript={transcript}
              value={reply}
              onChange={setReply}
              onSubmit={() => setReply("")}
              running={running}
              drawerOpen={drawerOpen}
              onToggleDrawer={() => setDrawerOpen((v) => !v)}
            />
          )}
        </GlassCard>
        {page === "chat" ? <ActionRail drawerOpen={drawerOpen} onToggleDrawer={() => setDrawerOpen((v) => !v)} /> : null}
        <Drawer open={drawerOpen && page === "chat"} onClose={() => setDrawerOpen(false)} />
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} theme={theme} onTheme={setTheme} />
      </GlassCard>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
