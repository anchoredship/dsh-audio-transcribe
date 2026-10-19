# Troubleshooting

Most failures here are environment issues rather than bugs. Start from the
symptom.

## The widget pill does not appear

Injection is the most fragile part, and it fails silently by design — a broken
injection row would otherwise prevent the whole app from booting.

Check, in order:

1. **Did the plugin load?** Ask the agent to call `audio_model`. If the tool does
   not exist, the bundle is not loaded — not a widget problem.
2. **Is `/dsh-audio/ui.js` served?** Open it directly in the browser. A 404 means
   the route did not register (the `webServer` service was unavailable).
3. **Is the script tag injected?** In DevTools, search the DOM for
   `/dsh-audio/ui.js`. Absent means the `webserver/index-inject` row never landed.

Injection requires `apply()` to register the row **before** any `inject([...])`
callback runs, because the desktop shell collects the table once at boot.

## The "选择…" button is missing or still says "更改"

The button reflects what the host's directory-picker backend offers.

- **Shows 更改:** `GET /dsh-audio/picker.json` returned `kind: null` — this host
  has no picker backend. Manual path entry still works.
- **Shows 选择… but the dialog never opens:** the native backend needs the host's
  display. Under SSH or an all-interfaces bind, `dsh-host-directory-picker-auto`
  resolves to `browse` instead, and the widget deliberately does not render a
  tree.

The picker service mounts asynchronously (the auto chooser loads its backend
through the loader after plugins start), so the widget asks again on each panel
open rather than caching the first answer.

## Transcription returns nothing

The recording probably succeeded — check the WAV's duration.

| Symptom | Cause |
|---|---|
| WAV is ~0 s but has bytes | The recorder was killed instead of stopped; the RIFF header never got written |
| WAV is valid, transcript empty | Nothing audible was playing, or it played to a different output device |
| Pure music | SenseVoice is a speech model; it has nothing to recognise |

**The default output device matters.** Virtual and remote-desktop devices are
common defaults; if you are listening on headphones but the default is a virtual
cable, you will record silence. Check the device in Windows sound settings.

## `sherpa-onnx-node runtime not found`

The plugin reuses the ONNX runtime that ships inside DSH rather than bundling its
own. This error means it could not be located, which usually means the running
desktop is not DSH Desktop 0.2.x for win32-x64.

Workaround: set `DSH_RESOURCES_DIR` to the desktop's `resources` folder, e.g.
`D:\DSH\resources`.

## `E_ACCESSDENIED` when decoding mp3 or m4a

Media Foundation decoding needs a normal user token. Under a restricted sandbox
(for example, an agent tool running confined) it is refused. Run the command in
your own terminal instead. Plain `.wav` input does not go through Media
Foundation and is unaffected.

## The model reports `ready: no`

`audio_model` lists each expected file and where it looked. Two layouts are
supported:

```
<dir>/model.int8.onnx, tokens.txt, silero_vad.onnx      (flat, what download produces)
<dir>/sensevoice-onnx/{model,tokens}.onnx + <dir>/silero/silero_vad.onnx
```

If the listing shows files in neither place, either point the `modelDir` setting
at your copy or run `audio_model_download` once.
