# gkpv — gk photo viewer

A lightweight, single-file photo browser that runs entirely in the browser. No server, no dependencies, no build step.

## Features

- **Local folder access** — select any directory on your machine using the browser's File System Access API
- **Thumbnail grid** — responsive grid with three size options (S / M / L)
- **Justified layout** — toggle between grid and justified (natural aspect ratio) layouts; justified mode fills rows to a target height for a magazine-style look
- **Virtual scrolling** — only visible rows are rendered in the DOM, enabling smooth scrolling through folders with thousands of images at low memory cost
- **Smart thumbnails** — images are downsized (max 640px) for fast grid rendering; thumbnails are generated on-demand as rows scroll into view
- **Persistent caching** — thumbnails and aspect ratios are cached in the Origin Private File System (OPFS) so they load instantly on revisit; cache keys include file size and modification time for automatic invalidation
- **Shimmer placeholders** — animated loading indicators while thumbnails generate, with smooth fade-in on completion
- **Lightbox viewer** — click any image to view full-size with keyboard navigation (arrow keys, Esc); full-resolution images are loaded on demand
- **Lightbox zoom & pan** — scroll wheel to zoom toward cursor, click to toggle fit/100%, drag to pan when zoomed in; pinch zoom and double-tap on touch devices; `+`/`-`/`0` keyboard shortcuts
- **Image preloading** — previous and next images are preloaded in the background for instant lightbox navigation
- **EXIF info panel** — press **I** in the lightbox to see file details and JPEG EXIF metadata (camera, lens, exposure, ISO, focal length, date taken)
- **Image info tooltip** — hover over any thumbnail to see filename, dimensions, file size, and date
- **Folder preview thumbnails** — folder cards show a 2×2 mosaic of the first four images instead of a generic icon
- **Directory browsing** — navigate into subdirectories with breadcrumb navigation
- **Sorting** — sort by name or date (ascending/descending)
- **Cache management** — Clear Cache button in the toolbar to force thumbnail regeneration

## Usage

Open `gkpv.html` in a Chromium-based browser (Chrome, Edge, Brave) and click **Open Folder** to select a photo directory.

> **Note:** The File System Access API is not supported in Firefox or Safari.

## License

MIT
