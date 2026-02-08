import { app, BrowserWindow, screen, globalShortcut, ipcMain } from 'electron'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import crypto from 'node:crypto'
import WebSocket from 'ws'
import { pathToFileURL } from 'node:url'
import fsPromises from 'node:fs/promises'

// The built directory structure
//
// ├─┬ dist
// │ └── index.html
// ├─┬ dist-electron
// │ ├── main.js
// │ └── preload.js
//
process.env.DIST = path.join(__dirname, '../dist')
process.env.PUBLIC = app.isPackaged ? process.env.DIST : path.join(__dirname, '../public')

const DIST_DIR = process.env.DIST ?? path.join(__dirname, '../dist')
const PUBLIC_DIR = process.env.PUBLIC ?? path.join(__dirname, '../public')

let win: BrowserWindow | null
let controlWin: BrowserWindow | null
let hudDisplayId: number | null = null
let telemetryTimer: NodeJS.Timeout | null = null
let tmuxTimer: NodeJS.Timeout | null = null
let lastTmuxAlert: string | null = null

const defaultTmuxPath = fs.existsSync('/usr/local/bin/tmux') ? '/usr/local/bin/tmux' : 'tmux'

const tmuxConfig = {
  enabled: true,
  session: process.env.TMUX_SESSION || '',
  window: '0',
  pane: '0',
  pollMs: 1500,
  path: process.env.TMUX_PATH || defaultTmuxPath,
}

let tmuxTarget = {
  session: tmuxConfig.session,
  window: tmuxConfig.window,
  pane: tmuxConfig.pane,
}

let asrSocket: WebSocket | null = null
let asrTaskId: string | null = null
let asrLastText = ''
let asrReady = false
const asrAudioQueue: Buffer[] = []

const aliyunAccessKeyId = process.env.ALIYUN_ACCESS_KEY_ID || ''
const aliyunAccessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET || ''
const aliyunAppKey = process.env.ALIYUN_APP_KEY || ''
const aliyunToken = process.env.ALIYUN_NLS_TOKEN || ''
const aliyunTokenEndpoint =
  process.env.ALIYUN_NLS_TOKEN_URL || 'https://nls-meta.cn-shanghai.aliyuncs.com/'
const aliyunWsEndpoint =
  process.env.ALIYUN_NLS_WS_URL || 'wss://nls-gateway.cn-shanghai.aliyuncs.com/ws/v1'

const percentEncode = (value: string) =>
  encodeURIComponent(value)
    .replace(/\+/g, '%20')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~')

const signParams = (params: Record<string, string>, secret: string) => {
  const keys = Object.keys(params).sort()
  const query = keys.map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`).join('&')
  const stringToSign = `GET&%2F&${percentEncode(query)}`
  const signature = crypto.createHmac('sha1', `${secret}&`).update(stringToSign).digest('base64')
  return signature
}

const fetchAliyunToken = async () => {
  if (aliyunToken) return aliyunToken
  if (!aliyunAccessKeyId || !aliyunAccessKeySecret) return null

  const params: Record<string, string> = {
    AccessKeyId: aliyunAccessKeyId,
    Action: 'CreateToken',
    Format: 'JSON',
    RegionId: 'cn-shanghai',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: `${Date.now()}${Math.random().toString(16).slice(2)}`,
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString(),
    Version: '2019-02-28',
  }

  const signature = signParams(params, aliyunAccessKeySecret)
  params.Signature = signature

  const query = Object.keys(params)
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&')

  const url = `${aliyunTokenEndpoint}?${query}`
  const response = await fetch(url)
  const json = await response.json()
  return json?.Token?.Id || null
}

const startAsrSession = async (sampleRate: number) => {
  const token = await fetchAliyunToken()
  if (!token || !aliyunAppKey) {
    win?.webContents.send('asr-error', { message: 'Missing token or appKey' })
    return
  }

  asrTaskId = crypto.randomUUID().replace(/-/g, '')
  asrLastText = ''
  asrReady = false
  asrAudioQueue.length = 0
  const url = `${aliyunWsEndpoint}?token=${encodeURIComponent(token)}&appkey=${encodeURIComponent(aliyunAppKey)}`
  asrSocket = new WebSocket(url)

  asrSocket.on('open', () => {
    const start = {
      header: {
        appkey: aliyunAppKey,
        namespace: 'SpeechTranscriber',
        name: 'StartTranscription',
        task_id: asrTaskId,
        message_id: crypto.randomUUID().replace(/-/g, ''),
      },
      payload: {
        format: 'pcm',
        sample_rate: sampleRate,
        enable_intermediate_result: true,
        enable_punctuation_prediction: true,
        enable_inverse_text_normalization: true,
      },
    }
    asrSocket?.send(JSON.stringify(start))
  })

  asrSocket.on('message', (data: WebSocket.RawData) => {
    try {
      const text = data.toString()
      logLine('asr-message', { text })
      const message = JSON.parse(text)
      const name = message?.header?.name
      if (name === 'TranscriptionStarted') {
        asrReady = true
        while (asrAudioQueue.length > 0 && asrSocket?.readyState === WebSocket.OPEN) {
          const chunk = asrAudioQueue.shift()
          if (chunk) asrSocket.send(chunk)
        }
      }
      const result =
        message?.payload?.result ||
        message?.payload?.output?.text ||
        message?.payload?.text ||
        ''
      const isFinal =
        name === 'SentenceEnd' ||
        name === 'TranscriptionCompleted' ||
        message?.payload?.is_final === true ||
        message?.payload?.final === true ||
        message?.payload?.sentence_end === true
      if (typeof result === 'string' && result) {
        asrLastText = result
        win?.webContents.send('asr-result', { text: result, isFinal, name })
      }
    } catch {
      // ignore parse errors
    }
  })

  asrSocket.on('close', () => {
    win?.webContents.send('asr-result', { text: asrLastText, isFinal: true })
  })

  asrSocket.on('error', (error: Error) => {
    logLine('asr-error', { message: error.message })
    win?.webContents.send('asr-error', { message: error.message })
  })
}

const stopAsrSession = () => {
  if (!asrSocket || !asrTaskId) return
  const stop = {
    header: {
      appkey: aliyunAppKey,
      namespace: 'SpeechTranscriber',
      name: 'StopTranscription',
      task_id: asrTaskId,
      message_id: crypto.randomUUID().replace(/-/g, ''),
    },
    payload: {},
  }
  try {
    asrSocket.send(JSON.stringify(stop))
  } catch {
    // ignore
  }
  asrSocket.close()
  asrSocket = null
  asrTaskId = null
  asrReady = false
  asrAudioQueue.length = 0
}
const logPath = path.join(process.cwd(), 'logs', 'iron-term.log')

const execFileAsync = (command: string, args: string[] = []) =>
  new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })

const logLine = async (message: string, data?: Record<string, unknown>) => {
  const payload = data ? ` ${JSON.stringify(data)}` : ''
  const line = `[${new Date().toISOString()}] ${message}${payload}\n`
  try {
    await fsPromises.mkdir(path.dirname(logPath), { recursive: true })
    await fsPromises.appendFile(logPath, line, 'utf8')
  } catch {
    // ignore logging errors
  }
}

logLine('user-data-path', { path: app.getPath('userData') })

const cardsDir = path.join(app.getPath('userData'), 'cards')
const cardsJsonPath = path.join(cardsDir, 'cards.json')
const appCardsDir = path.join(app.getPath('userData'), 'app_cards')
const getHudDisplayBounds = () => {
  const displays = screen.getAllDisplays()
  const target = hudDisplayId ? displays.find((d) => d.id === hudDisplayId) : displays[0]
  return target?.bounds ?? displays[0]?.bounds ?? { x: 0, y: 0, width: 0, height: 0 }
}

type CardMeta = {
  id: string
  filePath: string
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

const loadCards = async (): Promise<CardMeta[]> => {
  try {
    const raw = await fsPromises.readFile(cardsJsonPath, 'utf8')
    return JSON.parse(raw) as CardMeta[]
  } catch {
    return []
  }
}

const saveCards = async (cards: CardMeta[]) => {
  await fsPromises.mkdir(cardsDir, { recursive: true })
  await fsPromises.writeFile(cardsJsonPath, JSON.stringify(cards, null, 2), 'utf8')
}

ipcMain.on('cards-debug', (_event, payload: Record<string, unknown>) => {
  logLine('cards-debug', payload)
})

const getCpuUsage = () => {
  const snapshot = os.cpus()
  const totals = snapshot.map((cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times
    const total = user + nice + sys + idle + irq
    return { idle, total }
  })

  return totals
}

let lastCpu = getCpuUsage()

const getCpuPercent = () => {
  const next = getCpuUsage()
  const deltas = next.map((cpu, index) => ({
    idle: cpu.idle - lastCpu[index].idle,
    total: cpu.total - lastCpu[index].total,
  }))
  lastCpu = next

  const idle = deltas.reduce((sum, cpu) => sum + cpu.idle, 0)
  const total = deltas.reduce((sum, cpu) => sum + cpu.total, 0)
  if (total === 0) return 0
  return Math.max(0, Math.min(100, Math.round(((total - idle) / total) * 100)))
}

const readTelemetry = () => {
  const cpu = getCpuPercent()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = Math.round(((totalMem - freeMem) / totalMem) * 100)
  const load = os.loadavg()[0]

  return {
    cpu,
    mem: usedMem,
    load: Number(load.toFixed(2)),
  }
}

const resolveTmuxSession = (): Promise<string | null> => {
  if (tmuxConfig.session) return Promise.resolve(tmuxConfig.session)

  return new Promise((resolve) => {
    execFile(
      tmuxConfig.path,
      ['list-sessions', '-F', '#S'],
      { env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' } },
      (error, stdout) => {
      if (error) {
        win?.webContents.send('tmux-debug', { message: `list-sessions error: ${error.message}` })
        resolve(null)
        return
      }
      const sessions = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      resolve(sessions[0] ?? null)
      },
    )
  })
}

const listTmuxSessions = (): Promise<string[]> => {
  return new Promise((resolve) => {
    execFile(
      tmuxConfig.path,
      ['list-sessions', '-F', '#S'],
      { env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' } },
      (error, stdout) => {
        if (error) {
          win?.webContents.send('tmux-debug', { message: `list-sessions error: ${error.message}` })
          resolve([])
          return
        }
        const sessions = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(sessions)
      },
    )
  })
}

const listTmuxWindows = (session: string): Promise<string[]> => {
  return new Promise((resolve) => {
    execFile(
      tmuxConfig.path,
      ['list-windows', '-t', session, '-F', '#I'],
      { env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' } },
      (error, stdout) => {
        if (error) {
          win?.webContents.send('tmux-debug', { message: `list-windows error: ${error.message}` })
          resolve([])
          return
        }
        const windows = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(windows)
      },
    )
  })
}

const listTmuxPanes = (session: string, window: string): Promise<string[]> => {
  const target = `${session}:${window}`
  return new Promise((resolve) => {
    execFile(
      tmuxConfig.path,
      ['list-panes', '-t', target, '-F', '#P'],
      { env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' } },
      (error, stdout) => {
        if (error) {
          win?.webContents.send('tmux-debug', { message: `list-panes error: ${error.message}` })
          resolve([])
          return
        }
        const panes = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
        resolve(panes)
      },
    )
  })
}

const pollTmux = async () => {
  if (!tmuxConfig.enabled) return
  win?.webContents.send('tmux-debug', { message: `polling via ${tmuxConfig.path}` })
  const session = await resolveTmuxSession()
  if (!session || !win) {
    win?.webContents.send('tmux-status', { status: 'offline' })
    if (!session) {
      win?.webContents.send('tmux-debug', { message: 'no sessions found' })
    }
    return
  }

  const targetSession = tmuxTarget.session || session
  const targetWindow = tmuxTarget.window || tmuxConfig.window
  const targetPane = tmuxTarget.pane || tmuxConfig.pane
  const target = `${targetSession}:${targetWindow}.${targetPane}`
  execFile(
    tmuxConfig.path,
    ['capture-pane', '-pt', target, '-S', '-120'],
    { env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' } },
    (error, stdout) => {
    if (error) {
      win?.webContents.send('tmux-status', { status: 'error', session })
      win?.webContents.send('tmux-debug', { message: `capture-pane error: ${error.message}` })
      return
    }

    win?.webContents.send('tmux-status', { status: 'monitoring', session })

    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-120)

    win?.webContents.send('tmux-stream', { lines })

    const hit = lines.findLast((line) => line.includes('ERROR') || line.includes('WARN'))
    if (hit && hit !== lastTmuxAlert) {
      lastTmuxAlert = hit
      win?.webContents.send('tmux-alert', { message: hit, session })
    }
  },
  )
}

const fetchTmuxLogs = async (lines = 200) => {
  const session = await resolveTmuxSession()
  if (!session) return { ok: false, message: 'no sessions found' }

  const target = `${session}:${tmuxConfig.window}.${tmuxConfig.pane}`

  return new Promise<{ ok: boolean; message?: string; logs?: string[] }>((resolve) => {
    execFile(
      tmuxConfig.path,
      ['capture-pane', '-pt', target, '-S', `-${lines}`],
      { env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' } },
      (error, stdout) => {
        if (error) {
          resolve({ ok: false, message: error.message })
          return
        }
        const logs = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(-lines)
        resolve({ ok: true, logs })
      },
    )
  })
}

const checkTmux = async () => {
  if (!tmuxConfig.enabled) {
    return { status: 'offline', message: 'tmux disabled' }
  }

  const session = await resolveTmuxSession()
  if (!session) {
    return { status: 'offline', message: 'no sessions found' }
  }

  return { status: 'monitoring', message: `monitoring ${session}`, session }
}
// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']

function getTargetDisplay() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const displays = screen.getAllDisplays()
  const targetName = (process.env.HUD_DISPLAY_NAME || 'DP').toLowerCase()

  const named = displays.find((display) => {
    const label = ((display as { label?: string }).label || '').toLowerCase()
    return label.includes(targetName)
  })

  if (named) return named

  const externalDisplays = displays.filter((d) => d.id !== primaryDisplay.id)
  return externalDisplays[0] ?? primaryDisplay
}

function createWindow() {
  const targetDisplay = getTargetDisplay()
  hudDisplayId = targetDisplay.id
  const { x, y, width, height } = targetDisplay.workArea

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    icon: path.join(PUBLIC_DIR, 'electron-vite.svg'),
    frame: false,           // No title bar or borders
    transparent: true,      // Enable transparency
    hasShadow: false,       // No macOS window shadow
    alwaysOnTop: true,      // Keep above other windows
    // 'screen-saver' level is higher than 'floating' and 'main-menu' on macOS
    type: 'panel',
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true, // Enabling for rapid prototyping
      contextIsolation: false,
    },
  })

  const preloadPath = path.join(__dirname, 'preload.js')
  logLine('preload-path', { path: preloadPath, exists: fs.existsSync(preloadPath) })

  win.on('closed', () => {
    logLine('main-window-closed')
  })
  win.on('hide', () => {
    logLine('main-window-hidden')
  })
  win.on('show', () => {
    logLine('main-window-shown')
  })
  win.on('unresponsive', () => {
    logLine('main-window-unresponsive')
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    logLine('render-process-gone', details as unknown as Record<string, unknown>)
  })
  win.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    logLine('did-fail-load', { code, description, url: validatedURL })
  })

  // Set fully transparent background
  win.setBackgroundColor('#00000000')

  // CRITICAL: Ignore mouse events to allow clicking through to macOS
  // forward: true allows the click to pass to the window behind
  win.setIgnoreMouseEvents(true, { forward: true })

  // Listen for renderer asking to capture mouse (e.g. over a button)
  ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    win?.setIgnoreMouseEvents(ignore, { forward: true })
  })

  ipcMain.on('hud-toggle', () => {
    win?.webContents.send('hud-toggle-request')
  })

  ipcMain.on('preload-ready', (_event, payload: Record<string, unknown>) => {
    logLine('preload-ready', payload)
  })

  ipcMain.on('tmux-send', (_event, payload: { keys: string[]; special?: string }) => {
    const { keys, special } = payload
    resolveTmuxSession().then((session) => {
      if (!session) return
      const targetSession = tmuxTarget.session || session
      const targetWindow = tmuxTarget.window || tmuxConfig.window
      const targetPane = tmuxTarget.pane || tmuxConfig.pane
      const target = `${targetSession}:${targetWindow}.${targetPane}`
      if (special) {
        execFile(tmuxConfig.path, ['send-keys', '-t', target, special], {
          env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' },
        })
        return
      }
      if (keys.length > 0) {
        execFile(tmuxConfig.path, ['send-keys', '-t', target, ...keys], {
          env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin' },
        })
      }
    })
  })

  ipcMain.handle('tmux-check', async () => {
    return checkTmux()
  })

  ipcMain.handle('tmux-list-sessions', async () => {
    return listTmuxSessions()
  })

  ipcMain.handle('tmux-list-windows', async (_event, session: string) => {
    return listTmuxWindows(session)
  })

  ipcMain.handle('tmux-list-panes', async (_event, session: string, window: string) => {
    return listTmuxPanes(session, window)
  })

  ipcMain.on('tmux-set-target', (_event, target: { session: string; window: string; pane: string }) => {
    tmuxTarget = {
      session: target.session,
      window: target.window,
      pane: target.pane,
    }
  })

  ipcMain.handle('tmux-logs', async (_event, lines: number) => {
    return fetchTmuxLogs(lines)
  })

  ipcMain.handle('display-info', async (_event, point: { x: number; y: number }) => {
    try {
      const target = screen.getDisplayNearestPoint({ x: point.x, y: point.y })
      return {
        id: target.id,
        bounds: target.bounds,
        size: target.size,
        scaleFactor: target.scaleFactor,
      }
    } catch (error) {
      logLine('display-info-error', { message: (error as Error).message })
      return null
    }
  })

  ipcMain.handle('cards-load', async () => {
    return loadCards()
  })

  ipcMain.handle('cards-save', async (_event, payload: { dataUrl: string; label: string; width: number; height: number }) => {
    const { dataUrl, label, width, height } = payload
    logLine('cards-save-start', { size: dataUrl?.length ?? 0, label, width, height })
    const id = crypto.randomUUID().replace(/-/g, '')
    const timestamp = new Date().toISOString()
    const filePath = path.join(cardsDir, `${timestamp.replace(/[:.]/g, '-')}-${id}.png`)
    const base64 = dataUrl.split(',')[1] || ''
    const buffer = Buffer.from(base64, 'base64')

    await fsPromises.mkdir(cardsDir, { recursive: true })
    await fsPromises.writeFile(filePath, buffer)

    const fileUrl = pathToFileURL(filePath).toString()
    const card: CardMeta = {
      id,
      filePath,
      fileUrl,
      timestamp,
      label,
      x: 80,
      y: 120,
      width,
      height,
      locked: false,
      size: 'small',
    }

    const cards = await loadCards()
    const next = [card, ...cards].slice(0, 20)
    await saveCards(next)
    logLine('cards-save-ok', { filePath, count: next.length })
    return next
  })

  ipcMain.handle('cards-capture', async (_event, payload: { rect: { x: number; y: number; w: number; h: number }; label: string; width: number; height: number }) => {
    const { rect, label, width, height } = payload
    const id = crypto.randomUUID().replace(/-/g, '')
    const timestamp = new Date().toISOString()
    const filePath = path.join(cardsDir, `${timestamp.replace(/[:.]/g, '-')}-${id}.png`)
    await fsPromises.mkdir(cardsDir, { recursive: true })
    const x = Math.round(rect.x)
    const y = Math.round(rect.y)
    const w = Math.round(rect.w)
    const h = Math.round(rect.h)
    logLine('cards-capture-start', { x, y, w, h })
    await new Promise<void>((resolve, reject) => {
      execFile('screencapture', ['-x', '-R', `${x},${y},${w},${h}`, filePath], (error) => {
        if (error) {
          logLine('cards-capture-error', { message: error.message })
          reject(error)
          return
        }
        resolve()
      })
    })
    const fileUrl = pathToFileURL(filePath).toString()
    const card: CardMeta = {
      id,
      filePath,
      fileUrl,
      timestamp,
      label,
      x: 80,
      y: 120,
      width,
      height,
      locked: false,
      size: 'small',
    }
    const cards = await loadCards()
    const next = [card, ...cards].slice(0, 20)
    await saveCards(next)
    logLine('cards-capture-ok', { filePath, count: next.length })
    return next
  })

  ipcMain.handle('window-capture', async (_event, payload: { windowId: string; label: string; width: number; height: number; rect?: { x: number; y: number; w: number; h: number }; display?: { index: number; x: number; y: number; w: number; h: number } }) => {
    const { windowId, label, width, height, rect, display } = payload
    const id = crypto.randomUUID().replace(/-/g, '')
    const timestamp = new Date().toISOString()
    const filePath = path.join(cardsDir, `${timestamp.replace(/[:.]/g, '-')}-${id}.png`)
    await fsPromises.mkdir(cardsDir, { recursive: true })
    logLine('window-capture-request', { windowId, label, rect })
    logLine('window-capture-start', { windowId, label })
    const captureWithId = () =>
      new Promise<void>((resolve, reject) => {
        execFile('screencapture', ['-x', '-l', String(windowId), filePath], (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    const captureWithRect = () =>
      new Promise<void>((resolve, reject) => {
        if (!rect) {
          reject(new Error('missing rect'))
          return
        }
        let { x, y, w, h } = rect
        const args = ['-x']
        if (display) {
          const localX = x - display.x
          const localY = y - display.y
          const localTopY = display.h - localY - h
          x = localX
          y = localTopY
          args.push('-D', String(display.index))
        }
        args.push('-R', `${x},${y},${w},${h}`, filePath)
        execFile('screencapture', args, (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    try {
      await captureWithId()
    } catch (error) {
      logLine('window-capture-id-failed', { message: (error as Error).message, windowId })
      try {
        await captureWithRect()
      } catch (rectError) {
        logLine('window-capture-error', { message: (rectError as Error).message, windowId })
        throw rectError
      }
    }
    const fileUrl = pathToFileURL(filePath).toString()
    const card: CardMeta = {
      id,
      filePath,
      fileUrl,
      timestamp,
      label,
      x: 120,
      y: 140,
      width,
      height,
      locked: false,
      size: 'small',
    }
    const cards = await loadCards()
    const next = [card, ...cards].slice(0, 20)
    await saveCards(next)
    logLine('window-capture-ok', { filePath, count: next.length })
    return next
  })

  ipcMain.handle('window-capture-temp', async (_event, payload: { windowId: string; label: string; rect?: { x: number; y: number; w: number; h: number }; display?: { index: number; x: number; y: number; w: number; h: number } }) => {
    const { windowId, label, rect, display } = payload
    const id = crypto.randomUUID().replace(/-/g, '')
    const timestamp = new Date().toISOString()
    const filePath = path.join(appCardsDir, `${timestamp.replace(/[:.]/g, '-')}-${id}.png`)
    await fsPromises.mkdir(appCardsDir, { recursive: true })
    logLine('window-capture-temp-start', { windowId, label })
    const captureWithId = () =>
      new Promise<void>((resolve, reject) => {
        execFile('screencapture', ['-x', '-l', String(windowId), filePath], (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    const captureWithRect = () =>
      new Promise<void>((resolve, reject) => {
        if (!rect) {
          reject(new Error('missing rect'))
          return
        }
        let { x, y, w, h } = rect
        const args = ['-x']
        if (display) {
          const localX = x - display.x
          const localY = y - display.y
          const localTopY = display.h - localY - h
          x = localX
          y = localTopY
          args.push('-D', String(display.index))
        }
        args.push('-R', `${x},${y},${w},${h}`, filePath)
        execFile('screencapture', args, (error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    try {
      await captureWithId()
    } catch (error) {
      logLine('window-capture-temp-id-failed', { message: (error as Error).message, windowId })
      await captureWithRect()
    }
    const fileUrl = pathToFileURL(filePath).toString()
    logLine('window-capture-temp-ok', { filePath })
    return { id, fileUrl, filePath, label }
  })

  ipcMain.handle('app-cards-clear', async () => {
    try {
      const files = await fsPromises.readdir(appCardsDir)
      await Promise.all(
        files.map((file) => fsPromises.unlink(path.join(appCardsDir, file)).catch(() => undefined)),
      )
    } catch {
      // ignore
    }
    return true
  })

  ipcMain.handle('app-card-delete', async (_event, payload: { filePath?: string }) => {
    if (payload?.filePath) {
      try {
        await fsPromises.unlink(payload.filePath)
      } catch {
        // ignore
      }
    }
    return true
  })

  ipcMain.handle('app-activate', async (_event, payload: { bundleId: string }) => {
    try {
      const scriptPath = path.join(process.cwd(), 'scripts', 'window_list.swift')
      await execFileAsync('swift', [scriptPath, 'activate', payload.bundleId])
      return true
    } catch (error) {
      logLine('app-activate-error', { message: (error as Error).message })
      return false
    }
  })

  ipcMain.handle('app-move-to-hud', async (_event, payload: { bundleId: string }) => {
    try {
      const scriptPath = path.join(process.cwd(), 'scripts', 'window_list.swift')
      const bounds = getHudDisplayBounds()
      await execFileAsync('swift', [
        scriptPath,
        'move',
        payload.bundleId,
        String(bounds.x),
        String(bounds.y),
        String(bounds.width),
        String(bounds.height),
      ])
      return true
    } catch (error) {
      logLine('app-move-error', { message: (error as Error).message })
      return false
    }
  })

  ipcMain.handle('app-window-list', async () => {
    try {
      const scriptPath = path.join(process.cwd(), 'scripts', 'window_list.swift')
      const result = await execFileAsync('swift', [scriptPath])
      logLine('app-window-list-raw', { sample: result.stdout.slice(0, 800) })
      const parsed = JSON.parse(result.stdout) as {
        apps?: Array<{ name: string; bundleId: string }>
        windows?: Array<{ appName: string; title: string; id: string | number; x?: string; y?: string; w?: string; h?: string; displayIndex?: string; displayX?: string; displayY?: string; displayW?: string; displayH?: string }>
      }
      const apps = Array.isArray(parsed.apps) ? parsed.apps : []
      const windows = Array.isArray(parsed.windows)
        ? parsed.windows
            .map((win) => ({
              appName: win.appName,
              title: win.title,
              id: typeof win.id === 'number' ? String(win.id) : win.id,
              x: win.x ?? '',
              y: win.y ?? '',
              w: win.w ?? '',
              h: win.h ?? '',
              displayIndex: win.displayIndex ?? '',
              displayX: win.displayX ?? '',
              displayY: win.displayY ?? '',
              displayW: win.displayW ?? '',
              displayH: win.displayH ?? '',
            }))
            .filter((win) => win.appName && win.id)
        : []
      logLine('app-window-list-summary', {
        apps: apps.length,
        windows: windows.length,
        windowSample: windows.slice(0, 5),
      })
      return { apps, windows }
    } catch (error) {
      logLine('app-window-list-error', { message: (error as Error).message })
      return { apps: [], windows: [] }
    }
  })

  ipcMain.handle('cards-update', async (_event, cards: CardMeta[]) => {
    await saveCards(cards)
    return true
  })

  ipcMain.handle('cards-delete', async (_event, id: string) => {
    const cards = await loadCards()
    const target = cards.find((card) => card.id === id)
    if (target) {
      try {
        await fsPromises.unlink(target.filePath)
      } catch {
        // ignore missing file
      }
    }
    const next = cards.filter((card) => card.id !== id)
    await saveCards(next)
    return next
  })

  ipcMain.handle('asr-start', async (_event, sampleRate: number) => {
    await startAsrSession(sampleRate)
  })

  ipcMain.on('asr-audio', (_event, audio: ArrayBuffer) => {
    const chunk = Buffer.from(audio)
    if (asrSocket && asrSocket.readyState === WebSocket.OPEN && asrReady) {
      asrSocket.send(chunk)
      return
    }
    asrAudioQueue.push(chunk)
  })

  ipcMain.on('asr-stop', () => {
    stopAsrSession()
  })

  ipcMain.handle('get-telemetry', () => {
    return readTelemetry()
  })

  // Keep on top of all windows (especially for HUD use)
  win.setAlwaysOnTop(true, 'screen-saver')

  // Test loading
  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    win.loadFile(path.join(DIST_DIR, 'index.html'))
  }

  win.webContents.once('did-finish-load', () => {
    win?.webContents.send('tmux-debug', { message: `tmux init via ${tmuxConfig.path}` })
    logLine('did-finish-load')
  })



  if (telemetryTimer) {
    clearInterval(telemetryTimer)
  }

  telemetryTimer = setInterval(() => {
    win?.webContents.send('system-telemetry', readTelemetry())
  }, 1000)

  if (tmuxTimer) {
    clearInterval(tmuxTimer)
  }

  tmuxTimer = setInterval(() => {
    pollTmux()
  }, tmuxConfig.pollMs)
  pollTmux()
}

function createControlWindow() {
  const targetDisplay =
    (hudDisplayId && screen.getAllDisplays().find((display) => display.id === hudDisplayId)) ||
    (win ? screen.getDisplayMatching(win.getBounds()) : getTargetDisplay())
  const { x, y, width, height } = targetDisplay.bounds

  controlWin = new BrowserWindow({
    width: 140,
    height: 36,
    x: Math.round(x + width / 2 - 70),
    y: Math.round(y + height - 80),
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="UTF-8" />
        <style>
          html, body { margin: 0; background: transparent; }
          button {
            width: 140px;
            height: 36px;
            border-radius: 6px;
            border: 1px solid rgba(0, 255, 122, 0.6);
            background: rgba(0,0,0,0.25);
            color: #00ff7a;
            font-family: "SF Mono", "Menlo", "Monaco", "Courier New", monospace;
            font-size: 11px;
            letter-spacing: 1px;
            cursor: pointer;
            box-shadow: 0 0 8px rgba(0, 255, 122, 0.3);
          }
        </style>
      </head>
      <body>
        <button id="toggle">TOGGLE HUD</button>
        <script>
          const { ipcRenderer } = require('electron')
          document.getElementById('toggle').addEventListener('click', () => {
            ipcRenderer.send('hud-toggle')
          })
        </script>
      </body>
    </html>
  `

  controlWin.setAlwaysOnTop(true, 'screen-saver')
  controlWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  controlWin.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
  controlWin.once('ready-to-show', () => {
    const posX = Math.round(x + width / 2 - 70)
    const posY = Math.round(y + height - 80)
    controlWin?.setPosition(posX, posY, false)
    controlWin?.showInactive()
  })
  console.log('[controlWin]', {
    display: targetDisplay.id,
    bounds: targetDisplay.bounds,
    window: controlWin.getBounds(),
  })
}

app.on('window-all-closed', () => {
  if (telemetryTimer) {
    clearInterval(telemetryTimer)
    telemetryTimer = null
  }
  if (tmuxTimer) {
    clearInterval(tmuxTimer)
    tmuxTimer = null
  }
  globalShortcut.unregisterAll()
  controlWin = null
  win = null
})

app.whenReady().then(() => {
  createWindow()
  createControlWindow()

  // Register a shortcut to quit since we have no window controls
  globalShortcut.register('Command+Control+Q', () => {
    console.log('Quitting Iron-Term...')
    app.quit()
  })

  // Global voice toggle (fallback when HUD doesn't have focus)
  globalShortcut.register('Option+V', () => {
    win?.webContents.send('voice-toggle-request')
  })

  // Global preset shortcuts so they still work in pass-through mode
  globalShortcut.register('Option+1', () => {
    win?.webContents.send('preset-change', 'daily')
  })
  globalShortcut.register('Option+2', () => {
    win?.webContents.send('preset-change', 'entertainment')
  })
  globalShortcut.register('Option+3', () => {
    win?.webContents.send('preset-change', 'coding')
  })

})
