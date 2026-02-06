# Project Iron-Term — Status & Roadmap (Updated)

Date: 2026-02-06

## ✅ Completed

### Phase 1 — Look (Visual & Container)
- Electron transparent, frameless, always-on-top HUD window
- Mouse click-through + hover capture (IPC control)
- 3D rotating ring background (R3F)
- HUD overlay layout (left stream, right status, corners, center ring)
- Black transparent background verified on-device
- Readability validated (no ghosting)
- Visual theme: Matrix-green data + white titles
- Alert pulse on WARN/ERROR
- Scanline effect (basic)

### Phase 2 — Data (Terminal Stream)
- tmux-based terminal stream (primary channel)
- Real terminal output streamed to renderer (tmux capture-pane)
- Input capture toggle (click to capture, ESC to release)
- Input line with prompt + cursor
- Command history (↑/↓) and line editing
- Enhanced input (arrows, Tab, Ctrl+C/L/D/A/E)
- tmux pane selector (Session / Window / Pane)

### Phase 3 — Brain (AI Watchdog)
- Alert UI panel scaffold (AI ALERT)
- Auto-trigger from WARN/ERROR lines
- Actions: Dismiss / Retry (re-run last command) / Open Logs (last 200 lines)

### Phase 4 — Evolution (Interaction)
- Layout presets (Daily / Entertainment / Coding) with hotkeys Option+1/2/3
- Per-mode visual tuning (opacity, font size)
- Coding mode wide log panel
- HUD interaction toggle via dedicated control window

### Phase 4 — Voice (Aliyun NLS)
- WebSocket realtime ASR (16k PCM)
- Push-to-talk switched to toggle mode (Option+V)
- ICE-blue voice panel under NAV
- Editable transcript
- Buttons: CUT / COMMAND / START/STOP / CHECK / CLOSE
- Final results accumulate across sentences
- Preview line for interim results
- Duplicate final suppression on stop

## 🟡 In Progress / Next

### Voice Control Polishing
- Language switch (zh/en) toggle
- Command template / regex cleanup for parameter-heavy commands

### Alert/Watchdog Enhancements
- De-dup strategy for repetitive WARN/ERROR
- Context window (error ± N lines)

### System Telemetry
- Add NET throughput, disk, battery (optional)

### UX Polishing
- Control window placement robustness on multi-display
- Reduce debug noise / optional debug toggle

### New Feature — Clipboard Screenshot Cards
- HUD provides a dedicated "Screenshot" button (avoid OS shortcut conflicts)
- Captured screenshot becomes a draggable card in HUD
- Card shows thumbnail + timestamp/label
- Supports drag anywhere on screen
- Supports lock/unlock switch (pin position)
- Click to toggle size (small ↔ large)
- Visual style uses Iron-Term HUD line/frame aesthetics
- Cards persist in HUD until manually removed

## 🔧 Known Issues / Risks
- Web Speech API not used; Aliyun NLS requires valid keys/token
- tmux selector depends on tmux server visibility

## 📌 Files of Interest
- `electron/main.ts` (window config, tmux, IPC, ASR)
- `src/App.tsx` (HUD layout, tmux stream, voice UI)
- `src/index.css` (HUD styling)
- `package.json`
- `vite.config.ts`

