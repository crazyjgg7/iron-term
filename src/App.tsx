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

type ScreenshotCard = {
  id: string
  fileUrl: string
  timestamp: string
  label: string
  x: number
  y: number
  width: number
  height: number
  locked: boolean
  size: 'small' | 'large'
}

type AppProxyCard = {
  id: string
  fileUrl: string
  filePath?: string
  label: string
  appName: string
  bundleId?: string
  x: number
  y: number
}

function HudOverlay({
  layoutConfig,
  hudInteractive,
  onToggleHud,
  onSetHudInteractive,
}: {
  layoutConfig: HudLayoutConfig
  hudInteractive: boolean
  onToggleHud: () => void
  onSetHudInteractive: (value: boolean) => void
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
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const lastFinalRef = useRef<string>('')
  const [cards, setCards] = useState<ScreenshotCard[]>([])
  const [captureMode, setCaptureMode] = useState(false)
  const [selectRect, setSelectRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const dragOffsetRef = useRef<{ x: number; y: number } | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [appPickerVisible, setAppPickerVisible] = useState(false)
  const [appList, setAppList] = useState<{ name: string; bundleId: string }[]>([])
  const [appWindows, setAppWindows] = useState<{ appName: string; title: string; id: string; x?: string; y?: string; w?: string; h?: string; displayIndex?: string; displayX?: string; displayY?: string; displayW?: string; displayH?: string }[]>([])
  const [selectedApp, setSelectedApp] = useState<string | null>(null)
  const [appCards, setAppCards] = useState<AppProxyCard[]>([])
  const [activeAppCardId, setActiveAppCardId] = useState<string | null>(null)
  const [appDragId, setAppDragId] = useState<string | null>(null)
  const appDragOffsetRef = useRef<{ x: number; y: number } | null>(null)
  const appDragFrameRef = useRef<number | null>(null)

  const normalizeCards = (list: any[]): ScreenshotCard[] =>
    list.map((card) => ({
      ...card,
      size: card.size === 'large' ? 'large' : 'small',
    }))
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

  const openAppPicker = async () => {
    const result = await ipcRenderer.invoke('app-window-list')
    setAppList(Array.isArray(result?.apps) ? result.apps : [])
    setAppWindows(Array.isArray(result?.windows) ? result.windows : [])
    setAppPickerVisible(true)
    setSelectedApp(null)
    onSetHudInteractive(true)
    ipcRenderer.send('set-ignore-mouse-events', false)
  }

  const closeAppPicker = () => {
    setAppPickerVisible(false)
    setSelectedApp(null)
    setAppCards([])
    setActiveAppCardId(null)
    ipcRenderer.invoke('app-cards-clear')
  }

  const handleAppSelect = (name: string) => {
    setSelectedApp(name)
  }

  const handleWindowCapture = async (win: { appName: string; title: string; id: string; x?: string; y?: string; w?: string; h?: string; displayIndex?: string; displayX?: string; displayY?: string; displayW?: string; displayH?: string }) => {
    ipcRenderer.send('cards-debug', {
      step: 'window-capture-click',
      appName: win.appName,
      title: win.title,
      id: win.id,
      x: win.x,
      y: win.y,
      w: win.w,
      h: win.h,
    })
    if (!win.id) {
      ipcRenderer.send('cards-debug', { step: 'window-capture-missing-id', title: win.title, appName: win.appName })
      return
    }
    const label = `${win.appName}: ${win.title || 'Untitled'}`
    const rect = win.x && win.y && win.w && win.h
      ? { x: Number(win.x), y: Number(win.y), w: Number(win.w), h: Number(win.h) }
      : undefined
    const display = win.displayIndex && win.displayX && win.displayY && win.displayW && win.displayH
      ? {
          index: Number(win.displayIndex),
          x: Number(win.displayX),
          y: Number(win.displayY),
          w: Number(win.displayW),
          h: Number(win.displayH),
        }
      : undefined
    const result = await ipcRenderer.invoke('window-capture-temp', { windowId: win.id, label, rect, display })
    if (result?.fileUrl) {
      const next = [{ id: result.id, fileUrl: result.fileUrl, filePath: result.filePath, label, appName: win.appName, bundleId: appList.find((app) => app.name === win.appName)?.bundleId, x: 0, y: 0 }, ...appCards]
      setAppCards(next)
      setActiveAppCardId(result.id)
    }
  }

  const handleAppCardToggle = (id: string) => {
    setActiveAppCardId((prev) => (prev === id ? null : id))
  }

  const handleAppCardDelete = async (card: AppProxyCard) => {
    setAppCards((prev) => prev.filter((item) => item.id !== card.id))
    if (activeAppCardId === card.id) {
      setActiveAppCardId(null)
    }
    await ipcRenderer.invoke('app-card-delete', { filePath: card.filePath })
  }

  const handleAppActivate = async (card: AppProxyCard) => {
    if (!card.bundleId) return
    await ipcRenderer.invoke('app-activate', { bundleId: card.bundleId })
    await ipcRenderer.invoke('app-move-to-hud', { bundleId: card.bundleId })
  }

  const handleAppCardDragStart = (id: string, event: React.PointerEvent) => {
    const card = appCards.find((item) => item.id === id)
    if (!card) return
    if (activeAppCardId === id) return
    setActiveAppCardId(id)
    setAppDragId(id)
    appDragOffsetRef.current = {
      x: event.clientX - card.x,
      y: event.clientY - card.y,
    }
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  const handleAppCardDragMove = (event: PointerEvent) => {
    if (!appDragId || !appDragOffsetRef.current) return
    const offset = appDragOffsetRef.current
    if (appDragFrameRef.current) return
    appDragFrameRef.current = window.requestAnimationFrame(() => {
      const next = appCards.map((card) =>
        card.id === appDragId
          ? {
              ...card,
              x: event.clientX - offset.x,
              y: event.clientY - offset.y,
            }
          : card,
      )
      setAppCards(next)
      appDragFrameRef.current = null
    })
  }

  const handleAppCardDragEnd = () => {
    if (!appDragId) return
    setAppDragId(null)
    appDragOffsetRef.current = null
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

  useEffect(() => {
  const load = async () => {
      const list = await ipcRenderer.invoke('cards-load')
      setCards(Array.isArray(list) ? normalizeCards(list) : [])
    }
    load()
  }, [ipcRenderer])

  const persistCards = async (next: ScreenshotCard[]) => {
    setCards(next)
    await ipcRenderer.invoke('cards-update', next)
  }

  const handleCardDelete = async (id: string) => {
    const next = await ipcRenderer.invoke('cards-delete', id)
    setCards(Array.isArray(next) ? normalizeCards(next) : [])
  }

  const handleCardToggleLock = async (id: string) => {
    const next: ScreenshotCard[] = cards.map((card) =>
      card.id === id ? { ...card, locked: !card.locked } : card,
    )
    await persistCards(next)
  }

  const handleCardToggleSize = async (id: string) => {
    const next: ScreenshotCard[] = cards.map((card) =>
      card.id === id
        ? {
            ...card,
            size: card.size === 'small' ? 'large' : 'small',
          }
        : card,
    )
    await persistCards(next)
  }

  const handleCardLabelUpdate = async (id: string, label: string) => {
    const next: ScreenshotCard[] = cards.map((card) => (card.id === id ? { ...card, label } : card))
    setEditingId(null)
    await persistCards(next)
  }

  const handleCardDragStart = (id: string, event: React.PointerEvent) => {
    const card = cards.find((item) => item.id === id)
    if (!card || card.locked) return
    setDragId(id)
    dragOffsetRef.current = {
      x: event.clientX - card.x,
      y: event.clientY - card.y,
    }
  }

  const handleCardDragMove = (event: PointerEvent) => {
    if (!dragId || !dragOffsetRef.current) return
    const offset = dragOffsetRef.current
    const next = cards.map((card) =>
      card.id === dragId
        ? {
            ...card,
            x: event.clientX - offset.x,
            y: event.clientY - offset.y,
          }
        : card,
    )
    setCards(next)
  }

  const handleCardDragEnd = async () => {
    if (!dragId) return
    const snap = 16
    const width = window.innerWidth
    const height = window.innerHeight
    const next = cards.map((card) => {
      if (card.id !== dragId) return card
      const sizeW = card.size === 'small' ? 180 : 420
      const sizeH = card.size === 'small' ? 120 : 280
      let x = card.x
      let y = card.y
      if (x < snap) x = 0
      if (y < snap) y = 0
      if (width - (x + sizeW) < snap) x = width - sizeW
      if (height - (y + sizeH) < snap) y = height - sizeH
      return { ...card, x, y }
    })
    setDragId(null)
    dragOffsetRef.current = null
    await persistCards(next)
  }

  useEffect(() => {
    window.addEventListener('pointermove', handleCardDragMove)
    window.addEventListener('pointerup', handleCardDragEnd)
    window.addEventListener('pointermove', handleAppCardDragMove)
    window.addEventListener('pointerup', handleAppCardDragEnd)
    return () => {
      window.removeEventListener('pointermove', handleCardDragMove)
      window.removeEventListener('pointerup', handleCardDragEnd)
      window.removeEventListener('pointermove', handleAppCardDragMove)
      window.removeEventListener('pointerup', handleAppCardDragEnd)
    }
  })

  const startCapture = () => {
    if (!hudInteractive) return
    setCaptureMode(true)
    setSelectRect(null)
  }

  const captureScreen = async (rect: { x: number; y: number; w: number; h: number }) => {
    try {
      ipcRenderer.send('cards-debug', { step: 'capture-start', rect })
      const label = new Date().toLocaleString()
      const absRect = {
        x: window.screenX + rect.x,
        y: window.screenY + rect.y,
        w: rect.w,
        h: rect.h,
      }
      const next = await ipcRenderer.invoke('cards-capture', { rect: absRect, label, width: 180, height: 120 })
      setCards(Array.isArray(next) ? normalizeCards(next) : [])
      ipcRenderer.send('cards-debug', { step: 'cards-saved', count: Array.isArray(next) ? next.length : 0 })
    } catch (error) {
      ipcRenderer.send('cards-debug', { step: 'capture-error', message: (error as Error).message })
    }
  }

  const handleCaptureMouseDown = (event: React.MouseEvent) => {
    const startX = event.clientX
    const startY = event.clientY
    setSelectRect({ x: startX, y: startY, w: 0, h: 0 })
  }

  const handleCaptureMouseMove = (event: React.MouseEvent) => {
    if (!selectRect) return
    const w = event.clientX - selectRect.x
    const h = event.clientY - selectRect.y
    setSelectRect({
      x: selectRect.x,
      y: selectRect.y,
      w,
      h,
    })
  }

  const handleCaptureMouseUp = async () => {
    if (!selectRect) {
      setCaptureMode(false)
      return
    }
    const rect = {
      x: Math.min(selectRect.x, selectRect.x + selectRect.w),
      y: Math.min(selectRect.y, selectRect.y + selectRect.h),
      w: Math.abs(selectRect.w),
      h: Math.abs(selectRect.h),
    }
    setCaptureMode(false)
    setSelectRect(null)
    if (rect.w < 10 || rect.h < 10) return
    await captureScreen(rect)
  }

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
          {panel.id === 'nav' && (
            <button className="hud-demo-button" type="button" onClick={startCapture}>
              SCREENSHOT
            </button>
          )}
          {panel.id === 'nav' && (
            <button className="hud-demo-button" type="button" onClick={openAppPicker}>
              APP SWITCH
            </button>
          )}
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

      {cards.map((card) => {
        const width = card.size === 'small' ? 180 : 420
        const height = card.size === 'small' ? 120 : 280
        const isDragging = dragId === card.id
        return (
          <div
            className={`hud-card ${card.locked ? 'is-locked' : ''} ${isDragging ? 'is-dragging' : ''}`}
            key={card.id}
            style={{ left: card.x, top: card.y, width, height }}
            onPointerDown={(event) => handleCardDragStart(card.id, event)}
          >
            <div className="hud-card-header">
              {editingId === card.id ? (
                <input
                  className="hud-card-input"
                  defaultValue={card.label || card.timestamp}
                  onBlur={(event) => handleCardLabelUpdate(card.id, event.target.value)}
                />
              ) : (
                <div
                  className="hud-card-label"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setEditingId(card.id)
                  }}
                >
                  {card.label || card.timestamp}
                </div>
              )}
              {card.locked && <div className="hud-card-lock">LOCKED</div>}
              <div className="hud-card-actions">
                <button className="hud-card-button" type="button" onClick={() => handleCardToggleLock(card.id)}>
                  {card.locked ? 'UNLOCK' : 'LOCK'}
                </button>
                <button className="hud-card-button" type="button" onClick={() => handleCardDelete(card.id)}>
                  DELETE
                </button>
              </div>
            </div>
            <img
              className="hud-card-image"
              src={card.fileUrl}
              alt="capture"
              onClick={() => handleCardToggleSize(card.id)}
            />
          </div>
        )
      })}

      {appPickerVisible && (
        <div className="hud-app-picker">
          <div className="hud-app-picker-header">
            <div className="hud-title">APP SWITCH</div>
            <button className="hud-app-close" type="button" onClick={closeAppPicker}>
              CLOSE
            </button>
          </div>
          <div className="hud-app-strip">
            {appList.length === 0 && <div className="hud-app-empty">No running apps</div>}
            {appList.map((app) => (
              <button
                className={`hud-app-card ${selectedApp === app.name ? 'is-active' : ''}`}
                key={app.bundleId}
                type="button"
                onClick={() => handleAppSelect(app.name)}
              >
                <div className="hud-app-icon">●</div>
                <div className="hud-app-name">{app.name}</div>
              </button>
            ))}
          </div>
          {appWindows.length > 0 && (
            <div className="hud-app-windows">
              {(selectedApp ? appWindows.filter((win) => win.appName === selectedApp) : appWindows)
                .slice(0, 8)
                .map((win, index) => (
                  <button
                    className="hud-app-window"
                    key={`${win.appName}-${win.title}-${win.id}-${index}`}
                    type="button"
                    onClick={() => handleWindowCapture(win)}
                  >
                    {win.appName}: {win.title || 'Untitled'}
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {appPickerVisible && appCards.length > 0 && (
        <div className="hud-app-stack">
          {appCards.slice(0, 5).map((card, index) => {
            const isActive = activeAppCardId === card.id
            const isDragging = appDragId === card.id
            return (
              <div
                className={`hud-app-proxy ${isActive ? 'is-active' : ''} ${isDragging ? 'is-dragging' : ''}`}
                key={card.id}
                style={{
                  ['--stack-x' as never]: `${index * 18}px`,
                  ['--stack-y' as never]: `${index * 6}px`,
                  ['--card-x' as never]: `${card.x}px`,
                  ['--card-y' as never]: `${card.y}px`,
                }}
              >
              <div
                className="hud-app-proxy-grab"
                onPointerDown={(event) => handleAppCardDragStart(card.id, event)}
                onClick={() => handleAppCardToggle(card.id)}
              >
                {card.appName}
              </div>
              {isActive && (
                <div className="hud-app-proxy-actions">
                  <button
                    className="hud-app-proxy-action"
                    type="button"
                    onClick={() => handleAppActivate(card)}
                  >
                    OPEN
                  </button>
                  <button
                    className="hud-app-proxy-action is-danger"
                    type="button"
                    onClick={() => handleAppCardDelete(card)}
                  >
                    DELETE
                  </button>
                </div>
              )}
              <button className="hud-app-proxy-body" type="button" onClick={() => handleAppCardToggle(card.id)}>
                <img src={card.fileUrl} alt={card.label} draggable={false} />
              </button>
              </div>
            )
          })}
        </div>
      )}

      {captureMode && (
        <div
          className="hud-capture-overlay"
          onMouseDown={handleCaptureMouseDown}
          onMouseMove={handleCaptureMouseMove}
          onMouseUp={handleCaptureMouseUp}
        >
          {selectRect && (
            <div
              className="hud-capture-rect"
              style={{
                left: Math.min(selectRect.x, selectRect.x + selectRect.w),
                top: Math.min(selectRect.y, selectRect.y + selectRect.h),
                width: Math.abs(selectRect.w),
                height: Math.abs(selectRect.h),
              }}
            />
          )}
        </div>
      )}

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
        <HudOverlay
          layoutConfig={layoutConfig}
          hudInteractive={hudInteractive}
          onToggleHud={() => setHudInteractive((prev) => !prev)}
          onSetHudInteractive={setHudInteractive}
        />
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
