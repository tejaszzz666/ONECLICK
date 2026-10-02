# Project state

Single file: `OneClick — Software, simplified.html`. Changes were made by editing source; the page has not yet been run in a browser by the assistant that wrote these docs.

## IMPLEMENTED
- 3D universe: wireframe core, pulsing inner octahedron, 3 rings, 6 product nodes with link lines, particle field, fog
- Mouse parallax, scroll dolly, hover highlight + info panel + labels, click-to-enter camera zoom and product overlay
- Responsive layout, reduced-motion support, lower particle count / pixel ratio on small screens
- Keyboard access: hidden per-product buttons in the hero (focus highlights the 3D node, panel and label; Enter/Space opens) and keyboard-operable toolbox rows
- Overlay: labelled dialog, focus moves in on open, Tab trapped, Escape/button closes, focus returns to the opener (or to the Launch input for the Launch preview)

## PARTIALLY IMPLEMENTED
- Product overlay shows name, tagline and status only; no per-product environment yet
- Toolbox rows open the same overlay as the 3D nodes (the camera zooms while the row is off-screen)

## VISUAL MOCK / DEMO
- **Launch simulator**: timed six-step animation ending in `RUNNING (simulated)`. The URL input is ignored. Nothing is analysed or deployed.

## PLANNED (not built)
- Real Launch backend; Reframe, DevLens, Fix, API, Convert; per-product 3D environments

## Validation
- Build / lint / tests: none exist (no toolchain)
- Manual browser check of the accessibility changes: **not yet done**; do this before relying on them

## Known limitations
- Depends on CDNs (Three.js r128, Google Fonts); the canvas is blank offline
- Three.js r128 is pinned and old; no WebGL fallback
- Hover/click on 3D nodes only works while the hero is on screen
- The hidden hero buttons have no visible focus ring of their own; the 3D highlight and info panel are the indicator
