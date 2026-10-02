# Architecture

## Shape
One static HTML file: `<style>`, markup, then one classic `<script>`. No modules, bundler, router, framework or backend.

## Frontend
- **Data**: the `P` array (name, tagline `t`, quote `q`, `live`, colour, geometry factory) drives 3D nodes, toolbox rows, hover panel, overlay and keyboard buttons. Adding a product means adding one entry.
- **Toolbox rows**: generated from `P` into `#rows`
- **Launch simulator**: form + timed steps; state in the DOM only (`RUNNING (simulated)`)
- **Overlay** (`#world`): filled by `enter(i)`; closed by `closeWorld()`; Tab trap in a `keydown` listener

## 3D
Single `WebGLRenderer` on fixed `#gl` behind the page (`z-index:0`). Objects: `core` group (wireframe, inner mesh, rings), `nodes` (pivot groups holding mesh + link line), `pts` particles. DOM `.label` elements are projected from node positions each frame. The loop in `tick()` handles orbit animation, hover, camera and labels, and skips work when the tab is hidden. Per-frame vectors are preallocated (`tv`, `tgt`, `look`, `zoomOff`, `ptr`, `meshes`).

## State (module-level `let`s)
`hover` (raycast or keyboard focus), `focusIdx` (hidden hero button focus), `zoom` (entered product), `opener` (element to return focus to), `scrollT`, `mouse`/`ptr`.

## Data flow
pointer / focus / click → `hover`/`focusIdx`/`enter(i)` → `zoom` → camera target → after 600ms overlay opens (focus to close button) → `closeWorld()` → focus restored.

## External dependencies
Three.js r128 (cdnjs), Bricolage Grotesque (Google Fonts). Nothing else.

## Deployment assumptions
Static hosting is enough today. A real Launch will need a backend (see roadmap); none exists.

## Intended future layout (conceptual, not built)
```
ONECLICK CORE (tokens, scene primitives, overlay, focus handling)
├── Launch  ├── Reframe  ├── DevLens
└── Fix     ├── API      └── Convert
```
Each product would get its own environment on top of shared primitives. Split the file into modules only when a second surface actually needs the shared code.
