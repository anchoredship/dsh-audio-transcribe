/**
 * Host-side HTTP surface for the recording widget.
 *
 * The client half (assets/audio-ui.js) is a thin remote control: every real
 * action — spawning the capture process, moving the storage directory,
 * transcribing the result — happens here.
 */
import { readFileSync, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import { createRecorder, listRecordings, ensureWritableDir } from './recorder.js'

/** Mount prefix for every route this module owns. */
export const ROUTE_PREFIX = '/dsh-audio'

const SETTINGS_NS = 'audio-transcribe'
const DEFAULT_RECORD_DIR = (dshHome) => path.join(dshHome, 'audio-transcribe', 'recordings')

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

  // ---- storage directory -------------------------------------------------
  // Kept in the plugin's settings namespace when available so it survives a
  // restart; falls back to a per-install default.
  let recordDir = null

  /** Settings service, resolved on demand for the same reason as the picker. */
  function settingsService() {
    return settings ?? root.get?.('settings')
  }

  function resolveRecordDir() {
    if (recordDir) return recordDir
    let configured = ''
    try {
      const descriptors = settingsService()?.describe?.({ redactSecrets: true }) ?? []
      const found = descriptors.find((d) => String(d.ns) === SETTINGS_NS)
      const value = found?.value ?? found?.config ?? {}
      if (typeof value?.recordDir === 'string' && value.recordDir) configured = value.recordDir
    } catch {
      /* settings unavailable on this host */
    }
    recordDir = configured || DEFAULT_RECORD_DIR(dshHome)
    return recordDir
  }

  async function persistRecordDir(dir) {
    recordDir = dir
    const svc = settingsService()
    if (!svc?.mutate) return { persisted: false }
    try {
      await settings.mutate(SETTINGS_NS, [{ op: 'set', path: ['recordDir'], value: dir }])
      return { persisted: true }
    } catch (error) {
      logger?.warn?.(`[audio-transcribe] could not persist recordDir: ${error?.message ?? error}`)
      return { persisted: false, error: String(error?.message ?? error) }
    }
  }

  /** Queue transcriptions so a long clip does not block the status poll. */
  const transcriptState = new Map() // wavPath -> 'pending' | 'done' | 'failed'
  let transcribing = 0

  async function autoTranscribe(recording) {
    if (!transcribe) return
    if (!recording?.ok) return
    transcriptState.set(recording.file, 'pending')
    transcribing++
    try {
      const result = await transcribe(recording.file)
      const text = (result?.text ?? '').trim()
      if (text) {
        const txt = recording.file.replace(/\.wav$/i, '.txt')
        await fs.writeFile(txt, text + '\n', 'utf8')
        transcriptState.set(recording.file, 'done')
      } else {
        transcriptState.set(recording.file, 'failed')
      }
    } catch (error) {
      transcriptState.set(recording.file, 'failed')
      logger?.warn?.(`[audio-transcribe] auto-transcribe failed: ${error?.message ?? error}`)
    } finally {
      transcribing--
    }
  }

  const recorder = createRecorder({
    packageRoot,
    getRecordDir: resolveRecordDir,
    onFinished: (recording) => void autoTranscribe(recording),
    logger,
  })

  // ---- routes ------------------------------------------------------------

  function route(kind, p, handler) {
    try {
      disposers.push(webServer.register({ kind, path: p, handler }))
    } catch (error) {
      logger?.warn?.(`[audio-transcribe] route ${p} failed: ${error?.message ?? error}`)
    }
  }

  route('exact', `${ROUTE_PREFIX}/status.json`, async (req, res) => {
    try {
      const dir = resolveRecordDir()
      const [status, files] = await Promise.all([recorder.status(), listRecordings(dir)])
      json(res, 200, {
        ok: true,
        direction: dir,
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
  })

  route('exact', `${ROUTE_PREFIX}/stop.json`, async (req, res) => {
    try {
      const stopped = await recorder.stop()
      json(res, 200, { ok: true, ...stopped })
    } catch (error) {
      json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  route('exact', `${ROUTE_PREFIX}/dir.json`, async (req, res) => {
    try {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, direction: resolveRecordDir() })
        return
      }
      const { dir } = await readBody(req)
      if (typeof dir !== 'string' || !dir.trim()) throw new Error('dir is required')
      const next = dir.trim()
      await ensureWritableDir(next)
      const persisted = await persistRecordDir(next)
      json(res, 200, { ok: true, direction: next, ...persisted })
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

  route('exact', `${ROUTE_PREFIX}/picker.json`, (req, res) => {
    const cap = pickerCapability()
    if (!cap) {
      json(res, 200, { ok: true, kind: null })
      return
    }
    json(res, 200, { ok: true, kind: cap.kind, direction: resolveRecordDir() })
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
  })

  // Serve the widget script from the package, so the injected tag stays valid
  // even after the plugin is reinstalled or edited in place.
  const uiFile = path.join(packageRoot, 'assets', 'audio-ui.js')
  route('exact', `${ROUTE_PREFIX}/ui.js`, (req, res) => {
    try {
      if (!existsSync(uiFile)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('audio widget not built')
        return
      }
      const body = readFileSync(uiFile)
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': String(body.length),
      })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(String(error?.message ?? error))
    }
  })

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
