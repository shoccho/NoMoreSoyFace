# NoMoreSoyFace

Blur the thumbnail bait out of YouTube.

NoMoreSoyFace is a browser extension (Chrome and Firefox) that detects faces and people in YouTube thumbnails and blurs them locally in your browser. It is built for people who want to browse by topic, title, and actual interest instead of being pulled around by exaggerated thumbnail expressions.

## Why This Exists

The idea came from a very specific kind of internet fatigue: looking at YouTubers making the same annoying over-the-top expressions on every thumbnail started to feel actively irritating.

It is also kind of the opposite of the old MrBeast-style thumbnail gag extensions, where his expression gets pasted onto everything. NoMoreSoyFace goes the other direction: instead of adding more face chaos to YouTube, it removes the thumbnail bait so the page becomes quieter.

## Features

- **Face blurring**: detects human faces in thumbnails and applies a CSS blur.
- **Body blurring**: detects people in thumbnails, including full-body and half-body shots.
- **Gender mode**: choose `Male`, `Both`, or `Female` for face and body filtering.
- **Adjustable thresholds**: tune face/gender confidence and person detection confidence.
- **Shared model instance**: runs inference once in the background (a Manifest V3 offscreen document on Chrome, a persistent background page on Firefox) instead of loading models in every YouTube tab.
- **Thumbnail cache**: avoids re-processing the same YouTube thumbnail repeatedly.
- **Local-first privacy**: no analytics, no telemetry, and no uploaded images.
- **Toolbar status**: the extension icon indicates inactive, loading/not-ready, active, or off.



## Screenshots

Popup

<img width="300" height="600" alt="image" src="https://github.com/user-attachments/assets/5fba86b3-7e65-4b4a-b123-fee8c5addcd4" />

Off

<img width="800" height="500" alt="image" src="https://github.com/user-attachments/assets/676cfdc0-8cee-4db2-95c3-694a20d080de" />

On (both genders)

<img width="800" height="500" alt="image" src="https://github.com/user-attachments/assets/f1d33318-fbcf-4905-8831-0b379d77a639" />


On (Female only)

<img width="800" height="500" alt="image" src="https://github.com/user-attachments/assets/ba84d5c4-ed26-4dd3-a8f6-1a3cc6ec9428" />




## How It Works

NoMoreSoyFace uses a content script to watch YouTube pages for thumbnail images from `i.ytimg.com`. Candidate thumbnails are queued and sent to a shared background context, where the ML models run.

On Chrome (Manifest V3) inference happens in an offscreen document. On Firefox (Manifest V2) the same code runs in a persistent background page, which has the DOM access the models need. The shared `content.js` and `popup.js` work on both browsers.

The extension currently uses:

- `face-api.js` TinyFaceDetector for face detection.
- `face-api.js` age/gender model for gender filtering.
- TensorFlow.js COCO-SSD Lite MobileNet for person/body detection.
- CSS `filter: blur(...)` to hide matching thumbnails without modifying the page layout.

The npm setup script hydrates `vendor/` and `models/` locally. Those directories are generated runtime assets and are intentionally ignored by git.

## Install From Source

1. Clone or download this repository.
2. Install dependencies and hydrate the browser bundles/model files:

   ```bash
   npm install
   ```

   `npm install` runs `npm run prepare-assets` automatically. You can also run it manually if you need to re-create `vendor/` or `models/`.

Each browser loads from its own build output under `dist/`.

### Chrome

1. Build the Chrome bundle:

   ```bash
   npm run build:chrome
   ```

2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the generated `dist/chrome` folder.
6. Open YouTube and wait for the popup status to show `Ready`.

### Firefox

1. Build the Firefox bundle:

   ```bash
   npm run build:firefox
   ```

2. Open Firefox and go to `about:debugging`.
3. Click **This Firefox**.
4. Click **Load Temporary Add-on…**.
5. Select the `dist/firefox/manifest.json` file.
6. Open YouTube and wait for the popup status to show `Ready`.

   Temporary add-ons are removed when Firefox restarts. After changing code, run
   `npm run build:firefox` again and click **Reload** next to the add-on. For a
   persistent install you need a signed build (for example via
   [`web-ext sign`](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)).

## Settings

| Setting | What it does |
| --- | --- |
| Filtering | Turns all thumbnail filtering on or off. |
| Blur faces | Enables face detection. |
| Gender mode | Filters `Male`, `Both`, or `Female`. |
| Gender confidence | Controls how strict gender classification should be. |
| Blur full bodies | Enables person/body detection. |
| Body confidence | Controls how strict person detection should be. |
| Blur strength | Sets the CSS blur radius. |
| Reset | Restores the default settings. |


## Privacy

NoMoreSoyFace is designed to run locally.

The extension requests access to:

- `youtube.com` so it can run on YouTube pages.
- `i.ytimg.com` and `i9.ytimg.com` so it can fetch thumbnails for local analysis.
- `storage.googleapis.com` so TensorFlow.js can load the COCO-SSD body detection model.

It does not include telemetry, analytics, tracking, remote configuration, or image uploads.

## Accuracy Notes

This is useful, but it is not magic.

- Face detection works best on clear, centered faces.
- Gender classification can be wrong, especially with stylized images, heavy makeup, unusual lighting, or low-resolution faces.
- Body detection helps catch thumbnails where the face is small or absent.
- Cartoon, illustrated, heavily edited, or AI-generated thumbnails may be skipped.
- YouTube changes its DOM often, so occasional selector and thumbnail handling updates may be needed.

## Development

Source files live in `src/`. Build scripts and asset hydration live in `scripts/`.

If the generated assets are missing, run:

```bash
npm run prepare-assets
```

To create the extension folders:

```bash
npm run build:chrome    # writes dist/chrome
npm run build:firefox   # writes dist/firefox
npm run build           # both targets
```

The Chrome build uses `src/manifest.json` (Manifest V3 with an offscreen document).
The Firefox build uses `src/manifest-firefox.json` (Manifest V2 with a persistent
background page) and `src/background-firefox.js`, which combines the Chrome
background and offscreen inference into one context. `content.js`, `popup.js`, and
the model/vendor assets are shared between both builds.

To syntax-check the source:

```bash
npm run check
```

## License

MIT. See [LICENSE](./LICENSE).
