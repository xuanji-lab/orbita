A tool call in the transcript: one line collapsed, output on click. Simple by default, expandable on demand.

```jsx
<ToolCard name="read" subtitle="src/renderer/styles.css" duration="0.4s" detail="23470 lines" />
```

No border, no fill — it sits directly on the chat surface. `tone="running"` makes the head (icon + name) breathe at secondary — breathing is the running signal, there is no spinner; once the row settles the whole row recedes to tertiary, and `tone="error"` turns the status red. Never leave output expanded by default in a mock unless the point is the expanded state.
