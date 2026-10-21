/**
 * Host-side HTTP surface for the recording widget.
 *
 * The client half (assets/audio-ui.js) is a thin remote control: every real
 * action — spawning the capture process, moving the storage directory,
 * transcribing the result — happens here.
 */
import fs from 'node:fs/promises'
import path from 'node:path'

import { createRecorder, listRecordings, ensureWritableDir } from './recorder.js'

/** Mount prefix for every route this module owns. */
export const ROUTE_PREFIX = '/dsh-audio'

const SETTINGS_NS = 'audio-transcribe'
const DEFAULT_RECORD_DIR = (dshHome) => path.join(dshHome, 'audio-transcribe', 'recordings')

/**
 * Whether a Host header names this machine.
 *
 * The host binds loopback by default, but a rebound DNS name or a forged Host
 * still arrives as a normal HTTP request. Only `localhost`, `::1` and `127/8`
 * are accepted; anything else is a browser talking to us from a page it did not
 * load from here.
 */
function isLoopbackHost(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false
  // Strip the port, keeping IPv6 literals intact.
  let host = hostHeader.trim().toLowerCase()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host)
  if (bracketed) host = bracketed[1]
  else if (!host.includes(':') || host.split(':').length === 2) host = host.split(':')[0]

  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1') return true
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  return m.slice(1).every((part) => Number(part) <= 255)
}

/**
 * Reject requests that did not come from a page served by this host.
 *
 * These routes can start a recording and read the storage directory, so a
 * cross-site request must never reach them: without this, any page the user
 * visits could begin recording or enumerate their recordings.
 *
 * @returns null when the request is acceptable, otherwise an HTTP status code.
 */
function trustRejection(req) {
  const headers = req.headers ?? {}

  // A browser cannot forge these; a rebound DNS name cannot fix them.
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site && site !== 'same-origin' && site !== 'none') return 403

  if (!isLoopbackHost(headers.host)) return 403

  // When an Origin is present it must be the same origin.
  const origin = headers.origin
  if (origin) {
    try {
      const url = new URL(String(origin))
      if (!isLoopbackHost(url.host)) return 403
      if (String(headers.host).toLowerCase() !== url.host.toLowerCase()) return 403
    } catch {
      return 403
    }
  }
  return null
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(payload)),
  })
  res.end(payload)
}

async function readBody(req, limit = 1 << 20) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body must be JSON')
  }
}

/**
 * Register the widget's routes and return a disposer list.
 *
 * @param root - cordis root context (used for the index injection row).
 * @param options.webServer - the host web server service.
 * @param options.settings - cordis settings service (optional).
 * @param options.directoryPicker - the host's directory-picker seam (optional).
 * @param options.dshHome - DSH home directory.
 * @param options.packageRoot - plugin package directory (UI asset lives here).
 * @param options.transcribe - async (wavPath) => { text, ... }; used to auto-transcribe.
 * @param options.logger - cordis logger.
 */
export function mountAudioUi(root, options) {
  const { webServer, settings, directoryPicker, dshHome, packageRoot, transcribe, logger } = options
  const disposers = []

  // ---- persistent preferences -------------------------------------------
  // Stored in our own JSON file, not the settings service.
  //
  // `settings.mutate()` only writes volatile fields of an active *profile
  // entry*; "audio-transcribe" is a plain namespace string, not an entry id, so
  // a write through it is accepted and then dropped. That silent drop is why
  // the chosen directory used to revert on every restart.
  const configFile = path.join(dshHome, 'audio-transcribe', 'config.json')
  let prefs = null

  async function readConfig() {
    try {
      const parsed = JSON.parse(await fs.readFile(configFile, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Write then rename, so a crash cannot leave a truncated config behind. */
  async function writeConfig(patch) {
    const next = { ...(await readConfig()), ...patch }
    await fs.mkdir(path.dirname(configFile), { recursive: true })
    const tmp = `${configFile}.tmp`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
    await fs.rename(tmp, configFile)
    prefs = next
    return next
  }

  /**
   * Cached view of the config, seeded once from disk.
   * The in-flight promise is cached rather than the value, so concurrent
   * requests (status polling overlaps easily) share one read instead of racing.
   */
  let prefsLoad = null
  async function preferences() {
    if (prefs) return prefs
    if (!prefsLoad) {
      prefsLoad = readConfig()
        .then((value) => {
          prefs = value
          return value
        })
        .finally(() => {
          prefsLoad = null
        })
    }
    return prefsLoad
  }

  /** Settings service, resolved on demand for the same reason as the picker. */
  function settingsService() {
    return settings ?? root.get?.('settings')
  }

  /**
   * Current storage directory: saved config, then a settings-form value for
   * users who set it that way, then the built-in default.
   */
  async function resolveRecordDir() {
    const saved = await preferences()
    if (typeof saved.recordDir === 'string' && saved.recordDir) return saved.recordDir

    let configured = ''
    try {
      const descriptors = settingsService()?.describe?.({ redactSecrets: true }) ?? []
      const found = descriptors.find((d) => String(d.ns) === SETTINGS_NS)
      const value = found?.value ?? found?.config ?? {}
      if (typeof value?.recordDir === 'string' && value.recordDir) configured = value.recordDir
    } catch {
      /* settings unavailable on this host */
    }
    return configured || DEFAULT_RECORD_DIR(dshHome)
  }

  async function persistRecordDir(dir) {
    try {
      await writeConfig({ recordDir: dir })
      return { persisted: true }
    } catch (error) {
      logger?.warn?.(`[audio-transcribe] could not persist recordDir: ${error?.message ?? error}`)
      return { persisted: false, error: String(error?.message ?? error) }
    }
  }

  /** Whether each recording gets its own timestamped subfolder (default on). */
  async function perRecordingFolderEnabled() {
    const saved = await preferences()
    return saved.perRecordingFolder !== false
  }

  async function persistPerRecordingFolder(enabled) {
    try {
      await writeConfig({ perRecordingFolder: enabled === true })
      return { persisted: true }
    } catch (error) {
      return { persisted: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * Queue transcriptions so a long clip does not block the status poll.
   * Bounded: this runs for the lifetime of the process, and one entry per
   * recording would otherwise grow forever.
   */
  const TRANSCRIPT_HISTORY = 50
  const transcriptState = new Map() // wavPath -> 'pending' | 'done' | 'failed'
  let transcribing = 0

  function noteTranscript(file, state) {
    transcriptState.delete(file) // keep insertion order meaningful
    transcriptState.set(file, state)
    while (transcriptState.size > TRANSCRIPT_HISTORY) {
      const oldest = transcriptState.keys().next().value
      transcriptState.delete(oldest)
    }
  }

  async function autoTranscribe(recording) {
    if (!transcribe) return
    if (!recording?.ok) return
    noteTranscript(recording.file, 'pending')
    transcribing++
    try {
      const result = await transcribe(recording.file)
      const text = (result?.text ?? '').trim()
      if (text) {
        const txt = recording.file.replace(/\.wav$/i, '.txt')
        await fs.writeFile(txt, text + '\n', 'utf8')
        noteTranscript(recording.file, 'done')
      } else {
        noteTranscript(recording.file, 'failed')
      }
    } catch (error) {
      noteTranscript(recording.file, 'failed')
      logger?.warn?.(`[audio-transcribe] auto-transcribe failed: ${error?.message ?? error}`)
    } finally {
      transcribing--
    }
  }

  const recorder = createRecorder({
    packageRoot,
    getRecordDir: resolveRecordDir,
    getPerRecordingFolder: perRecordingFolderEnabled,
    onFinished: (recording) => void autoTranscribe(recording),
    logger,
  })

  // ---- routes ------------------------------------------------------------

  /**
   * Register a route behind the trust fence.
   * @param methods - allowed HTTP methods; omit to accept any.
   */
  function route(kind, p, handler, methods) {
    const allowed = methods === undefined ? null : Array.isArray(methods) ? methods : [methods]
    const guarded = async (req, res) => {
      const rejection = trustRejection(req)
      if (rejection !== null) {
        json(res, rejection, { ok: false, error: 'forbidden' })
        return
      }
      if (allowed !== null && !allowed.includes(req.method)) {
        json(res, 405, { ok: false, error: `use ${allowed.join(' or ')}` })
        return
      }
      return handler(req, res)
    }
    try {
      disposers.push(webServer.register({ kind, path: p, handler: guarded }))
    } catch (error) {
      logger?.warn?.(`[audio-transcribe] route ${p} failed: ${error?.message ?? error}`)
    }
  }

  route('exact', `${ROUTE_PREFIX}/status.json`, async (req, res) => {
    try {
      const dir = await resolveRecordDir()
      const [status, files, perFolder] = await Promise.all([
        recorder.status(),
        listRecordings(dir),
        perRecordingFolderEnabled(),
      ])
      json(res, 200, {
        ok: true,
        direction: dir,
        perRecordingFolder: perFolder,
        status,
        files,
        busy: transcribing > 0,
        transcripts: Object.fromEntries(transcriptState),
      })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('exact', `${ROUTE_PREFIX}/start.json`, async (req, res) => {
    try {
      const { maxSeconds } = await readBody(req)
      const limit = Number.isFinite(maxSeconds) ? Math.max(5, Math.min(7200, maxSeconds)) : 3600
      const started = await recorder.start(limit)
      json(res, 200, { ok: true, file: started.file })
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'POST')

  route('exact', `${ROUTE_PREFIX}/stop.json`, async (req, res) => {
    try {
      const stopped = await recorder.stop()
      json(res, 200, { ok: true, ...stopped })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }, 'POST')

  // GET reads the current directory; POST moves it.
  route('exact', `${ROUTE_PREFIX}/dir.json`, async (req, res) => {
    try {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, direction: await resolveRecordDir() })
        return
      }
      const { dir } = await readBody(req)
      if (typeof dir !== 'string' || !dir.trim()) throw new Error('dir is required')
      const next = dir.trim()
      // A UNC path would make the recorder write across the network, and a
      // system directory must never receive recordings.
      if (next.startsWith('\\\\') || next.startsWith('//')) {
        throw new Error('network (UNC) paths are not supported')
      }
      const systemRoot = path.parse(next).root
      if (path.normalize(next).toLowerCase() === systemRoot.toLowerCase()) {
        throw new Error('refusing to use a drive root as the storage directory')
      }
      await ensureWritableDir(next)
      const persisted = await persistRecordDir(next)
      json(res, 200, { ok: true, direction: next, ...persisted })
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // Toggle the per-recording subfolder behaviour. Kept separate from dir.json so
  // each preference has its own explicit verb.
  route('exact', `${ROUTE_PREFIX}/settings.json`, async (req, res) => {
    try {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, perRecordingFolder: await perRecordingFolderEnabled() })
        return
      }
      const body = await readBody(req)
      if (typeof body.perRecordingFolder !== 'boolean') {
        throw new Error('perRecordingFolder must be a boolean')
      }
      const result = await persistPerRecordingFolder(body.perRecordingFolder)
      json(res, 200, { ok: true, perRecordingFolder: body.perRecordingFolder, ...result })
    } catch (error) {
      json(res, 400, { ok: false, error: String(error?.message ?? error) })
    }
  })

  // ---- directory picking -------------------------------------------------
  // DSH already ships a directory-picker seam. Backends differ in interaction
  // shape, not just mechanism, so consumers switch on capability().kind:
  //   native → an OS folder chooser on the host display
  //   browse → listing/creation primitives for an in-app tree
  // A composition with no backend means the UI hides the affordance instead of
  // failing, which is why the kind is reported rather than assumed.
  //
  // The service is resolved per call, never captured once: the `auto` chooser
  // loads its backend through the loader after this plugin's apply() has
  // already run, so an eager capture would pin `undefined` forever.
  function pickerCapability() {
    try {
      const picker = directoryPicker ?? root.get?.('directoryPicker')
      const cap = picker?.capability?.()
      if (!cap || typeof cap.kind !== 'string') return null
      return cap
    } catch (error) {
      logger?.warn?.(`[audio-transcribe] directory picker unavailable: ${error?.message ?? error}`)
      return null
    }
  }

  route('exact', `${ROUTE_PREFIX}/picker.json`, async (req, res) => {
    const cap = pickerCapability()
    if (!cap) {
      json(res, 200, { ok: true, kind: null })
      return
    }
    json(res, 200, { ok: true, kind: cap.kind, direction: await resolveRecordDir() })
  })

  route('exact', `${ROUTE_PREFIX}/pick.json`, async (req, res) => {
    const cap = pickerCapability()
    if (!cap) {
      json(res, 501, { ok: false, error: 'this host has no directory picker configured' })
      return
    }
    if (cap.kind !== 'native') {
      // The browse backend is driven by its own UI; the widget does not render a
      // tree, so it asks the user to paste a path instead.
      json(res, 200, { ok: true, kind: cap.kind, unsupported: true })
      return
    }

    // `pick(signal)` dereferences the signal immediately (`signal.aborted`), so
    // calling it with no argument throws a TypeError. Tie the signal to the
    // response lifetime: closing the page dismisses the open chooser.
    const controller = new AbortController()
    const onClose = () => controller.abort()
    res.once('close', onClose)

    try {
      const picked = await cap.pick(controller.signal)
      if (!picked) {
        json(res, 200, { ok: true, kind: 'native', canceled: true })
        return
      }
      await ensureWritableDir(picked)
      const persisted = await persistRecordDir(picked)
      json(res, 200, { ok: true, kind: 'native', direction: picked, ...persisted })
    } catch (error) {
      // A dropped connection is not a user-visible failure.
      if (controller.signal.aborted && res.writableEnded) return
      json(res, 400, { ok: false, error: String(error?.message ?? error) })
    } finally {
      res.off('close', onClose)
    }
  }, 'POST')

  // Serve the widget script from the package, so the injected tag stays valid
  // even after the plugin is reinstalled or edited in place.
  const uiFile = path.join(packageRoot, 'assets', 'audio-ui.js')
  route('exact', `${ROUTE_PREFIX}/ui.js`, async (req, res) => {
    try {
      const body = await fs.readFile(uiFile)
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
      })
      res.end(body)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('audio widget not built')
        return
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(String(error?.message ?? error))
    }
  }, 'GET')

  // ---- index injection ---------------------------------------------------
  // On the desktop shell the index.html is served from the packaged dist and
  // never passes through tapIndex, so the only working channel is a structured
  // row. It must be an inline `script` row, not `script-src`: a failing
  // script-src rejects __DSH_BOOT_READY__ and the whole app fails to start.
  const INJECT_TEXT =
    '(function(){try{' +
    'if(window.__dshAudioWidget)return;window.__dshAudioWidget=1;' +
    'var d=document.body||document.documentElement;if(!d)return;' +
    'var s=document.createElement("script");s.src="' +
    ROUTE_PREFIX +
    '/ui.js";s.async=true;s.onerror=function(){};d.appendChild(s)' +
    '}catch(e){}})()'

  try {
    const off = root.on('webserver/index-inject', (table) => {
      try {
        if (!Array.isArray(table)) return
        for (const row of table) {
          if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(`${ROUTE_PREFIX}/ui.js`) >= 0) {
            return
          }
          if (row && row.kind === 'script-src' && row.src === `${ROUTE_PREFIX}/ui.js`) return
        }
        table.push({ kind: 'script', placement: 'body', text: INJECT_TEXT })
      } catch {
        /* never let injection break the page */
      }
    })
    if (typeof off === 'function') disposers.push(off)
  } catch (error) {
    logger?.warn?.(`[audio-transcribe] index injection unavailable: ${error?.message ?? error}`)
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
  }
}
