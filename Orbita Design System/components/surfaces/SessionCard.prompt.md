The recent-session card that sits above the composer on the home screen — a layer-3 glass card, four lines exactly.

```jsx
<SessionCard name="orbita-desktop" queries={["Refactor the composer", "Fix the tool card", "Add glass tokens"]} running />
```

Always renders three query slots (blank if fewer) so a row of cards stays flush. Hover lifts the shadow only; nothing moves.
