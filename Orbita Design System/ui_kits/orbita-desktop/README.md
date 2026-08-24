# UI kit — Orbita desktop

A click-through recreation of the app's primary surface, built from this system's components.
Open `index.html`.

## What it recreates

- **Home screen (Agent mode).** The three glass layers, the brand-serif slogan, three recent-session
  cards, and the composer with its scope / permission / model / effort chips.
- **The send transition.** Type anything and press Enter: the slogan and session cards fade up, the
  composer glides toward the bottom of the window, and the chat page takes over. Motion explains
  where the input box went — nothing else.
- **Chat page.** Header with session title, project and agent id; transcript of user bubbles, a
  collapsed thinking line, collapsed tool calls (click any to expand), assistant prose, and the
  running indicator. The composer keeps the same width it had on the home screen.
- **Sidebar.** Wordmark, mode chips (Agent selected, Orchestrate disabled), search, project groups
  with session rows, hover lock toggles, usage cells. Collapses to the 48px icon rail and back.
- **Right drawer.** Closed by default; opens to the changed-files list.
- **Settings dialog.** Appearance and conversation settings; the theme select switches the whole kit
  between the light and dark themes.

## Files

| File | Contents |
| --- | --- |
| `index.html` | Page shell, desk background, transition classes, script loading |
| `App.jsx` | Shell layout (layer-1 glass card), page state, the send transition |
| `Sidebar.jsx` | Expanded sidebar, icon rail, project groups |
| `HomeScreen.jsx` | Slogan, session cards, home composer |
| `ChatScreen.jsx` | Chat header, transcript turns, chat composer |
| `Drawer.jsx` | Right-hand changed-files panel |
| `SettingsDialog.jsx` | Settings modal |
| `data.js` | Fake sessions, projects, transcript, file list |

## Deliberately not recreated

The renderer contains surfaces whose visuals are unshipped or in flux, and this kit leaves them out
rather than invent them: orchestration / multi-agent topology (`atom`), the terminal dock, the
browser panel, the Feishu integration, the Monaco editor and diff viewer, the scratch pad, the
desktop pet, and the full config modal (only a small settings dialog stands in). The drawer shows the
files slice only; git, terminal and browser tabs are omitted.
