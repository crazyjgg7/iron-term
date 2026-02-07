# Electron on macOS — Screen Capture Lessons Learned

## Context
We needed a HUD app to take region screenshots and render them as draggable “cards”. The original implementation used `desktopCapturer` from the renderer process.

## What Went Wrong
- In the renderer, `window.require('electron')` did not expose `desktopCapturer`.
- Even after attempting to expose `desktopCapturer` from `preload`, the renderer still logged:
  - `no-desktop-capturer`
  - `Cannot read properties of undefined (reading 'getSources')`
- Result: no screenshot data, no cards saved.

## Root Cause
In this environment, `desktopCapturer` was not reliably available to the renderer process (likely due to build/runtime constraints, preload not being applied as expected, or API exposure differences). Debug logs confirmed that only a subset of the Electron API was present in the renderer.

## Final Solution (Reliable)
Switch screenshot capture to macOS native `screencapture` in the **main process**:

1. Renderer sends selected rectangle (absolute screen coordinates) to main via IPC.
2. Main process runs:
   - `screencapture -x -R x,y,w,h /path/to/file.png`
3. PNG is saved directly to user data path and rendered as a HUD card.

### Why this works
- `screencapture` is built into macOS and does not depend on Electron API exposure.
- It handles display coordinates directly and works across multi-monitor setups.
- It avoids the flaky `desktopCapturer` availability and preload bridging issues.

## Practical Debugging Lessons
- Always log preload load status (`preload-ready`) and path existence (`preload-path`).
- If `desktopCapturer` is undefined, do not keep trying to force it—use OS-native capture.
- Keep a fallback path in main process for critical features that depend on OS resources.

## Recommended Pattern (for macOS HUD apps)
- **Renderer**: UI selection + overlay
- **Main**: OS-level capture (screencapture)
- **Storage**: `app.getPath('userData')/cards` + JSON metadata

---

If we ever revisit renderer-based capture, it should be behind a feature flag and only used if `desktopCapturer` is confirmed present in runtime logs.
