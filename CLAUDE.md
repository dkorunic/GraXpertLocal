# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`src/scripts/GraXpertLocal.js` is a single-file PixInsight script (PJSR, `#engine v8`) that drives a locally installed GraXpert 4.0.0 through its CLI on macOS, Windows and Linux. It covers AI background extraction, sample-free extraction, AI denoising, and grid extraction (RBF/Kriging/Splines) from points placed in the GraXpert app. It was written from scratch to replace the closed-source GraXpert4PixInsight module, which its author withdrew. Do not decompile or copy that module.

There is no build system, git repo, or test suite.

## Checking changes

- Syntax check outside PixInsight. The `#` preprocessor lines must be commented out and `#__FILE__` replaced first:
  `sed -e 's|^#|//#|' -e 's|#__FILE__|"x"|' src/scripts/GraXpertLocal.js | node --check -`
- Check the GraXpert CLI contract directly. The default executable on macOS is `/Applications/GraXpert.app/Contents/MacOS/GraXpert`:
  `GraXpert -cli -cmd background-extraction -h` and `GraXpert -cli -cmd denoising -h`
- Everything else (PJSR classes such as `ImageWindow`, `ExternalProcess`, `Settings`, and `Dialog`) can only be tested inside PixInsight. Install it with *Script > Feature Scripts… > Add* and choose `src/scripts/`. It then appears under *Script > Utilities > GraXpertLocal*. Say clearly when a change has not been run inside PixInsight.

## Architecture

- **Params** (`Params()`): the `FIELDS` map (name → `DataType_*`) is the only list of parameters. `load`/`save` (PixInsight `Settings`) and `exportParameters`/`importParameters` (process-icon instances) iterate over it. To add a parameter, add it to `FIELDS` and to `reset()`.
- **Run flow**: `execute()` writes the view to a temporary 32-bit float XISF and calls `runGraXpert()` → `buildArgs()` → `runProcess()`. It then reads back `<output>.xisf` and, if `-bg` was passed, `<output>_background.xisf`. Finally it either replaces the view (undoable `beginProcess`/`endProcess`) or opens a new window. `copyMetadata()` gives that window the source's STF and, if the size matches, its FITS keywords and astrometric solution. Temporary files are always removed in `finally`.
- **`runProcess`** polls `waitForFinished(250)` with `processEvents()`, so the GUI stays responsive and the console Abort button works by killing the process and throwing `AbortError`. The output log is always buffered and is printed on failure even when `showLogs` is off. Abort is disabled while GraXpert's log shows a model download running (`DOWNLOAD_START`/`DOWNLOAD_END`), because killing it then corrupts the model folder. `runGraXpert` refuses GraXpert older than `MIN_GRAXPERT` (version from `-v`, cached per exe) and asks before a run downloads a model that isn't installed (no prompt for headless view-target runs).
- **GPU fallback**: if a run fails with `gpu` enabled, `runGraXpert` retries once with `-gpu false`, because CoreML denoising on macOS can crash.
- **Denoise strength blending** (`denoiseDiff`/`blend`): this depends on the verified GraXpert behaviour `result = orig + strength·(AI − orig)`, unclipped. The AI runs once at strength 1.0, the difference is stored, and any strength is then re-blended locally. `DenoisePreview` does this on a crop of at most 512 px, driven by the slider. `DenoiseFull` does it on the whole image: in the dialog, a denoise Apply leaves the dialog open and caches the original and the difference per (view, model), so applying again with another strength skips the AI. The cache relies on the dialog being modal and always blends from the cached original, so Replace mode never denoises twice. Headless runs still use `execute()`. If GraXpert ever changes this formula, both will be wrong.
- **Models**: `modelChoices()` lists local versions from `MODEL_ROOT/<kind>/` and adds the remote-only versions, marked with ` *`. `remoteModels()` parses them from GraXpert's own `-cli -cmd <cmd> -h` (`available remotely: [...]`, cached per exe and kind) and falls back to `REMOTE_MODELS`. `downloadModel()` (the Download button) installs a model by running GraXpert with `-gpu false` on a blank 256 px image, because GraXpert downloads the model before inference and CoreML crashes on the blank image. It then checks that the model folder exists. `cleanVersion()` strips the marker before the value is passed to `-ai_version`.
- **Grid extraction** (`CMD_GRID`): passes `-preferences_file` (the GraXpert app's `preferences.json`, which holds `background_points`, `width` and `height`) together with `-interpolation`, `-smoothing` and `-correction`. Command-line values override the file's values. GraXpert 4.0.0 exits 0 even when the image size doesn't match the points, so `checkGridPrefs()` must check the size and the minimum point count before every run.
- **Deconvolution is not available through the 4.0.0 CLI.** Export/Import is the workaround. Export writes `~/GraXpertLocal/<id>.xisf` and opens the GUI (`open -n -a` on macOS, a detached process elsewhere). Import opens every image in that folder that is newer than the last export.
- **Entry points** (`main()`): a view-target instance runs headless with no dialog; a global-target instance imports its parameters and then shows the dialog. The dialog's Reset button closes and reopens the dialog with defaults (the `resetRequested` loop).

## Conventions

- PixInsight code style: 3-space indent, braces on their own lines, spaces inside parentheses.
- Under `#engine v8`, `HorizontalSizer`, `VerticalSizer` and `NumericControl` are native classes. Do not `#include` `Sizer.jsh` or `NumericControl.jsh`, because they redeclare those classes and the script fails to compile. Headers that only hold `#define` constants (`TextAlign.jsh`, `StdIcon.jsh` …) are safe to include.
- Native classes such as `Dialog` must be subclassed with `var X = class extends Dialog { constructor() { super(); … } }`. The legacy `this.__base__ = Dialog; this.__base__()` pattern throws "cannot be invoked without 'new'". Top-level declarations use `var`/`function`, never `let`/`const`/`class`, because the V8 runtime can persist between runs and a second run would fail with "already declared".
- **Platforms**: `GX_OS` (from `__PI_PLATFORM__`) becomes the runtime `OS` (`mac`/`win`/`linux`). It sets `DEFAULT_EXE`, `MODEL_ROOT` (GraXpert's appdirs `user_data_dir`) and `CONFIG_ROOT` (`user_config_dir`, which holds `preferences.json`). The two roots differ only on Linux (XDG). Windows uses `%LOCALAPPDATA%/GraXpert/GraXpert/`. Keep paths in PJSR's `/` form; `cleanPath()` converts pasted backslash paths. macOS alone has `.app` bundle handling and `/usr/bin/open`; elsewhere `launchGui` uses `ExternalProcess.startDetached`. Only macOS has been tested.
- Defaults should match GraXpert's own defaults (its `preferences.json` / `-h`).
