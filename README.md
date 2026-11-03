# Superfast Robotics

Source for the company holding page at https://superfastrobotics.com/.

The name-card front's blue and cream starfield is rendered with a small, dependency-free canvas animation. The supplied wordmark is used unchanged. The starfield always animates while the page is visible, regardless of reduced-motion preferences, and pauses while the page is hidden.

Robot Skill Hub is a separate project: https://hub.superfastrobotics.com/.

GitHub Pages serves the static files from `main` at the repository root. No build step, analytics, form, account, or paid service is used. The IBM Plex Mono font is distributed under the included SIL Open Font License.

## Writings

`writings.html` lists demos and experiment notes. `writing-001.html` is an explicitly labeled sample entry with an empty video area and no claimed results. Shared site styles live in `style.css`; the list and article layouts live in `writings.css`.

To publish an entry, duplicate the sample HTML, update its title, date, description and canonical URL, replace the placeholder with the demo video and notes, and add a link to the list. Use a native `<video controls playsinline preload="metadata">` element for uploaded footage. Update the entry count and remove the sample label when the entry contains real work.

`favicon.png` is the supplied SFR icon, used on the home, writings and article pages.
