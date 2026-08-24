Centred dialog on a dimmed backdrop — settings, confirmations, pickers.

```jsx
<Modal open={open} onClose={close} title="Remove workspace" size="small">…</Modal>
```

Sizes cap at 1300/800/480px. The dialog is a solid panel, not glass: glass is reserved for the app's own layered surfaces. Positioned absolutely inside its container, so wrap in a `position: relative` frame when mocking a screen.
