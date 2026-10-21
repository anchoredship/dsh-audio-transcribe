/**
 * System-audio recording bridge for the web/desktop UI.
 *
 * The browser cannot capture what the machine is playing, so recording runs on
 * the host: this module spawns the bundled LoopbackCap.exe, tracks the child
 * process, and exposes helpers the HTTP layer and client half use.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

/** Directory holding LoopbackCap.exe and its NAudio dependencies. */
export function binDir(packageRoot) {
  return path.join(packageRoot, 'bin')
}

/**
 * Create the recorder controller bound to one apply() lifetime.
 * @param options.packageRoot - absolute package directory (holds bin/).
 * @param options.getRecordDir - async () => the current storage directory.
 * @param options.getPerRecordingFolder - async () => whether to group each
 *   recording into its own timestamped subfolder.
 * @param options.onFinished - called with the finished recording descriptor.
 * @param options.logger - cordis logger.
 */
export function createRecorder(options) {
  const { packageRoot, getRecordDir, getPerRecordingFolder, onFinished, logger } = options
  const exe = path.join(binDir(packageRoot), 'LoopbackCap.exe')

  /** @type {null | { child: any, file: string, startedAt: number, log: string }} */
  let active = null
  let last = null

  function available() {
    return existsSync(exe)
  }

  async function status() {
    if (!active) {
      return { available: available(), running: false, file: null, seconds: 0, bytes: 0, last }
    }
    let bytes = 0
    try {
      bytes = (await fs.stat(active.file)).size
    } catch {
      /* file not flushed yet */
    }
    return {
      available: true,
      running: true,
      file: active.file,
      seconds: Math.round((Date.now() - active.startedAt) / 100) / 10,
      bytes,
      last,
    }
  }

  /**
   * Start capturing the default output device.
   * @param maxSeconds - hard stop so an abandoned recording cannot grow forever.
   */
  async function start(maxSeconds = 3600) {
    if (active) throw new Error('a recording is already running')
    if (!available()) throw new Error(`recorder binary not found at ${exe}`)

    const root = await getRecordDir()
    const perFolder = await getPerRecordingFolder()

    // Two timestamp formats on purpose:
    //   folder 2026-10-19_13-02-11/  — readable and sortable as a directory
    //   file   system-audio.wav      — the folder already carries the time
    // When grouping is off the timestamp moves into the filename instead, so
    // recordings in one flat directory still do not collide.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_')
    const dir = perFolder ? path.join(root, stamp) : root
    const file = path.join(dir, perFolder ? 'system-audio.wav' : `system-audio-${stamp}.wav`)
    await fs.mkdir(dir, { recursive: true })

    const child = spawn(exe, [binDir(packageRoot), file, String(maxSeconds)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const state = { child, file, startedAt: Date.now(), log: '' }
    active = state

    const collect = (buf) => {
      state.log = (state.log + buf.toString()).slice(-4000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    child.on('exit', async (code) => {
      let bytes = 0
      try {
        bytes = (await fs.stat(file)).size
      } catch {
        /* nothing recorded */
      }
      // Exit codes come from LoopbackCap: 0 ok, 3 no data, 4 captured but silent.
      // A silent take is a legitimate WAV, not a failure — surface it as its own
      // state so the UI can say "nothing was playing" instead of "broken file".
      const silent = code === 3 || code === 4
      last = {
        file,
        name: path.basename(file),
        bytes,
        durationMs: Date.now() - state.startedAt,
        at: new Date().toISOString(),
        exitCode: code,
        ok: bytes > 1024 && !silent,
        silent,
        log: state.log.trim().slice(-400),
      }
      if (active === state) active = null
      logger?.info?.(`[audio-transcribe] recording finished: ${file} (${bytes} bytes, exit ${code})`)
      try {
        onFinished?.(last)
      } catch (err) {
        logger?.warn?.(`[audio-transcribe] onFinished failed: ${err?.message ?? err}`)
      }
    })

    // Let an immediate failure (no device, sandbox denial) surface here.
    await new Promise((r) => setTimeout(r, 400))
    if (active !== state) {
      const reason = state.log.trim().split('\n').filter(Boolean).pop() || `exit code ${last?.exitCode}`
      throw new Error(`recorder failed to start: ${reason}`)
    }
    return { file }
  }

  /** Stop capturing gracefully so the child flushes a valid WAV header. */
  async function stop() {
    if (!active) return { stopped: false, last }
    const state = active

    // The recorder polls for <file>.stop and then finalises the WAV itself.
    // Killing it instead would leave a file with an unwritten header, which
    // reads as 0 seconds to every decoder.
    const stopFile = `${state.file}.stop`
    try {
      await fs.writeFile(stopFile, 'stop')
    } catch (error) {
      logger?.warn?.(`[audio-transcribe] could not signal stop: ${error?.message ?? error}`)
    }

    // Wait for the child to finalise the WAV and exit. `once('exit')` settles
    // the promise; the timeout is the escape hatch for a hung process.
    const STOP_TIMEOUT_MS = 8000
    const exited = await new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => done(false), STOP_TIMEOUT_MS)
      state.child.once('exit', () => done(true))
    })

    if (!exited) {
      // Only fall back to a hard kill if the child ignored the signal.
      logger?.warn?.('[audio-transcribe] recorder did not stop in time; killing it')
      try {
        state.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      // Let the SIGKILL land so the exit handler can publish `last`.
      await new Promise((r) => setTimeout(r, 300))
    }

    await fs.rm(stopFile, { force: true }).catch(() => {})
    // Give the exit handler a beat to publish `last`.
    await new Promise((r) => setTimeout(r, 250))
    return { stopped: true, last }
  }

  return { available, status, start, stop }
}

/** Describe one WAV plus its transcript, or null when it vanished. */
/**
 * Whether a WAV file holds nothing but silence.
 *
 * Only the first 64 KiB is sampled: a silent capture is zero-filled throughout,
 * so a sample is enough to label it, and reading the whole file for every row
 * would make listing slow once a directory fills up.
 */
async function isSilentWav(file, size) {
  // A 44-byte header with no frames at all counts as silent too.
  if (size <= 64) return true
  let handle
  try {
    handle = await fs.open(file, 'r')
    const length = Math.min(65536, size - 44)
    if (length <= 0) return true
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, 44)
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 0) return false
    }
    return true
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function describeRecording(dir, name, group) {
  const full = path.join(dir, name)
  try {
    const st = await fs.stat(full)
    const txtPath = full.replace(/\.wav$/i, '.txt')
    let transcript = null
    try {
      await fs.access(txtPath)
      transcript = txtPath
    } catch {
      /* no transcript yet */
    }
    // In grouped mode every file is called system-audio.wav, so the folder name
    // is what distinguishes one recording from another.
    return {
      name: group ? `${group}/${name}` : name,
      path: full,
      folder: group ?? null,
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      transcript,
      silent: await isSilentWav(full, st.size),
    }
  } catch {
    return null
  }
}

/**
 * List recordings, newest first.
 *
 * Reads both layouts so a directory that already holds flat recordings keeps
 * showing them after grouping is introduced:
 *   flat     <dir>/system-audio-<stamp>.wav
 *   grouped  <dir>/<stamp>/system-audio.wav
 */
export async function listRecordings(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }

  for (const e of entries) {
    if (e.isDirectory()) {
      let inner
      try {
        inner = await fs.readdir(path.join(dir, e.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const f of inner) {
        if (!f.isFile() || !/\.wav$/i.test(f.name)) continue
        const item = await describeRecording(path.join(dir, e.name), f.name, e.name)
        if (item) out.push(item)
      }
      continue
    }
    if (!e.isFile() || !/\.wav$/i.test(e.name)) continue
    const item = await describeRecording(dir, e.name, null)
    if (item) out.push(item)
  }

  out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))
  return out.slice(0, 30)
}

/** Ensure an absolute directory exists and is writable. */
export async function ensureWritableDir(dir) {
  if (!path.isAbsolute(dir)) throw new Error('directory must be an absolute path')
  await fs.mkdir(dir, { recursive: true })
  const probe = path.join(dir, `.write-probe-${process.pid}`)
  await fs.writeFile(probe, 'ok')
  await fs.rm(probe, { force: true })
  return true
}
