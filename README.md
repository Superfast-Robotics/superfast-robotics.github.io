# Superfast Robotics

Source for the company holding page at https://superfastrobotics.com/.

The name-card front's blue and cream starfield is rendered with a small, dependency-free canvas animation. The supplied wordmark is used unchanged. The starfield always animates while the page is visible, regardless of reduced-motion preferences, and pauses while the page is hidden.

Robot Skill Hub is a separate project: https://hub.superfastrobotics.com/.

GitHub Pages serves the static files from `main` at the repository root. No build step, analytics, form, account, or paid service is used. The IBM Plex Mono font is distributed under the included SIL Open Font License.

## Writings

The homepage links to the index at `writings/index.html` (`/writings/`). The articles are `writings/essay-001.html` and `writings/demo-001.html`. GitHub Pages serves their public URLs without the extension. The old root HTML pages redirect to the new URLs, preserving query strings and fragments in the browser. Each article includes references and a downloadable BibTeX entry alongside its HTML file.

The pages are plain HTML. `writings.css` sets the journal typography, section navigation and reading layout. `littlebit-factorization.svg` illustrates low-rank matrix factorization. The site icon is `favicon.png`.

## Demo 001

The experiment is at https://superfastrobotics.com/writings/demo-001. `#footage` opens at the video, `#setups` at the 18 photographed evaluation conditions, and `#results` at the trial results section. The grid groups photographs by location, fruit and basket shape. The 640×360 thumbnails in `assets/` end in `-sm.webp`; each links to the 1920×1080 version with the same stem.

`demo-001.mp4` is the 1920×1080, 30 fps web copy (H.264/AAC, fast-start). The native player uses `demo-001-poster.jpg`; `demo.js` provides the Full screen button where supported. Source video files are kept locally.
