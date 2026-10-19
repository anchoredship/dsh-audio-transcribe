# Contributing

Thanks for taking a look. This is a small plugin, so the process is light.

## Reporting a problem

Please include:

- DSH Desktop version and Windows version
- what you did, what you expected, what happened
- whether the bug is in the **tools** (agent calls) or the **widget** (the pill)
- for widget issues, the browser console if there is an error

If the widget does not appear at all, say so explicitly — injection is the most
fragile part and the failure mode is silence.

## Development

```
src/index.js      config, model resolution, the three tools, widget mounting
src/recorder.js   child-process lifecycle for LoopbackCap.exe
src/ui-routes.js  HTTP routes and the index injection row
assets/audio-ui.js  the browser widget (plain script, no build step)
bin/              LoopbackCap.exe + NAudio (prebuilt, see below)
```

There is no build step for the JavaScript. Edit, restart DSH, reload.

### Rebuilding the recorder

`bin/LoopbackCap.exe` is compiled from C#; the source is not shipped here to keep
the package small. It uses NAudio's `WasapiLoopbackCapture` to read the default
output device, resamples to 16 kHz mono, and writes a WAV. It stops by polling
for `<file>.stop`, so the RIFF header is always written before exit — killing
the process instead leaves a file that every decoder reads as 0 seconds.

If you need to change it, the interfaces it must honour are:

- args: `<naudioDir> <out.wav> <maxSeconds> [renderDeviceNameSubstring]`
- poll `<out.wav>.stop` and finalise the WAV, then exit 0
- write progress to stdout

### Style

Match what is there: no build tooling, no dependencies beyond what a DSH plugin
needs, and comments that explain *why* rather than restating the code.

## Pull requests

Small and focused beats large and mixed. If it changes user-visible behaviour,
update the README in the same PR.
