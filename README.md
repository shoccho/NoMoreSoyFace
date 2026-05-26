# NoMoreSoyFace

Blur the thumbnail bait out of YouTube.

NoMoreSoyFace is a Chrome extension that detects faces and people in YouTube thumbnails and blurs them locally in your browser. It is built for people who want to browse by topic, title, and actual interest instead of being pulled around by exaggerated thumbnail expressions.

## Why This Exists

The idea came from a very specific kind of internet fatigue: looking at YouTubers making the same annoying over-the-top expressions on every thumbnail started to feel actively irritating.

It is also kind of the opposite of the old MrBeast-style thumbnail gag extensions, where his expression gets pasted onto everything. NoMoreSoyFace goes the other direction: instead of adding more face chaos to YouTube, it removes the thumbnail bait so the page becomes quieter.

## Features

- **Face blurring**: detects human faces in thumbnails and applies a CSS blur.
- **Body blurring**: detects people in thumbnails, including full-body and half-body shots.
- **Gender mode**: choose `Male`, `Both`, or `Female` for face and body filtering.
- **Adjustable thresholds**: tune face/gender confidence and person detection confidence.
- **Shared model instance**: runs inference through one offscreen extension document instead of loading models in every YouTube tab.
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

NoMoreSoyFace uses a Manifest V3 content script to watch YouTube pages for thumbnail images from `i.ytimg.com`. Candidate thumbnails are queued and sent to a shared offscreen document, where the ML models run.

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

3. Open Chrome and go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select this project folder.
7. Open YouTube and wait for the popup status to show `Ready`.

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

If the generated assets are missing, run:

```bash
npm run prepare-assets
```

To create a Chrome-ready extension folder:

```bash
npm run build:chrome
```

The build output is written to `dist/chrome`. Firefox packaging can be added later as a separate target without changing the Chrome output shape.

## License

MIT. See [LICENSE](./LICENSE).
