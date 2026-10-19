/**
 * Local audio transcription for DeepSeek Harness.
 *
 * Registers an `audio_transcribe` tool that turns an audio file into text fully
 * offline, using the SenseVoice model. The model can live in any directory the
 * user picks; `audio_model` reports where it is and `audio_model_download`
 * fetches it into a chosen location.
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createWriteStream, accessSync } from 'node:fs'
import fs from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { mountAudioUi } from './ui-routes.js'

/** Absolute directory of this package, used to locate bin/ and assets/. */
const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** Stable Loader identity. */
export const name = 'dsh-audio-transcribe'

/** Pinned model revision, byte sizes and checksums (same assets the bundled
 * speech provider verifies — these URLs are immutable by revision). */
const ASSETS = {
  model: {
    file: 'model.int8.onnx',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
    mirrorUrl: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
    bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
  },
  tokens: {
    file: 'tokens.txt',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
    mirrorUrl: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
    bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
  },
  vad: {
    file: 'silero_vad.onnx',
    url: 'https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
    mirrorUrl: 'https://hf-mirror.com/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/silero_vad.onnx',
    bytes: 1807522,
    sha256: 'a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28',
  },
}

const LANGUAGES = ['auto', 'zh', 'en', 'ja', 'ko', 'yue']
const MODES = ['auto', 'whole', 'segment']

/**
 * Where the model directory is looked up when the config leaves it empty.
 *
 * The bundled DSH speech provider already keeps a verified SenseVoice cache
 * under <dshHome>/speech-to-text/sensevoice/models. Reuse it by default so the
 * plugin works on an installation that has used voice input, instead of asking
 * for a second 230 MB download. A dedicated directory is still created on
 * demand when the user downloads to the plugin's own location.
 */
function defaultModelDir() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'speech-to-text', 'sensevoice', 'models')
}

/** Fallback used when the shared cache is absent and the user downloads fresh. */
function ownModelDir() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'audio-transcribe', 'models')
}

export const Config = z.object({
  modelDir: z
    .string()
    .description(
      'Absolute directory holding the SenseVoice model files. Empty reuses the cache of the ' +
        'bundled DSH speech provider (<dshHome>/speech-to-text/sensevoice/models).'
    )
    .default(''),
  language: z
    .string()
    .description('Default recognition language: auto, zh, en, ja, ko or yue.')
    .default('zh'),
  numThreads: z.number().description('CPU threads used for inference.').default(2),
})

/**
 * Resolve the sherpa-onnx runtime that ships with the DSH installation.
 *
 * Preference order:
 *   1. this package's own resolution path (works if the profile has it),
 *   2. the unpacked runtime under the DSH resources directory,
 *   3. the runtime inside app.asar — resolvable only under Electron's patched
 *      fs, which is always the case when DSH Desktop runs the plugin.
 *
 * Reusing the shipped runtime keeps this plugin free of native dependencies.
 */
function loadSherpa() {
  const errors = []
  const attempts = []

  attempts.push(createRequire(import.meta.url))

  const resources = process.env.DSH_RESOURCES_DIR
  const roots = []
  if (resources) {
    roots.push(path.join(resources, 'app.asar.unpacked', 'dsh', 'node_modules'))
    roots.push(path.join(resources, 'app.asar', 'dsh', 'node_modules'))
  }
  // Electron sets this to the resources directory of the running app.
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    roots.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'dsh', 'node_modules'))
    roots.push(path.join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules'))
  }
  for (const root of roots) {
    attempts.push(createRequire(path.join(root, 'noop.js')))
  }

  for (const req of attempts) {
    try {
      const mod = req('sherpa-onnx-node')
      if (mod && typeof mod.OfflineRecognizer === 'function') return mod
    } catch (error) {
      errors.push(error.message.split('\n')[0])
    }
  }

  throw new Error(
    'sherpa-onnx-node runtime not found. This plugin reuses the speech runtime bundled with ' +
      'DSH Desktop rather than shipping its own native build. Ensure DSH Desktop 0.2.x ' +
      'is installed (win32-x64), or set DSH_RESOURCES_DIR to its "resources" folder. ' +
      `Attempts: ${errors.join(' | ')}`
  )
}

/** Read a WAV (PCM or float, any rate/channels) into mono Float32 samples. */
function readWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file')
  }
  let pos = 12
  let fmt = null
  let dataOffset = -1
  let dataSize = 0
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString('ascii', pos, pos + 4)
    const size = buffer.readUInt32LE(pos + 4)
    const body = pos + 8
    if (id === 'fmt ') {
      let format = buffer.readUInt16LE(body)
      const channels = buffer.readUInt16LE(body + 2)
      const sampleRate = buffer.readUInt32LE(body + 4)
      const bits = buffer.readUInt16LE(body + 14)
      if (format === 0xfffe && size >= 40) format = buffer.readUInt16LE(body + 24)
      fmt = { format, channels, sampleRate, bits }
    } else if (id === 'data') {
      dataOffset = body
      dataSize = size
      if (dataOffset + dataSize > buffer.length) dataSize = buffer.length - dataOffset
    }
    pos = body + size + (size % 2)
  }
  if (!fmt || dataOffset < 0) throw new Error('WAV is missing a fmt or data chunk')
  if (fmt.format !== 1 && fmt.format !== 3) {
    throw new Error(`Unsupported WAV encoding (format ${fmt.format}); supply PCM or float WAV`)
  }

  const bytesPerSample = fmt.bits / 8
  const frames = Math.floor(dataSize / (bytesPerSample * fmt.channels))
  const samples = new Float32Array(frames)
  const isFloat = fmt.format === 3
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) {
      const off = dataOffset + (i * fmt.channels + c) * bytesPerSample
      let v
      if (isFloat && fmt.bits === 32) v = buffer.readFloatLE(off)
      else if (fmt.bits === 16) v = buffer.readInt16LE(off) / 32768
      else if (fmt.bits === 32) v = buffer.readInt32LE(off) / 2147483648
      else if (fmt.bits === 24) v = ((buffer[off + 2] << 24) | (buffer[off + 1] << 16) | (buffer[off] << 8)) >> 8
      else if (fmt.bits === 8) v = (buffer[off] - 128) / 128
      else throw new Error(`Unsupported WAV bit depth: ${fmt.bits}`)
      sum += v
    }
    samples[i] = sum / fmt.channels
  }
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits }
}

/** Linear resample to 16 kHz — adequate for VAD gating. */
function to16k(samples, sampleRate) {
  if (sampleRate === 16000) return samples
  const ratio = 16000 / sampleRate
  const len = Math.floor(samples.length * ratio)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const src = i / ratio
    const i0 = Math.floor(src)
    const i1 = Math.min(i0 + 1, samples.length - 1)
    const f = src - i0
    out[i] = samples[i0] * (1 - f) + samples[i1] * f
  }
  return out
}

/** Cheap silence estimate: share of 100 ms windows that are near-silent. */
function quietRatio(samples16k) {
  const win = 1600
  let quiet = 0
  let total = 0
  for (let off = 0; off + win <= samples16k.length; off += win) {
    total++
    let peak = 0
    for (let i = off; i < off + win; i++) {
      const a = Math.abs(samples16k[i])
      if (a > peak) peak = a
    }
    if (peak < 0.01) quiet++
  }
  return total ? quiet / total : 0
}

// No module-level `inject` export, deliberately.
//
// `tools` is an agent-scoped service. Declaring it at module level makes the
// plugin wait for a service the host plane never provides, and cordis reports
// that as a silent PENDING — the plugin appears loaded while registering
// nothing. `tools` and `webServer` are therefore injected locally inside
// apply(), where the callbacks fire once the services exist.

/**
 * Register the transcription tool surface.
 * @param ctx - agent-scoped services.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx, config) {
  const resolvedModelDir = config.modelDir ? config.modelDir : defaultModelDir()
  ctx.logger?.info?.(`[audio-transcribe] model directory: ${resolvedModelDir}`)

  /**
   * Locate one asset. Two layouts are supported because the model may come from
   * either place:
   *   flat      <dir>/model.int8.onnx, <dir>/tokens.txt, <dir>/silero_vad.onnx
   *             (what audio_model_download produces)
   *   layered   <dir>/sensevoice-onnx/{model.int8.onnx,tokens.txt}
   *             <dir>/silero/silero_vad.onnx
   *             (what the bundled DSH speech provider cache looks like)
   */
  function locate(asset) {
    const flat = path.join(resolvedModelDir, asset.file)
    const layered =
      asset === ASSETS.vad
        ? path.join(resolvedModelDir, 'silero', asset.file)
        : path.join(resolvedModelDir, 'sensevoice-onnx', asset.file)
    try {
      accessSync(flat)
      return flat
    } catch {
      /* try layered */
    }
    try {
      accessSync(layered)
      return layered
    } catch {
      /* absent */
    }
    return null
  }

  let recognizer = null
  let sherpa = null

  async function ensureFiles() {
    const missing = []
    for (const asset of [ASSETS.model, ASSETS.tokens]) {
      if (locate(asset) === null) {
        const flat = path.join(resolvedModelDir, asset.file)
        const layered =
          asset === ASSETS.vad
            ? path.join(resolvedModelDir, 'silero', asset.file)
            : path.join(resolvedModelDir, 'sensevoice-onnx', asset.file)
        missing.push(`${asset.file} (looked in ${flat} and ${layered})`)
      }
    }
    return missing
  }

  function getRecognizer(language) {
    if (recognizer) return recognizer
    const modelPath = locate(ASSETS.model)
    const tokensPath = locate(ASSETS.tokens)
    if (!modelPath || !tokensPath) throw new Error('SenseVoice model files are not available')
    sherpa = sherpa ?? loadSherpa()
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: modelPath, language, useInverseTextNormalization: 1 },
        tokens: tokensPath,
        numThreads: config.numThreads,
        provider: 'cpu',
        debug: 0,
      },
    })
    return recognizer
  }

  function decodeChunk(rec, samples, sampleRate) {
    const stream = rec.createStream()
    stream.acceptWaveform({ samples, sampleRate })
    rec.decode(stream)
    const r = rec.getResult(stream)
    return { text: (r.text || '').trim(), lang: r.lang, emotion: r.emotion, event: r.event }
  }

  function runWhole(rec, wav) {
    const r = decodeChunk(rec, wav.samples, wav.sampleRate)
    return r.text ? [{ text: r.text, start: null }] : []
  }

  function runSegment(rec, wav) {
    const vadPath = locate(ASSETS.vad)
    if (vadPath === null) return runWhole(rec, wav)

    const samples = to16k(wav.samples, wav.sampleRate)
    const windowSize = 512
    const vad = new sherpa.Vad(
      {
        sileroVad: {
          model: vadPath,
          threshold: 0.5,
          minSilenceDuration: 0.35,
          minSpeechDuration: 0.25,
          maxSpeechDuration: 20,
          windowSize,
        },
        sampleRate: 16000,
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
      },
      60
    )
    const parts = []
    const drain = () => {
      while (!vad.isEmpty()) {
        const seg = vad.front()
        vad.pop()
        if (!seg?.samples?.length) continue
        const r = decodeChunk(rec, new Float32Array(seg.samples), 16000)
        if (r.text) parts.push({ text: r.text, start: typeof seg.start === 'number' ? seg.start / 16000 : null })
      }
    }
    for (let off = 0; off < samples.length; off += windowSize) {
      vad.acceptWaveform(samples.subarray(off, Math.min(off + windowSize, samples.length)))
      drain()
    }
    vad.flush()
    drain()
    return parts
  }

  /**
   * Transcribe a WAV path with the auto mode policy.
   * Shared by the `audio_transcribe` tool and the recording widget, so both
   * report identical results for the same file.
   * @param wavPath - absolute path to a WAV file.
   * @param language - recognition language hint.
   * @returns {Promise<{text: string, segments: any[], durationSeconds: number, mode: string, language: string}>}
   */
  async function transcribeFile(wavPath, language = config.language) {
    const missing = await ensureFiles()
    if (missing.length > 0) {
      throw new Error(
        `SenseVoice model files are missing from ${resolvedModelDir}: ${missing.join(', ')}. ` +
          'Run audio_model_download with that directory to fetch them, or point the plugin setting at an existing copy.'
      )
    }

    let buffer
    try {
      buffer = await fs.readFile(wavPath)
    } catch (error) {
      throw new Error(`Cannot read ${wavPath}: ${error.message}`)
    }
    const wav = readWav(buffer)
    const durationSeconds = wav.samples.length / wav.sampleRate

    const s16 = to16k(wav.samples, wav.sampleRate)
    const quiet = quietRatio(s16)
    let effectiveMode
    if (durationSeconds <= 30) effectiveMode = 'whole'
    else if (quiet >= 0.15) effectiveMode = 'segment'
    else effectiveMode = durationSeconds > 120 ? 'segment' : 'whole'

    const rec = getRecognizer(language)
    const parts = effectiveMode === 'segment' ? runSegment(rec, wav) : runWhole(rec, wav)

    return {
      text: parts.map((p) => p.text).join(effectiveMode === 'segment' ? '\n' : ' '),
      segments: parts.map((p) => (p.start === null ? { text: p.text } : { text: p.text, start: p.start })),
      durationSeconds,
      mode: effectiveMode,
      language,
    }
  }

  // ---------- tools ----------

  // `tools` is agent-scoped, so inject it locally instead of at module level.
  ctx.inject(['tools'], (sctx) => {
    sctx.effect(() => {
  sctx.tools.register(
    defineTool({
      name: 'audio_transcribe',
      description:
        'Transcribe an audio file to text locally and offline using the SenseVoice model. ' +
        'Supports WAV directly; other formats must be converted to 16 kHz mono WAV first. ' +
        'Use when the user wants speech turned into text from a local audio recording.',
      parameters: {
        path: {
          type: 'string',
          required: true,
          description: 'Absolute path to a WAV file (PCM or float, any sample rate).',
        },
        language: {
          type: 'string',
          description: `Recognition language: ${LANGUAGES.join(', ')}. Defaults to the plugin setting.`,
        },
        mode: {
          type: 'string',
          description:
            'Decoding strategy: auto (default), whole (single pass, good for short clips) or ' +
            'segment (VAD-split with timestamps, better for long or pause-heavy audio).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', required: true },
            segments: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  text: { type: 'string', required: true },
                  start: { type: 'number' },
                },
              },
            },
            durationSeconds: { type: 'number', required: true },
            mode: { type: 'string', required: true },
            language: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const head =
            value.text ||
            `(no speech detected in ${value.durationSeconds.toFixed(1)}s of audio)`
          return [{ type: 'text', text: head }]
        },
      },
      async execute(args, exec) {
        const language = args.language ?? config.language
        const mode = args.mode ?? 'auto'
        if (!LANGUAGES.includes(language)) {
          throw new Error(`Unsupported language "${language}"; use one of ${LANGUAGES.join(', ')}`)
        }
        if (!MODES.includes(mode)) {
          throw new Error(`Unsupported mode "${mode}"; use one of ${MODES.join(', ')}`)
        }
        if (!path.isAbsolute(args.path)) {
          throw new Error('path must be absolute so the file is unambiguous')
        }

        exec?.signal?.throwIfAborted?.()

        if (mode !== 'auto') {
          // Honour an explicitly requested strategy; transcribeFile only applies
          // the auto policy.
          await ensureFiles()
          const buffer = await fs.readFile(args.path)
          const wav = readWav(buffer)
          const rec = getRecognizer(language)
          const parts = mode === 'segment' ? runSegment(rec, wav) : runWhole(rec, wav)
          return {
            text: parts.map((p) => p.text).join(mode === 'segment' ? '\n' : ' '),
            segments: parts.map((p) =>
              p.start === null ? { text: p.text } : { text: p.text, start: p.start }
            ),
            durationSeconds: wav.samples.length / wav.sampleRate,
            mode,
            language,
          }
        }

        return await transcribeFile(args.path, language)
      },
    })
  )

  sctx.tools.register(
    defineTool({
      name: 'audio_model',
      description:
        'Report where the SenseVoice model this plugin uses is stored, whether the files are ' +
        'present and intact, and their sizes. Use before transcribing to check readiness, or ' +
        'when the user asks where the model lives.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            modelDir: { type: 'string', required: true },
            ready: { type: 'boolean', required: true },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  file: { type: 'string', required: true },
                  path: { type: 'string', required: true },
                  present: { type: 'boolean', required: true },
                  bytes: { type: 'integer' },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const lines = value.files.map(
            (f) => `- ${f.file}: ${f.present ? `${f.bytes} bytes` : 'missing'} (${f.path})`
          )
          return [
            {
              type: 'text',
              text:
                `Model directory: ${value.modelDir}\n` +
                `Ready: ${value.ready ? 'yes' : 'no — run audio_model_download'}\n` +
                lines.join('\n'),
            },
          ]
        },
      },
      async execute() {
        const files = []
        for (const asset of [ASSETS.model, ASSETS.tokens, ASSETS.vad]) {
          // Report the path that was actually found, not a guessed one.
          const found = locate(asset)
          let present = false
          let bytes
          if (found !== null) {
            try {
              const st = await fs.stat(found)
              present = st.isFile()
              bytes = st.size
            } catch {
              /* vanished between checks */
            }
          }
          files.push({
            file: asset.file,
            path: found ?? path.join(resolvedModelDir, asset.file),
            present,
            ...(bytes === undefined ? {} : { bytes }),
          })
        }
        return { modelDir: resolvedModelDir, ready: files[0].present && files[1].present, files }
      },
    })
  )

  sctx.tools.register(
    defineTool({
      name: 'audio_model_download',
      description:
        'Download the SenseVoice model (~230 MB) into a directory the user chooses. Skips files ' +
        'that already exist with the right size and checksum. Use when audio_model reports the ' +
        'model is missing, or when the user wants the model stored at a specific location.',
      parameters: {
        dir: {
          type: 'string',
          description:
            'Absolute directory to download into. Created if absent. Defaults to the configured model directory.',
        },
        mirror: {
          type: 'boolean',
          description: 'Use hf-mirror.com instead of huggingface.co (useful on restricted networks).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            modelDir: { type: 'string', required: true },
            downloaded: { type: 'array', required: true, items: { type: 'string' } },
            skipped: { type: 'array', required: true, items: { type: 'string' } },
            totalBytes: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => [
          {
            type: 'text',
            text:
              `Model ready at ${value.modelDir}\n` +
              `Downloaded: ${value.downloaded.length ? value.downloaded.join(', ') : 'none'}\n` +
              `Already present: ${value.skipped.length ? value.skipped.join(', ') : 'none'}\n` +
              `Total: ${(value.totalBytes / 1024 / 1024).toFixed(1)} MB`,
          },
        ],
      },
      async execute(args, exec) {
        // A fresh download must not write into the shared speech-provider cache
        // the default path points at, so fall back to the plugin's own folder.
        const target = args.dir ?? (config.modelDir ? resolvedModelDir : ownModelDir())
        if (!path.isAbsolute(target)) throw new Error('dir must be an absolute path')
        const useMirror = args.mirror === true
        await fs.mkdir(target, { recursive: true })

        const downloaded = []
        const skipped = []
        let totalBytes = 0

        for (const asset of [ASSETS.tokens, ASSETS.vad, ASSETS.model]) {
          exec?.signal?.throwIfAborted?.()
          const dest = path.join(target, asset.file)

          // Reuse a complete, verified file.
          try {
            const st = await fs.stat(dest)
            if (st.isFile() && st.size === asset.bytes && (await sha256File(dest)) === asset.sha256) {
              skipped.push(asset.file)
              totalBytes += st.size
              continue
            }
          } catch {
            /* absent → download */
          }

          const url = useMirror && asset.mirrorUrl ? asset.mirrorUrl : asset.url
          const res = await fetch(url, { redirect: 'follow', signal: exec?.signal })
          if (!res.ok || !res.body) {
            throw new Error(`Download failed for ${asset.file}: HTTP ${res.status} from ${url}`)
          }

          const tmp = `${dest}.part`
          await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp))
          const st = await fs.stat(tmp)
          if (st.size !== asset.bytes) {
            await fs.rm(tmp, { force: true })
            throw new Error(
              `Size mismatch for ${asset.file}: expected ${asset.bytes} bytes, received ${st.size}. ` +
                'The download may have been truncated; retry, optionally with mirror=true.'
            )
          }
          const digest = await sha256File(tmp)
          if (digest !== asset.sha256) {
            await fs.rm(tmp, { force: true })
            throw new Error(
              `Checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${digest}. ` +
                'The file was rejected and removed; retry, optionally with mirror=true.'
            )
          }
          await fs.rename(tmp, dest)
          downloaded.push(asset.file)
          totalBytes += st.size
        }

        return { modelDir: target, downloaded, skipped, totalBytes }
      },
    })
  )
    })
  })

  // ---------- recording widget ----------
  // The web/desktop shell renders this widget; the browser itself cannot reach
  // system playback, so every action proxies to the host through these routes.
  ctx.inject(['webServer'], (sctx) => {
    sctx.effect(() => {
      const unmount = mountAudioUi(sctx, {
        webServer: sctx.webServer,
        settings: sctx.get?.('settings'),
        // Optional: a composition without a picker backend simply reports no
        // capability, and the widget falls back to manual entry.
        directoryPicker: sctx.get?.('directoryPicker'),
        dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
        packageRoot: PACKAGE_ROOT,
        transcribe: (wavPath) => transcribeFile(wavPath, config.language),
        logger: ctx.logger,
      })
      return () => {
        try {
          unmount()
        } catch {
          /* already disposed */
        }
      }
    })
  })
}

async function sha256File(file) {
  const hash = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead === 0) break
      hash.update(buf.subarray(0, bytesRead))
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}
