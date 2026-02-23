# Quick Sticky

> Glass-style sticky notes for any webpage, powered by Chrome Extension Manifest V3.

[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)
[![Status](https://img.shields.io/badge/status-active-success)](#)

<img width="445" height="255" alt="image" src="https://github.com/user-attachments/assets/054127fe-dc52-4850-9152-66ebbfa05dbd" />
<<img width="552" height="498" alt="image" src="https://github.com/user-attachments/assets/d95742c9-8887-4bc9-b3ec-6c69360b470f" />

Quick Sticky lets you create lightweight notes exactly where your cursor is, then keep them available across browsing sessions with local persistence.

## Highlights

- `Alt + N` creates a new sticky note at the current mouse position.
- Instant focus after creation so you can type immediately.
- Mac-like glassmorphism UI with rounded corners and soft shadows.
- Full UI isolation with Shadow DOM to avoid website CSS conflicts.
- Drag-and-drop image support (stored as Base64).
- Smart YouTube link cards (title + thumbnail via oEmbed).
- Auto-save with `chrome.storage.local` in near real time.
- History panel with:
  - time-desc sorting (latest first)
  - day/month/year filtering
  - open/closed status
  - drag-to-move panel behavior
- Note lifecycle:
  - `Close`: hide note (kept in storage)
  - `Delete`: permanent removal
- History item click toggles note state:
  - open -> close
  - closed -> reopen

## How It Works

### 1) Create

Press `Alt + N` to create a note at the cursor location.

### 2) Edit

Type text directly, drag images into the note, or paste a YouTube URL and press `Enter`.

### 3) Manage

Use note controls:

- `Close`: hide without deleting
- `Delete`: remove permanently

### 4) Browse History

Open `Note History` from the menu icon and filter by:

- Date
- Month
- Year

History stays open until you explicitly press `x`.

## Install (Developer Mode)

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select the `quick-sticky` folder
5. Reload your target webpage

## Keyboard Shortcut

Default shortcut is `Alt + N`.

If needed, change it in:

- `chrome://extensions/shortcuts`

## Storage Model

Quick Sticky stores data in `chrome.storage.local` under:

- key: `quickStickyNotesByPage`

Each note includes:

- `id`
- `x`, `y`
- `text`
- `items` (image/youtube)
- `createdAt`, `updatedAt`
- `isClosed`
- `storagePageKey`

`storagePageKey` is set when the note is created and kept stable afterward.
This means a note can be reopened from history on other pages while preserving its original source key.

## Project Structure

```text
quick-sticky/
  manifest.json     # MV3 config, permissions, commands
  background.js     # command listener and content message bridge
  content.js        # core runtime: notes, history, persistence
  styles.css        # glass UI styles (inside Shadow DOM)
```

## Permissions

- `storage`: persist notes locally
- `tabs`: send command-triggered messages to active tab
- host permission `https://www.youtube.com/*`: fetch oEmbed metadata for YouTube cards

## Design Notes

- UI is rendered inside Shadow DOM to minimize CSS collision risk.
- Visual direction is intentionally macOS-inspired:
  - translucent layers
  - backdrop blur
  - soft elevation
  - compact control surfaces

## Known Constraints

- Notes are browser-profile local (`chrome.storage.local`) and not account-synced by default.
- Large image-heavy notes may increase storage usage quickly due to Base64 encoding.
- Chrome internal pages (like `chrome://...`) do not run content scripts.

## Roadmap Ideas

- Optional cloud sync (account-based)
- Export/Import JSON
- Rich text formatting
- Tagging and search in history
- Per-note color themes

## Contributing

Issues and PRs are welcome.

If you contribute UI or behavior changes, include:

- reproduction steps
- before/after behavior
- storage impact notes if schema changes

## License

MIT
