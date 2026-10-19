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
 * @param options.getRecordDir - returns the current storage directory.
 * @param options.onFinished - called with the finished recording descriptor.
 * @param options.logger - cordis logger.
 */
export function createRecorder(options) {
  const { packageRoot, getRecordDir, onFinished, logger } = options
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

    const dir = getRecordDir()
    await fs.mkdir(dir, { recursive: true })

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '_')
    const file = path.join(dir, `system-audio-${stamp}.wav`)

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
      last = {
        file,
        name: path.basename(file),
        bytes,
        durationMs: Date.now() - state.startedAt,
        at: new Date().toISOString(),
        exitCode: code,
        ok: bytes > 1024,
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

    const exited = await new Promise((resolve) => {
      let settled = false
      const done = (value) => {
        if (!settled) {
          settled = true
          resolve(value)
        }
      }
      state.child.once('exit', () => done(true))
      const deadline = setTimeout(() => done(false), 8000)
      state.child.once('exit', () => clearTimeout(deadline))
    })

    if (!exited) {
      // Only fall back to a hard kill if the child ignored the signal.
      logger?.warn?.('[audio-transcribe] recorder did not stop in time; killing it')
      try {
        state.child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      await new Promise((r) => setTimeout(r, 300))
    }

    await fs.rm(stopFile, { force: true }).catch(() => {})
    // Give the exit handler a beat to publish `last`.
    await new Promise((r) => setTimeout(r, 250))
    return { stopped: true, last }
  }

  return { available, status, start, stop }
}

/** List recorded WAV files in a directory, newest first. */
export async function listRecordings(dir) {
  const out = []
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isFile() || !/\.wav$/i.test(e.name)) continue
    const full = path.join(dir, e.name)
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
      out.push({
        name: e.name,
        path: full,
        bytes: st.size,
        mtime: st.mtime.toISOString(),
        transcript,
      })
    } catch {
      /* race with deletion */
    }
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
