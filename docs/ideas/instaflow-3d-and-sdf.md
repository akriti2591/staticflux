# Idea (parked): 3D elements and SDF effects in Instaflow

**Status:** parked — out of V1 (owner, 2026-10-24). Revisit after V1. The only V1 work is the cheap door-opener below.

**The idea.** Two new element kinds that live inside 2D designs, not a 3D editor:
- **SDF effects** — soft shadows, glows, smooth outlines, blended/morphing rounded shapes (metaball "gooey" morphs),
  text effects. Small shader passes driven by a few parameters, so they animate well on the timeline.
- **3D elements** — a glTF model with camera and lights, placed on a page/canvas/timeline like any element
  (product spin in a flyer, 3D title in a video).

**Why it fits.** The render worker owns the WebGPU device and ends each frame in our own compositor. Vello tiles
(S1) and video textures (S5) are already just layer sources. A 3D or SDF pass is another source rendering into a
texture. Selection, transforms, timeline, animation, undo, CRDT and agent views work on elements and are unchanged.

**V1 door-opener (do in M1).** Keep the compositor's layer-source interface generic (Vello tiles, video frames,
future 3D/SDF passes plug in the same way). No 3D/SDF code in V1.

**Hard parts.**
- **Shared GPU device (first spike).** Vello runs through wgpu in Wasm; a JS 3D engine (e.g. three.js) creates its
  own `GPUDevice`. Either share one device, render 3D/SDF inside the Rust side, or pay a per-frame texture copy.
- **Export.** SVG/PDF cannot hold live 3D/shaders → rasterize at export DPI (same rule as S7 feature gaps).
  Video/image exports are unaffected.
- **Agent views.** Describe these elements by parameters (model, camera, effect values); agents never edit meshes.
- **Extensions (D7).** No arbitrary extension shader code (a bad shader can hang the GPU). SDF effects are built in
  or exposed to extensions as parameters only.
