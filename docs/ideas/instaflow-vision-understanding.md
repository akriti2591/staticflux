# Idea (parked): vision models for asset understanding and image-aware agent views

**Status:** parked — after the M2 agent-view format lock. Not a Phase 0 spike.

**The idea.** Use any vision-capable model (image in → text out) for the *understanding* side of the editor:
- **Asset library:** auto-tag and categorize uploads; search by content ("the photo with the red car").
- **Agent views:** today an image appears to agents as a file reference only (S8). Add a short cached description
  ("product photo, white background, person on the left") so text-only agents make better layout decisions.
- **Subject selection:** "remove the background behind the person on the right" → the vision model picks *which*
  subject (a box or point); the matte model (S9) does the pixels.
- **Video:** find the moment something happens; pick thumbnails.

**Provider-agnostic.** "Describe image" and "tag asset" are capabilities, not a vendor. Any provider plugs in through
the model-provider contribution point (D7): OpenAI, Anthropic, Gemini, a local server (omlx, Ollama, LM Studio), or
an in-browser model (Chrome built-in AI). The user picks per capability. Same routing as chat models.

**Why it matters which provider the user picks (gating, not code paths):**
- **Privacy:** sending images to a cloud provider needs explicit consent per workspace; local and in-browser keep
  images on the device.
- **Cost:** cloud calls count against spend limits and autonomy-mode budgets (D13); batch tagging can be expensive.
- **Offline:** local or in-browser providers keep tagging working without a network.

**Not this:** pixel-accurate masks. Vision-language models output text (PaliGemma-style coarse masks are too slow and
coarse for video); cutouts stay with dedicated matte models (S9).

**Design notes.** Descriptions are derived data: cached per asset content hash, never stored in the document, never
treated as instructions (same rule as document text in agent views), regenerated when the provider changes.
