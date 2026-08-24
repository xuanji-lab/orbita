The input box — one control, one treatment. It carries the home screen and becomes the chat composer without changing its look.

```jsx
<Composer
  value={value}
  onChange={setValue}
  onSubmit={send}
  topSlot={<Chip icon={<Icon name="folder" size={12} />} chevron>Current project</Chip>}
  bottomSlot={<><Chip chevron>Full access</Chip><Chip chevron>GLM-5.3</Chip></>}
/>
```

Keep the width identical on both pages (`--content-max-width`); when the first message is sent the box glides to the bottom of the window and nothing about it changes but its vertical position. The round accent button is the only accent on the home screen.

There is no solid variant. The composer is always a layer-3 glass card, so it takes `--radius-xl` (10px) — the glass radius — on both pages. On the chat page it sits on the layer-2 chat surface, which is the intended l3-on-l2 stack.
