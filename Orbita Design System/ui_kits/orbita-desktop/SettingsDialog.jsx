const { Modal, SelectField, TextField, Button, Badge } = window.OrbitaDesignSystem_994749;

function SettingsDialog({ open, onClose, theme, onTheme }) {
  return (
    <Modal open={open} onClose={onClose} title="Settings" size="medium">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
        <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--font-size-body)", fontWeight: "var(--weight-semibold)" }}>Appearance</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
            <SelectField label="Theme" value={theme} onChange={onTheme} options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} description="Selection reads blue on light, yellow on dark." />
            <SelectField label="UI text size" value="default" onChange={() => {}} options={[{ value: "compact", label: "Compact" }, { value: "default", label: "Default" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]} />
          </div>
        </section>
        <section style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
          <h3 style={{ margin: 0, fontSize: "var(--font-size-body)", fontWeight: "var(--weight-semibold)" }}>Conversation</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-4)" }}>
            <TextField label="Content width" value="1000" onChange={() => {}} type="number" description="Shared by the transcript and the composer." />
            <SelectField label="Default permission" value="full" onChange={() => {}} options={[{ value: "full", label: "Full access" }, { value: "plan", label: "Plan only" }, { value: "read", label: "Read-only" }]} />
          </div>
        </section>
        <section style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <Badge variant="muted" mono>orbita 0.9.4</Badge>
          <span style={{ flex: 1 }} />
          <Button variant="secondary" buttonSize="sm" onClick={onClose}>Cancel</Button>
          <Button variant="accent" buttonSize="sm" onClick={onClose}>Save</Button>
        </section>
      </div>
    </Modal>
  );
}

Object.assign(window, { SettingsDialog });
