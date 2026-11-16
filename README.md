# GraXpertLocal

A PixInsight script that runs a locally installed [GraXpert](https://www.graxpert.com/) from inside PixInsight. It covers:

- **AI background extraction**: smoothing, choice of AI model version, and Subtraction or Division correction.
- **Sample-free background extraction**: scale, smoothing, structure protection (threshold and amount), simplified polynomial model, polynomial degree, and down-sampling.
- **AI denoising**: strength from 0 to 2, batch size, choice of AI model version, and a realtime preview.
- **Background extraction from GraXpert points**: RBF, Kriging or Splines, using background points you placed in the GraXpert app.

It talks to GraXpert only through GraXpert's own command-line interface. It contains no code from the withdrawn GraXpert4PixInsight module.

## Requirements

- macOS
- PixInsight
- GraXpert 4.0.0, installed at `/Applications/GraXpert.app` (you can change the path in the dialog)

## Installation

1. In PixInsight, open *Script > Feature Scripts…*.
2. Click *Add* and select the `src/scripts` folder.
3. Click *Done*. The script appears under *Script > Utilities > GraXpertLocal*.

## Usage

Pick a target view and an operation, set the parameters, and click *Apply*.

- **Replace image**: when this is on, the result replaces the target and can be undone. When it is off, the result opens in a new image window that uses the source's screen stretch.
- **New windows** copy the source's screen stretch. When the size is unchanged, they also copy its FITS keywords and astrometric solution.
- **Show background model**: opens the extracted background as a separate image.
- **GPU acceleration**: if GraXpert fails with the GPU on, the script retries once on the CPU. CoreML denoising can crash.
- **AI model**: versions marked `*` are not stored locally yet. GraXpert downloads them on first use, so don't abort the download. *Download* installs the selected version now (*latest* means the newest remote version). The list of remote versions comes from GraXpert itself.
- **Realtime preview** (denoising): runs the AI once on a 512 px centre crop, or on the whole selected preview. After that, moving the Strength slider updates the preview instantly.
- **Apply with denoising** keeps the dialog open. The first Apply runs the AI on the full image. Applying again with a different Strength only re-blends the result, which is instant, and always starts from the original image. Changing the target view or the model runs the AI again.
- **Abort**: the console's Abort button stops GraXpert.
- **New instance** (triangle icon): drag it onto an image to run with the saved parameters without opening the dialog, or onto the workspace to create a process icon.
- **Reset**: restores GraXpert's default parameters.

### Background extraction from GraXpert points

1. Click *Export to GraXpert*. Place background points on the image in GraXpert and choose RBF, Kriging or Splines.
2. Close GraXpert so it saves its settings, including the points, to `~/Library/Application Support/GraXpert/preferences.json`.
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
