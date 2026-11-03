# Superfast Robotics

Source for the company holding page at https://superfastrobotics.com/.

The name-card front's blue and cream starfield is rendered with a small, dependency-free canvas animation. The supplied wordmark is used unchanged. The starfield always animates while the page is visible, regardless of reduced-motion preferences, and pauses while the page is hidden.

Robot Skill Hub is a separate project: https://hub.superfastrobotics.com/.

GitHub Pages serves the static files from `main` at the repository root. No build step, analytics, form, account, or paid service is used. The IBM Plex Mono font is distributed under the included SIL Open Font License.

## Writings

`writings.html` lists the research essay *The Little Magic* (`writing-001.html`) and the experiment report *Demo 001 — Our First Magic* (`demo.html`). The homepage navigation link stays hidden; the journal and articles are available by direct link.

The pages are plain HTML. `writings.css` sets the journal typography, section navigation and reading layout. `littlebit-factorization.svg` illustrates low-rank matrix factorization. The site icon is `favicon.png`.

## Demo 001

Keep https://superfastrobotics.com/demo.html stable for shared links. `#footage` opens at the video and `#results` opens at the trial results. The report includes the trial protocol, condition breakdowns and their shared denominator. Add the evaluation photo grid at the marked location in the results section when the images are supplied.

`demo-001.mp4` is the 1920×1080, 30 fps web copy (H.264/AAC, fast-start). The native player uses `demo-001-poster.jpg`; `demo.js` provides the Full screen button where supported. Source video files are kept locally.
