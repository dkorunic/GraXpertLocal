# GraXpertLocal

A PixInsight script that runs a locally installed [GraXpert](https://www.graxpert.com/) from inside PixInsight. It covers:

- **AI background extraction**: smoothing, choice of AI model version, and Subtraction or Division correction.
- **Sample-free background extraction**: scale, smoothing, structure protection (threshold and amount), simplified polynomial model, polynomial degree, and down-sampling.
- **AI denoising**: strength from 0 to 2, batch size, choice of AI model version, and a realtime preview.
- **Background extraction from GraXpert points**: RBF, Kriging or Splines, using background points you placed in the GraXpert app.

It talks to GraXpert only through GraXpert's own command-line interface. It contains no code from the withdrawn GraXpert4PixInsight module.

## Requirements

- macOS, Windows or Linux
- PixInsight
- GraXpert 4.0.0. The default paths are below. If yours is elsewhere, set the path in the dialog.
  - macOS: `/Applications/GraXpert.app`
  - Windows: `C:\Program Files\GraXpert\GraXpert.exe` (the MSI default)
  - Linux: `/usr/local/bin/GraXpert`

## Installation

1. In PixInsight, open *Script > Feature Scripts…*.
2. Click *Add* and select the `src/scripts` folder.
3. Click *Done*. The script appears under *Script > Utilities > GraXpertLocal*.

## Usage

Pick a target view and an operation, set the parameters, and click *Apply*.

- **Replace image**: when this is on, the result replaces the target and can be undone. When it is off, the result opens in a new image window that uses the source's screen stretch.
- **New windows** copy the source's screen stretch. When the size is unchanged, they also copy its FITS keywords and astrometric solution.
- **Show background model**: opens the extracted background as a separate image.
- **GPU acceleration**: if GraXpert fails with the GPU on, the script retries once on the CPU. Denoising with CoreML on macOS can crash.
- **AI model**: versions marked `*` are not stored locally yet. GraXpert downloads them on first use, so don't abort the download. *Download* installs the selected version now (*latest* means the newest remote version). The list of remote versions comes from GraXpert itself.
- **Realtime preview** (denoising): runs the AI once on a 512 px centre crop, or on the whole selected preview. After that, moving the Strength slider updates the preview instantly.
- **Apply with denoising** keeps the dialog open. The first Apply runs the AI on the full image. Applying again with a different Strength only re-blends the result, which is instant, and always starts from the original image. Changing the target view or the model runs the AI again.
- **Abort**: the console's Abort button stops GraXpert.
- **New instance** (triangle icon): drag it onto an image to run with the saved parameters without opening the dialog, or onto the workspace to create a process icon.
- **Reset**: restores GraXpert's default parameters.

### Background extraction from GraXpert points

1. Click *Export to GraXpert*. Place background points on the image in GraXpert and choose RBF, Kriging or Splines.
2. Close GraXpert so it saves its settings, including the points, to `preferences.json`. The file is in `~/Library/Application Support/GraXpert/` on macOS, `%LOCALAPPDATA%\GraXpert\GraXpert\` on Windows, and `~/.config/GraXpert/` on Linux.
3. Choose this operation, then click *Apply*. *Method* can override the method chosen in GraXpert. *Smoothing* and *Correction* come from the dialog.

The points must have been placed on an image of the same size as the target. GraXpert doesn't check this itself, so the script refuses to run when the sizes differ. *Check points* runs the same check without processing anything.

### Tools

- **Noise evaluation**: prints a noise estimate for each channel of the target to the console.
- **Info**: prints the GraXpert version, the executable path, and the locally installed and available AI models.
- **Launch GraXpert**: opens the GraXpert application.
- **Export to GraXpert / Import result**: GraXpert 4.0.0 can't run deconvolution from the command line, so you do it in the GraXpert app:
  1. *Export* saves the target to `~/GraXpertLocal/` and opens it in GraXpert.
  2. Process the image in GraXpert and save the result into that same folder.
  3. *Import* opens every image saved there since the last export. It copies the target's screen stretch, and if the size is unchanged, also its FITS keywords and astrometric solution.

## How it works

1. The target is written to a temporary 32-bit floating-point XISF file.
2. GraXpert runs with `-cli -cmd background-extraction|denoising` and the selected options.
3. The result is read back, and the temporary files are deleted.
4. Settings are stored in PixInsight's settings and kept between sessions.

## Previous work

Other projects that run or use GraXpert from PixInsight:

- [DeepSkyForge/GraXpert4PixInsight](https://github.com/DeepSkyForge/GraXpert4PixInsight): the closed-source GraXpert process module for PixInsight. Its author withdrew it to comply with Rule 5.5 of the Certified PixInsight Developer Program. It grew out of the author's earlier GraXpertSuite4PixInsight script, first published as `AstroDeepSky/GraXpert4PixInsight`. Those repositories are no longer online.
- [Donutstop/GraXpertSuite4PixInsight](https://github.com/Donutstop/GraXpertSuite4PixInsight) (GPL-3.0): the GraXpertSuite4PixInsight script, last updated in March 2024. It runs AI background extraction, opens images in GraXpert for manual processing, and imports the results with their astrometric data restored. It has separate code for macOS, Windows and Linux.
- [PixInsight Toolbox](https://gitlab.com/pixinsight-scripts/toolbox) by Jürgen Terpe: includes the `Graxpert.js` script (AI background extraction) and the `GraXpertDenoise.js` script. It is distributed through the [ideviceapps update repository](https://www.ideviceapps.de/graxpert-script.html), and its shared `GraXpertLib.jsh` has separate code for macOS, Windows and Linux.
- [tupolev/graxpertlauncher](https://github.com/tupolev/graxpertlauncher) (GPL-3.0): GraXpertLauncher, an early feature script for AI background extraction with a correction type and smoothing. Its default executable path is a Windows one (`GraXpert-win64.exe`).
- [QINZY8/GraXpertDeconvolution-PixInsight](https://github.com/QINZY8/GraXpertDeconvolution-PixInsight): a script that runs GraXpert 3.x deconvolution (object-only and stars-only) from the command line, on Windows and macOS.
- [jps-34/NarrowbandStarless](https://github.com/jps-34/NarrowbandStarless) (GPL-3.0): a narrowband pipeline script whose first step is GraXpert background extraction. It calls the withdrawn GraXpert process module, not the GraXpert CLI.
