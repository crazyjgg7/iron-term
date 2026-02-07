import { desktopCapturer, ipcRenderer } from 'electron'

// Expose desktopCapturer for renderer-side screen capture.
;(window as unknown as { desktopCapturer?: typeof desktopCapturer }).desktopCapturer = desktopCapturer
;(window as unknown as { ironTerm?: { getSources?: typeof desktopCapturer.getSources } }).ironTerm = {
  getSources: desktopCapturer.getSources.bind(desktopCapturer),
}

ipcRenderer.send('preload-ready', { hasDesktopCapturer: Boolean(desktopCapturer) })

// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts
window.addEventListener('DOMContentLoaded', () => {
  const replaceText = (selector: string, text: string) => {
    const element = document.getElementById(selector)
    if (element) element.innerText = text
  }

  for (const type of ['chrome', 'node', 'electron']) {
    replaceText(`${type}-version`, process.versions[type] as string)
  }
})
