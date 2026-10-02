# ONECLICK — project context

ONECLICK is an **umbrella software ecosystem**: a set of focused tools that turn complicated digital tasks into simple actions.

**ONE PROBLEM. ONE TOOL. ONE CLICK.**

## Source of truth
`OneClick — Software, simplified.html` in this folder is the current website and the only source file. There is no React/Next.js project. Do not migrate to React/Tailwind/Next unless the owner asks. `backup/` holds the pre-accessibility original; never edit it.

## Current implementation
- One HTML file: inline CSS, vanilla JS, Three.js r128 (cdnjs), Bricolage Grotesque (Google Fonts, 300/500/800)
- Immersive 3D "product universe": core + rings, six orbiting product nodes, particle field, mouse parallax, scroll dolly, click-to-enter zoom + overlay
- Scroll sections: hero, two statements, toolbox rows, Launch simulator, closing line
- **No backend, no build step, no tests, no env vars**
- Run by opening the HTML file (needs internet for the Three.js CDN and fonts)

## Products
| Product | Idea | Status |
|---|---|---|
| Launch | GitHub repo → running application | **Simulated preview only** (`RUNNING (simulated)`); no backend |
| Reframe | UI reference → code → editable/reimagined UI | Concept (node + "Coming soon" only) |
| DevLens | Codebase → interactive visual understanding | Concept |
| Fix | Error → explanation → actionable fix | Concept |
| API | Structured data → API/infrastructure/docs | Concept |
| Convert | Input → transformation → useful output | Concept |

## Do-not-break rules
- Do not redesign, replace the Three.js scene, or remove existing animations
- Keep the dark, minimal, technical, cinematic look and the amber (`--sig`) Launch signal
- No purple gradients, fake testimonials/stats/logos, filler sections, or product-card grids
- Never present Launch (or any concept) as working when it is not
- Keep `prefers-reduced-motion` and keyboard access working
- Extend and refactor carefully; no new dependencies unless necessary

## Docs
`docs/PROJECT_STATE.md`, `DESIGN_SYSTEM.md`, `ARCHITECTURE.md`, `PRODUCT_ROADMAP.md`, `NEXT_STEPS.md`
