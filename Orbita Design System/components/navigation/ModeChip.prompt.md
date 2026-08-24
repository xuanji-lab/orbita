The two-up mode row at the top of the sidebar — Agent mode is the product's primary surface; Orchestrate is where multi-agent complexity hides.

```jsx
<div style={{display:"flex",gap:4}} role="tablist">
  <ModeChip icon={<Icon name="bot" size={14} />} active>Agent mode</ModeChip>
  <ModeChip icon={<Icon name="workflow" size={14} />} disabled>Orchestrate</ModeChip>
</div>
```

Selection is the only place this colour appears.
