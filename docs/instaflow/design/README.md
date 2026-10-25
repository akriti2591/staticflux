# Instaflow visual design: Clean Pop

Approved 2026-10-25. The live canvas (private) is "Instaflow Visual Directions", page **Clean Pop · final**. The
`.dc.html` files here are its source: `Components.dc.html` is the source of truth; `HomeCP`, `ChatCP` and `StudioCP`
are the three surfaces (D17) built only from it. Each file's `renderVals()` holds the component recipes.

## Rules

**Colour**
- Neutrals are cool **mist**: page `#F1F4F7`, canvas `#E4E9EF`, tint `#E7ECF2`, hairline `#DCE3EA`, control edge
  `#7D8897` (≥ 3:1 on white and mist), muted text `#56606C`, ink `#16151A`. No warm off-white.
- **Lens colours** mean a kind of editing, each with a shape: Layout/Canvas tangerine `#FF5C39` square, Pixel
  sunflower `#FFC23D` circle, Video blue `#3D5AFE` wide rounded frame, Flow mint `#00B37E` pill. The logo is the four.
  Dark text on tangerine, sunflower and mint; white on blue.
- **Primary actions** use deep tangerine `#CF3D17` with white text (4.85:1). Bright tangerine is for shapes and tags.
- **Claude** is raspberry `#D6265F` (white text 4.88:1); soft `#FDE8EF` with `#B3174C` text. No purple anywhere.

**Type**: Bricolage Grotesque (display, 700–800) for headings and titles; Geist for UI and body; Geist Mono for
values, codes and tokens.

**Shape**: anything you press is a pill. Cards and mini editors 18 px (composer 22 px), fields 12 px, image
previews 12 px. Selection handles are round.

**Components** (five button variants × three sizes 42 / 34 / 28)

| Variant | Use |
|---|---|
| Primary | The one main action on a surface (Share, New design) |
| Claude | Hands work to the agent (Start making, Send, Accept) |
| Claude soft | Agent action inside a toolbar (✦ Rewrite) |
| Secondary | Everything else; white with the control edge. "Which editor opens" adds a small lens shape |
| Ghost | Dense toolbars and rows |

- **Switchers** (modes, dock tabs, nav, tool pickers, thread list): a mist track with a white selected pill.
- **Tags** are 24 px pills and not pressable: mist (info), pink (Claude), solid lens colour (type), mono (tokens).
  Pressable suggestions are small secondary buttons.
- **Fields**: 34–36 px, 12 px corners, white, control edge.
- **Slider**: 4 px track `#C3CCD7`, deep tangerine fill, 18 px white thumb with a 2 px tangerine ring; value in a mist
  mono pill.
- **Focus**: 2 px deep tangerine outline, 2 px offset, on everything.
- Every text/background pair above meets WCAG 2.2 AA; control edges meet 3:1.
