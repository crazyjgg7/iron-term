import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

function RotatingRing() {
  const ref = useRef<THREE.Group>(null)

  useFrame((state, delta) => {
    if (ref.current) {
      ref.current.rotation.z += delta * 0.2 // Slow spin
      ref.current.rotation.x = Math.sin(state.clock.elapsedTime * 0.5) * 0.1 // Slight tilt
    }
  })

  return (
    <group ref={ref}>
      {/* Outer Glow Ring */}
      <mesh>
        <torusGeometry args={[3, 0.02, 16, 100]} />
        <meshBasicMaterial color="#00ffff" transparent opacity={0.6} />
      </mesh>

      {/* Inner Segmented Ring */}
      <mesh rotation={[0, 0, 1]}>
        <torusGeometry args={[2.8, 0.05, 16, 8]} />
        <meshBasicMaterial color="#00aaff" wireframe />
      </mesh>

       {/* Core */}
       <mesh>
        <circleGeometry args={[0.5, 32]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.8} />
      </mesh>
    </group>
  )
}

// HUD layout is config-driven so we can switch presets quickly.
type HudLayoutConfig = {
  showCenter: boolean
  showLeftStream: boolean
  showRightStatus: boolean
  show3d: boolean
  modeClass: string
  leftWidthClass?: string
  panels: Array<{ id: string; title: string; className: string; lines: string[] }>
}

type HudPreset = 'daily' | 'entertainment' | 'coding'

type HudEvent =
  | { type: 'alert'; message: string }
  | { type: 'tmux-status'; status: 'offline' | 'monitoring' | 'error' }
  | { type: 'telemetry'; payload: { cpu: number; mem: number; load: number } }

function HudOverlay({
  layoutConfig,
  hudInteractive,
  onToggleHud,
}: {
  layoutConfig: HudLayoutConfig
  hudInteractive: boolean
  onToggleHud: () => void
}) {
  const { ipcRenderer } = window.require('electron')
  const os = window.require('os')

  const [logs, setLogs] = useState<string[]>([
    '[SYS] Boot sequence initialized',
    '[HUD] PTY link pending...',
  ])
  const [alertActive, setAlertActive] = useState(false)
  const [alertMessage, setAlertMessage] = useState<string | null>(null)
  const [alertVisible, setAlertVisible] = useState(false)
  const [telemetry, setTelemetry] = useState({ cpu: 0, mem: 0, load: 0 })
  const [tmuxStatus, setTmuxStatus] = useState<'offline' | 'monitoring' | 'error'>('offline')
  const [tmuxDebug, setTmuxDebug] = useState<string[]>(['waiting...'])
  const [alertLogs, setAlertLogs] = useState<string[] | null>(null)
  const [eventLog, setEventLog] = useState<HudEvent[]>([])
  const [lastCommand, setLastCommand] = useState<string | null>(null)
  const [tmuxSessions, setTmuxSessions] = useState<string[]>([])
  const [tmuxWindows, setTmuxWindows] = useState<string[]>([])
  const [tmuxPanes, setTmuxPanes] = useState<string[]>([])
  const [tmuxSession, setTmuxSession] = useState<string>('')
  const [tmuxWindow, setTmuxWindow] = useState<string>('0')
  const [tmuxPane, setTmuxPane] = useState<string>('0')
  const [voiceVisible, setVoiceVisible] = useState(false)
  const [voiceListening, setVoiceListening] = useState(false)
  const [voiceText, setVoiceText] = useState('')
  const [voiceFinal, setVoiceFinal] = useState('')
  const [voicePreview, setVoicePreview] = useState('')
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null)
  const voiceRef = useRef<any>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const lastFinalRef = useRef<string>('')
  // Terminal stream input state (interactive HUD terminal).
  const [captureInput, setCaptureInput] = useState(false)
  const [inputLine, setInputLine] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const bufferRef = useRef('')
  const logRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const statusLines = [
    `CPU: ${telemetry.cpu}%`,
    `MEM: ${telemetry.mem}%`,
    `LOAD: ${telemetry.load}`,
    'AI: READY',
    `TMUX: ${tmuxStatus.toUpperCase()}`,
  ]

  const panels = layoutConfig.panels

  const handleAlertDismiss = () => {
    setAlertVisible(false)
    setAlertLogs(null)
  }

  const triggerAlertDemo = () => {
    setAlertMessage('[WARN] Demo trigger activated')
    setAlertVisible(true)
    setAlertActive(true)
    window.setTimeout(() => setAlertActive(false), 1200)
  }

  const handleAlertRetry = () => {
    if (!lastCommand) {
      setAlertMessage('[INFO] No command to retry')
      setAlertVisible(true)
      return
    }
    ipcRenderer.send('tmux-send', { keys: lastCommand.split('') })
    ipcRenderer.send('tmux-send', { keys: [], special: 'Enter' })
    setAlertMessage(`[INFO] Retrying: ${lastCommand}`)
    setAlertVisible(true)
  }

  const handleAlertOpenLogs = async () => {
    try {
      const result = await ipcRenderer.invoke('tmux-logs', 200)
      if (result?.ok && result.logs) {
        setAlertLogs(result.logs)
        return
      }
      setAlertLogs([result?.message ?? 'Unable to load tmux logs'])
    } catch {
      setAlertLogs(['Unable to load tmux logs'])
    }
  }

  const pushEvent = (event: HudEvent) => {
    setEventLog((prev) => [...prev.slice(-19), event])
  }

  // tmux stream: receive recent lines from tmux capture-pane.
  useEffect(() => {
    const handleStream = (_event: unknown, data: { lines: string[] }) => {
      const lines = data.lines ?? []
      if (lines.length === 0) return

      setLogs(lines.slice(-24))

      if (lines.some((line) => line.includes('ERROR') || line.includes('WARN'))) {
        setAlertActive(true)
        const recent = lines.find((line) => line.includes('ERROR') || line.includes('WARN'))
        setAlertMessage(recent ?? 'Anomaly detected')
        setAlertVisible(true)
        window.setTimeout(() => setAlertActive(false), 1200)
      }
    }

    ipcRenderer.on('tmux-stream', handleStream)
    return () => {
      ipcRenderer.removeListener('tmux-stream', handleStream)
    }
  }, [ipcRenderer])

  // System telemetry stream (CPU/MEM/Load).
  useEffect(() => {
    const handleTelemetry = (_event: unknown, data: { cpu: number; mem: number; load: number }) => {
      setTelemetry(data)
      pushEvent({ type: 'telemetry', payload: data })
    }

    ipcRenderer.on('system-telemetry', handleTelemetry)

    const poll = window.setInterval(async () => {
      try {
        const data = await ipcRenderer.invoke('get-telemetry')
        setTelemetry(data)
      } catch {
        // Ignore polling errors; push stream may still update.
      }
    }, 1000)

    return () => {
      ipcRenderer.removeListener('system-telemetry', handleTelemetry)
      window.clearInterval(poll)
    }
  }, [ipcRenderer])

  // tmux watchdog status + alert stream.
  useEffect(() => {
    const handleTmuxStatus = (_event: unknown, data: { status: 'offline' | 'monitoring' | 'error' }) => {
      setTmuxStatus(data.status)
      pushEvent({ type: 'tmux-status', status: data.status })
    }

    const handleTmuxAlert = (_event: unknown, data: { message: string }) => {
      setAlertMessage(data.message)
      setAlertVisible(true)
      setAlertActive(true)
      pushEvent({ type: 'alert', message: data.message })
      window.setTimeout(() => setAlertActive(false), 1200)
    }

    const handleTmuxDebug = (_event: unknown, data: { message: string }) => {
      const message = data.message ?? ''
      const isNoisy = message.startsWith('polling via')
      if (isNoisy) return

      setTmuxDebug((prev) => {
        const next = [...prev, message].slice(-2)
        const deduped = next.filter((line, index, arr) => arr.indexOf(line) === index)
        return deduped.length > 0 ? deduped : prev
      })
    }

    ipcRenderer.on('tmux-status', handleTmuxStatus)
    ipcRenderer.on('tmux-alert', handleTmuxAlert)
    ipcRenderer.on('tmux-debug', handleTmuxDebug)

    const poll = window.setInterval(async () => {
      try {
        const data = await ipcRenderer.invoke('tmux-check')
        if (data?.status) setTmuxStatus(data.status)
        if (data?.message && !data.message.startsWith('polling via')) {
          setTmuxDebug([data.message])
        }
        if (data?.session && !tmuxSession) setTmuxSession(data.session)
      } catch {
        // Ignore polling errors
      }
    }, 2000)

    return () => {
      ipcRenderer.removeListener('tmux-status', handleTmuxStatus)
      ipcRenderer.removeListener('tmux-alert', handleTmuxAlert)
      ipcRenderer.removeListener('tmux-debug', handleTmuxDebug)
      window.clearInterval(poll)
    }
  }, [ipcRenderer])

  // tmux target selector.
  useEffect(() => {
    const load = async () => {
      const sessions = await ipcRenderer.invoke('tmux-list-sessions')
      const list = Array.isArray(sessions) ? sessions : []
      setTmuxSessions(list)
      if (list.length > 0) {
        const initial = tmuxSession || list[0]
        setTmuxSession(initial)
      }
    }
    load()
  }, [ipcRenderer])

  useEffect(() => {
    const load = async () => {
      if (!tmuxSession) return
      const windows = await ipcRenderer.invoke('tmux-list-windows', tmuxSession)
      const list = Array.isArray(windows) ? windows : []
      setTmuxWindows(list)
      const initial = list.includes(tmuxWindow) ? tmuxWindow : list[0] ?? '0'
      setTmuxWindow(initial)
    }
    load()
  }, [ipcRenderer, tmuxSession])

  useEffect(() => {
    const load = async () => {
      if (!tmuxSession) return
      const panes = await ipcRenderer.invoke('tmux-list-panes', tmuxSession, tmuxWindow)
      const list = Array.isArray(panes) ? panes : []
      setTmuxPanes(list)
      const initial = list.includes(tmuxPane) ? tmuxPane : list[0] ?? '0'
      setTmuxPane(initial)
    }
    load()
  }, [ipcRenderer, tmuxSession, tmuxWindow])

  useEffect(() => {
    if (!tmuxSession) return
    ipcRenderer.send('tmux-set-target', { session: tmuxSession, window: tmuxWindow, pane: tmuxPane })
  }, [ipcRenderer, tmuxSession, tmuxWindow, tmuxPane])

  // Resize PTY rows/cols based on HUD log panel size.
  useEffect(() => {
    const logEl = logRef.current
    const measureEl = measureRef.current
    if (!logEl || !measureEl) return

    const sendResize = () => {
      const rect = logEl.getBoundingClientRect()
      const charRect = measureEl.getBoundingClientRect()
      const charWidth = Math.max(6, charRect.width)
      const lineHeight = Math.max(12, charRect.height)
      const cols = Math.max(20, Math.floor(rect.width / charWidth))
      const rows = Math.max(5, Math.floor(rect.height / lineHeight))
      ipcRenderer.send('pty-resize', cols, rows)
    }

    const observer = new ResizeObserver(() => {
      sendResize()
    })

    observer.observe(logEl)
    sendResize()

    return () => observer.disconnect()
  }, [ipcRenderer])

  // Use a hidden input for reliable key handling (history, arrows, etc.).
  useEffect(() => {
    if (captureInput) {
      inputRef.current?.focus()
    } else {
      inputRef.current?.blur()
    }
  }, [captureInput])

  // Terminal-stream key handling (history, submit, edit).
  const sendSpecial = (value: string) => {
    ipcRenderer.send('tmux-send', { keys: [], special: value })
  }

  const handleInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!captureInput) return

    if (event.key === 'Escape') {
      event.preventDefault()
      setCaptureInput(false)
      sendSpecial('Escape')
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (history.length === 0) return
      sendSpecial('Up')
      setHistoryIndex((prev) => {
        const nextIndex = prev === null ? history.length - 1 : Math.max(0, prev - 1)
        const nextValue = history[nextIndex] ?? ''
        setInputLine(nextValue)
        return nextIndex
      })
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (history.length === 0) return
      sendSpecial('Down')
      setHistoryIndex((prev) => {
        if (prev === null) return null
        const nextIndex = Math.min(history.length, prev + 1)
        const nextValue = history[nextIndex] ?? ''
        setInputLine(nextValue)
        return nextIndex >= history.length ? null : nextIndex
      })
      return
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      sendSpecial('Left')
      return
    }

    if (event.key === 'ArrowRight') {
      event.preventDefault()
      sendSpecial('Right')
      return
    }

    if (event.key === 'Tab') {
      event.preventDefault()
      sendSpecial('Tab')
      return
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      sendSpecial('C-c')
      return
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      sendSpecial('C-l')
      return
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      sendSpecial('C-d')
      return
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      sendSpecial('C-a')
      return
    }

    if (event.ctrlKey && event.key.toLowerCase() === 'e') {
      event.preventDefault()
      sendSpecial('C-e')
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      sendSpecial('Enter')
      if (inputLine.trim().length > 0) {
        setHistory((prev) => [...prev.slice(-49), inputLine])
        setLastCommand(inputLine.trim())
      }
      setHistoryIndex(null)
      setInputLine('')
      return
    }

    if (event.key === 'Backspace') {
      sendSpecial('BSpace')
      return
    }

    if (event.key.length === 1) {
      ipcRenderer.send('tmux-send', { keys: [event.key] })
    }
  }

  const startVoice = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const audioContext = new AudioContext({ sampleRate: 16000 })
      const source = audioContext.createMediaStreamSource(stream)
      const processor = audioContext.createScriptProcessor(4096, 1, 1)

      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0)
        const buffer = new ArrayBuffer(input.length * 2)
        const view = new DataView(buffer)
        for (let i = 0; i < input.length; i += 1) {
          const s = Math.max(-1, Math.min(1, input[i]))
          view.setInt16(i * 2, s * 0x7fff, true)
        }
        ipcRenderer.send('asr-audio', buffer)
      }

      source.connect(processor)
      processor.connect(audioContext.destination)

      audioContextRef.current = audioContext
      mediaStreamRef.current = stream
      processorRef.current = processor

      setVoiceVisible(true)
      setVoiceListening(true)
      setVoiceText('')
      setVoiceFinal('')
      setVoicePreview('')
      lastFinalRef.current = ''
      await ipcRenderer.invoke('asr-start', audioContext.sampleRate)
    } catch {
      setVoiceVisible(true)
      setVoiceListening(false)
      setVoiceText('Microphone capture failed.')
    }
  }

  const stopVoice = () => {
    ipcRenderer.send('asr-stop')
    processorRef.current?.disconnect()
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
    audioContextRef.current?.close()
    processorRef.current = null
    mediaStreamRef.current = null
    audioContextRef.current = null
    setVoiceListening(false)
  }

  useEffect(() => {
    const handleVoiceToggle = () => {
      if (voiceListening) {
        stopVoice()
      } else {
        startVoice()
      }
    }

    const handleVoiceHotkeyDown = (event: KeyboardEvent) => {
      if (!(event.altKey && event.key.toLowerCase() === 'v')) return
      handleVoiceToggle()
    }

    window.addEventListener('keydown', handleVoiceHotkeyDown)
    ipcRenderer.on('voice-toggle-request', handleVoiceToggle)
    return () => {
      window.removeEventListener('keydown', handleVoiceHotkeyDown)
      ipcRenderer.removeListener('voice-toggle-request', handleVoiceToggle)
    }
  }, [voiceListening, ipcRenderer])

  const handleVoiceCopy = async () => {
    try {
      await navigator.clipboard.writeText(voiceText)
    } catch {
      // Clipboard may be blocked; ignore silently
    }
  }

  const handleVoiceCommand = () => {
    if (!voiceText.trim()) return
    ipcRenderer.send('tmux-send', { keys: voiceText.split('') })
    ipcRenderer.send('tmux-send', { keys: [], special: 'Enter' })
  }

  const handleVoiceClose = () => {
    setVoiceVisible(false)
    setVoiceListening(false)
  }

  useEffect(() => {
    const handleAsrResult = (_event: unknown, data: { text: string; isFinal?: boolean; name?: string }) => {
      if (data.isFinal) {
        setVoicePreview('')
        setVoiceFinal((prev) => {
          const clean = data.text.trim()
          if (!clean) return prev
          if (clean === lastFinalRef.current) return prev
          lastFinalRef.current = clean
          const next = prev && clean.startsWith(prev) ? clean : `${prev} ${clean}`.trim()
          setVoiceText(next)
          return next
        })
        return
      }
      setVoicePreview(data.text)
    }
    const handleAsrError = (_event: unknown, data: { message: string }) => {
      setVoiceText(`ASR ERROR: ${data.message}`)
    }

    ipcRenderer.on('asr-result', handleAsrResult)
    ipcRenderer.on('asr-error', handleAsrError)
    return () => {
      ipcRenderer.removeListener('asr-result', handleAsrResult)
      ipcRenderer.removeListener('asr-error', handleAsrError)
    }
  }, [ipcRenderer])

  const handleVoiceCheck = async () => {
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true })
      setVoiceStatus('Microphone: OK')
    } catch {
      setVoiceStatus('Microphone: BLOCKED')
    }
  }

  const promptPrefix = `${os.userInfo().username}@${os.hostname()}:~$`

  const handleMouseEnter = () => {
    // When mouse is OVER the UI, capture events (make clickable)
    if (!hudInteractive) return
    ipcRenderer.send('set-ignore-mouse-events', false)
  }

  const handleMouseLeave = () => {
    // When mouse leaves UI, ignore events (click through to Mac)
    // Disabled: auto-pass-through was causing loss of control.
  }

  return (
    <div className="hud-root" onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      {layoutConfig.showLeftStream && (
        <div
          className={`hud-panel hud-panel-left ${layoutConfig.leftWidthClass ?? ''} ${alertActive ? 'hud-alert' : ''}`}
          onClick={() => setCaptureInput((prev) => !prev)}
        >
          <div className="hud-title">TERMINAL STREAM</div>
          <div className="hud-line hud-subtle">
            INPUT: {captureInput ? 'CAPTURED (ESC to release)' : 'CLICK TO CAPTURE'}
          </div>
          <div className="hud-log" ref={logRef}>
            <span className="hud-measure" ref={measureRef}>
              M
            </span>
            <input
              ref={inputRef}
              className="hud-hidden-input"
              value={inputLine}
              onChange={(event) => setInputLine(event.target.value)}
              onKeyDown={handleInputKeyDown}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
            />
            {logs.map((line, index) => (
              <div className="hud-log-line" key={`${line}-${index}`}>
                {line}
              </div>
            ))}
            <div className={`hud-input ${captureInput ? 'is-active' : ''}`}>
              <span className="hud-input-prefix">{promptPrefix}</span>
              <span className="hud-input-text">{inputLine}</span>
              <span className="hud-cursor" />
            </div>
          </div>
        </div>
      )}

      {layoutConfig.showRightStatus && (
        <div className={`hud-panel hud-panel-right ${alertActive ? 'hud-alert' : ''}`}>
          <div className="hud-title">SYSTEM STATUS</div>
          {statusLines.map((line) => (
            <div className="hud-line" key={line}>
              {line}
            </div>
          ))}
          {tmuxDebug.map((line, index) => (
            <div className="hud-line hud-subtle" key={`tmux-debug-${index}`}>
              TMUX DEBUG: {line}
            </div>
          ))}
          <div className="hud-select-row">
            <label className="hud-select-label" htmlFor="tmux-session">SESSION</label>
            <select
              id="tmux-session"
              className="hud-select"
              value={tmuxSession}
              onChange={(event) => setTmuxSession(event.target.value)}
            >
              {tmuxSessions.map((session) => (
                <option key={session} value={session}>
                  {session}
                </option>
              ))}
            </select>
          </div>
          <div className="hud-select-row">
            <label className="hud-select-label" htmlFor="tmux-window">WINDOW</label>
            <select
              id="tmux-window"
              className="hud-select"
              value={tmuxWindow}
              onChange={(event) => setTmuxWindow(event.target.value)}
            >
              {tmuxWindows.map((windowId) => (
                <option key={windowId} value={windowId}>
                  {windowId}
                </option>
              ))}
            </select>
          </div>
          <div className="hud-select-row">
            <label className="hud-select-label" htmlFor="tmux-pane">PANE</label>
            <select
              id="tmux-pane"
              className="hud-select"
              value={tmuxPane}
              onChange={(event) => setTmuxPane(event.target.value)}
            >
              {tmuxPanes.map((paneId) => (
                <option key={paneId} value={paneId}>
                  {paneId}
                </option>
              ))}
            </select>
          </div>
          <button className="hud-demo-button" onClick={triggerAlertDemo} type="button">
            TRIGGER ALERT
          </button>
        </div>
      )}

      {alertVisible && (
        <div className="hud-alert-panel">
          <div className="hud-title">AI ALERT</div>
          <div className="hud-line hud-alert-text">{alertMessage ?? 'Anomaly detected'}</div>
          <div className="hud-line hud-subtle">SUGGESTION: REVIEW LAST COMMAND</div>
          <div className="hud-alert-actions">
            <button className="hud-alert-button" onClick={handleAlertDismiss} type="button">
              DISMISS
            </button>
            <button className="hud-alert-button" onClick={handleAlertRetry} type="button">
              RETRY
            </button>
            <button className="hud-alert-button" onClick={handleAlertOpenLogs} type="button">
              OPEN LOGS
            </button>
          </div>
          {alertLogs && (
            <div className="hud-alert-logs">
              {alertLogs.map((line, index) => (
                <div key={`${line}-${index}`} className="hud-alert-log-line">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {panels.map((panel) => (
        <div className={panel.className} key={panel.id}>
          <div className="hud-title">{panel.title}</div>
          {panel.lines.map((line) => (
            <div className="hud-line" key={`${panel.id}-${line}`}>
              {line}
            </div>
          ))}
          {panel.id === 'nav' && voiceVisible && (
            <div className={`hud-voice-panel ${voiceListening ? 'is-listening' : ''}`}>
              <div className="hud-voice-title">VOICE COMMAND</div>
              <textarea
                className="hud-voice-text"
                value={voiceText}
                onChange={(event) => setVoiceText(event.target.value)}
                rows={3}
              />
              {voicePreview && <div className="hud-voice-preview">{voicePreview}</div>}
              {voiceStatus && <div className="hud-voice-status">{voiceStatus}</div>}
              <div className="hud-voice-actions">
                <button className="hud-voice-button" type="button" onClick={handleVoiceCopy}>
                  CUT
                </button>
                <button className="hud-voice-button" type="button" onClick={handleVoiceCommand}>
                  COMMAND
                </button>
                <button
                  className="hud-voice-button"
                  type="button"
                  onClick={() => (voiceListening ? stopVoice() : startVoice())}
                >
                  {voiceListening ? 'STOP' : 'START'}
                </button>
                <button className="hud-voice-button" type="button" onClick={handleVoiceCheck}>
                  CHECK
                </button>
                <button className="hud-voice-button" type="button" onClick={handleVoiceClose}>
                  CLOSE
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

    </div>
  )
}

function App() {
  const [preset, setPreset] = useState<HudPreset>('daily')
  const [hudInteractive, setHudInteractive] = useState(true)

  const presets: Record<HudPreset, HudLayoutConfig> = {
    daily: {
      show3d: true,
      modeClass: 'mode-daily',
      showCenter: true,
      showLeftStream: true,
      showRightStatus: true,
      panels: [
        { id: 'nav', title: 'NAV', className: 'hud-corner hud-top-left', lines: ['MODE: HEAD-LOCK', 'ALIGN: STABLE'] },
        { id: 'tasks', title: 'TASKS', className: 'hud-corner hud-bottom-left', lines: ['BUILD: IDLE', 'DEPLOY: READY'] },
        { id: 'sensors', title: 'SENSORS', className: 'hud-corner hud-bottom-right', lines: ['AUDIO: OK', 'VISION: OK'] },
      ],
    },
    entertainment: {
      show3d: false,
      modeClass: 'mode-entertainment',
      showCenter: false,
      showLeftStream: false,
      showRightStatus: true,
      panels: [
        { id: 'media', title: 'MEDIA', className: 'hud-corner hud-bottom-right', lines: ['MODE: CINEMA', 'AUDIO: IMMERSIVE', 'HUD: MINIMAL'] },
        { id: 'ambience', title: 'AMBIENCE', className: 'hud-corner hud-bottom-left', lines: ['LIGHTS: SOFT', 'NOISE: LOW'] },
      ],
    },
    coding: {
      show3d: true,
      modeClass: 'mode-coding',
      leftWidthClass: 'hud-panel-wide',
      showCenter: true,
      showLeftStream: true,
      showRightStatus: true,
      panels: [
        { id: 'nav', title: 'NAV', className: 'hud-corner hud-top-left', lines: ['MODE: HEAD-LOCK', 'ALIGN: STABLE'] },
        { id: 'tasks', title: 'TASKS', className: 'hud-corner hud-bottom-left', lines: ['BUILD: WATCH', 'DEPLOY: READY'] },
        { id: 'sensors', title: 'DEV', className: 'hud-corner hud-bottom-right', lines: ['LINT: OK', 'TESTS: OK', 'TYPECHECK: OK'] },
      ],
    },
  }

  const layoutConfig = presets[preset]

  useEffect(() => {
    const stored = window.localStorage.getItem('iron-term:preset') as HudPreset | null
    if (stored && presets[stored]) {
      setPreset(stored)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem('iron-term:preset', preset)
  }, [preset])

  useEffect(() => {
    const handlePresetHotkey = (event: KeyboardEvent) => {
      if (!event.altKey) return

      if (event.key === '1') setPreset('daily')
      if (event.key === '2') setPreset('entertainment')
      if (event.key === '3') setPreset('coding')
    }

    window.addEventListener('keydown', handlePresetHotkey)
    return () => window.removeEventListener('keydown', handlePresetHotkey)
  }, [])

  useEffect(() => {
    const { ipcRenderer } = window.require('electron')
    ipcRenderer.send('set-ignore-mouse-events', !hudInteractive, { forward: true })
  }, [hudInteractive])

  useEffect(() => {
    const { ipcRenderer } = window.require('electron')

    const handleHudToggle = (event: KeyboardEvent) => {
      if (!(event.metaKey && event.shiftKey && event.key.toLowerCase() === 'm')) return
      setHudInteractive((prev) => !prev)
    }

    const handleHudToggleRequest = () => {
      setHudInteractive((prev) => !prev)
    }

    window.addEventListener('keydown', handleHudToggle)
    ipcRenderer.on('hud-toggle-request', handleHudToggleRequest)
    return () => {
      window.removeEventListener('keydown', handleHudToggle)
      ipcRenderer.removeListener('hud-toggle-request', handleHudToggleRequest)
    }
  }, [])

  return (
    <>
      {/* 3D Background Layer (Pass-through) */}
      {layoutConfig.show3d && (
        <div className="layer-3d">
          <Canvas camera={{ position: [0, 0, 5] }}>
            <ambientLight />
            <RotatingRing />
          </Canvas>
        </div>
      )}

      {/* 2D UI Layer (Interactive) */}
      <div className={`layer-ui ${layoutConfig.modeClass}`}>
        <HudOverlay layoutConfig={layoutConfig} hudInteractive={hudInteractive} onToggleHud={() => setHudInteractive((prev) => !prev)} />
        {layoutConfig.showCenter && (
          <div className="hud-center">
            <div className="hud-center-ring" />
            <div className="hud-center-label">FOCUS GRID</div>
          </div>
        )}
        <div className="hud-preset">
          MODE: {preset.toUpperCase()} (OPTION+1/2/3) · HUD: {hudInteractive ? 'INTERACTIVE' : 'PASS-THROUGH'}
        </div>
      </div>
    </>
  )
}

export default App
