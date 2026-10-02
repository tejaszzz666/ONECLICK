# Design system (reverse-engineered from the current file)

## Colour (CSS variables on `:root`)
| Token | Value | Use |
|---|---|---|
| `--bg` | `#050608` | page, fog, WebGL clear colour |
| `--fg` | `#eef1f5` | primary text, primary button |
| `--dim` | `#7d8592` | secondary text, hints |
| `--line` | `#1c2027` | row/card borders |
| `--sig` | `#ffb347` | amber signal: Launch only, "live" state, focus ring, simulator progress |
Other literals: `#3a414c` (ghost button border), `#2a303a` (input/panel border), `#4a515c` (inactive step). Non-Launch nodes use `0x8fa3b8` (steel).

## Typography
Bricolage Grotesque 300 (body), 500 (buttons/labels), 800 (headlines). Headlines use tight tracking (`-.03em` to `-.035em`), line-height ~.92–1, fluid `clamp()` sizes (hero up to 132px, statements up to 84px). Muted second half of a headline uses `--dim` in a `<span>`.

## Layout
Full-bleed dark page over a fixed canvas. Sections use `18vh` vertical padding and `clamp(16px,4vw,40px)` side padding. Toolbox is a bordered row list (3-column grid, collapses under 700px), not cards.

## Components
- **Buttons**: pill (999px), solid light primary, transparent ghost; hover lifts 2px
- **Nav**: fixed, wordmark left, links right; gains a blurred dark background after 40px scroll
- **Status pills** (`em`): outlined; amber-filled for live
- **Simulator**: bordered 14px-radius box on `rgba(10,12,16,.75)`; steps are dots that fill amber
- **Hover panel / overlay**: dark translucent (`.88`/`.9`), thin border, 12px radius
- **Focus**: 2px amber outline, 3px offset

## 3D
- Core: wireframe icosahedron (opacity .35) + white octahedron + three thin torus rings
- Nodes: flat-shaded MeshStandard, metalness .6, roughness .4; Launch emissive .6, others .12; each distinct geometry (octahedron, slab, icosahedron, tetrahedron, hexagonal cylinder, torus knot)
- Link lines core→node, opacity .2 (→.9 on hover)
- Particles: 900 points (350 on small screens), grey, size .03, very slow rotation
- Fog: exponential, `.055`, same colour as background
- Camera: mouse parallax, scroll dolly, lerp `.05`

## Motion
Transitions are short (.2–.5s): button lift, nav background, panel fade/slide, overlay fade `.5s`. Hovered node scales to 1.35 and its orbit slows. `prefers-reduced-motion` disables CSS transitions and all continuous 3D motion.

## Responsive & accessibility
- `clamp()` type, wrap-friendly flex, mobile grid collapse, safe-area insets, lower render cost on small screens
- Canvas is `aria-hidden`; every 3D node has a keyboard equivalent; overlay is a labelled dialog with focus trap; simulator state uses `aria-live`
- Contrast of `--dim` on `--bg` is fine for large text; check small text (13px hints) before shipping
