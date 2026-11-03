# Superfast Robotics

Source for the company holding page at https://superfastrobotics.com/.

The name-card front's blue and cream starfield is rendered with a small, dependency-free canvas animation. The supplied wordmark is used unchanged. The starfield always animates while the page is visible, regardless of reduced-motion preferences, and pauses while the page is hidden.

Robot Skill Hub is a separate project: https://hub.superfastrobotics.com/.

GitHub Pages serves the static files from `main` at the repository root. No build step, analytics, form, account, or paid service is used. The IBM Plex Mono font is distributed under the included SIL Open Font License.

## Writings

`writings.html` lists demos and experiment notes. `writing-001.html` is an explicitly labeled sample entry with an empty video area and no claimed results. Shared site styles live in `style.css`; the list and article layouts live in `writings.css`.

To publish an entry, duplicate the sample HTML, update its title, date, description and canonical URL, replace the placeholder with the demo video and notes, and add a link to the list. Use a native `<video controls playsinline preload="metadata">` element for uploaded footage. Update the entry count and remove the sample label when the entry contains real work.

`favicon.png` is the supplied SFR icon, used on the home, writings and article pages.

## Demo

`demo.html` is the shareable video page at https://superfastrobotics.com/demo.html. It uses `demo.css`, a native video player with playback and fullscreen controls, and `demo-001-poster.jpg` extracted from the footage. The page has no Writings navigation.

`demo-001.mp4` is a web-delivery copy with H.264 video, AAC audio and fast-start metadata. It retains the full duration, 1920x1080 resolution and 30 fps. Source video files are kept locally.

Add the detailed experiment report below the video figure in `demo.html`, keeping the same URL so existing shared links continue to work.
