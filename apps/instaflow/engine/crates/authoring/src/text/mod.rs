//! Text layout (B2; IF-7.6, IF-21.x): Parley 0.12 shaping (HarfRust), bidi and line breaking over fonts the
//! editor registers (Local Font Access bytes, uploads, curated OFL fonts — never system fonts).
//!
//! A **block** is one text element: paragraphs laid out separately (each has its own alignment and spacing) and
//! stacked. Every index crossing the API is a **UTF-16 code unit** offset into the block text, where paragraphs
//! are joined by one `\n` (what the document stores and what EditContext uses). Parley's UTF-8 offsets never
//! leave this module.
//!
//! Layout output (`encode_layout`, decoded by `apps/instaflow/src/text/layout-result.ts`) is one `f32` array:
//! ```text
//! header     = LAYOUT_VERSION width height paras lines runs glyphs clusters words decorations   (11)
//! paragraph  = u16_start u16_end top bottom rtl first_line                                       (6)
//! line       = para u16_start u16_end x0 x1 top bottom baseline first_cluster cluster_count       (10)
//! run        = line font size brush rtl u16_start u16_end embolden skew first_glyph glyph_count
//!              coord_count coord*                                                                (12 + n)
//! glyph      = id x y cluster                                                                    (4)
//! cluster    = u16_start u16_end line x0 top x1 bottom flags word                                (9)
//! word       = u16_start u16_end line x0 top x1 bottom first_cluster cluster_count               (9)
//! decoration = kind brush line x0 y0 x1 y1                                                      (7)
//! ```
//! Glyph `x, y` are block coordinates of the pen position on the baseline. Clusters are in **logical order**
//! and words are maximal non-space cluster sequences between word boundaries: their indices are stable for
//! a given text and layout, so an animator can target characters, words and lines (IF-21.12).
//! Cluster flags: 1 rtl, 2 whitespace, 4 word start, 8 ligature continuation, 16 hard break, 32 emoji.
//! Decoration kind: 0 underline, 1 strikethrough.

pub mod spec;

use parley::editing::{Cursor, Selection};
use parley::fontique::{Blob, FallbackKey, GenericFamily, Script};
use parley::layout::{Affinity, Alignment, AlignmentOptions, Cluster, IndentOptions, Layout};
use parley::style::{FontFamily, FontStyle, FontWeight, LineHeight, StyleProperty};
use parley::{BaseDirection, BoundingBox, FontContext, FontData, LayoutContext};
use spec::{Align, BlockSpec, Direction, ParagraphSpec};
use std::collections::HashMap;

pub const LAYOUT_VERSION: f32 = 1.0;
pub const HEADER_LEN: usize = 11;
pub const PARAGRAPH_LEN: usize = 6;
pub const LINE_LEN: usize = 10;
pub const RUN_LEN: usize = 12;
pub const GLYPH_LEN: usize = 4;
pub const CLUSTER_LEN: usize = 9;
pub const WORD_LEN: usize = 9;
pub const DECORATION_LEN: usize = 7;

pub mod flags {
    pub const RTL: u32 = 1;
    pub const SPACE: u32 = 2;
    pub const WORD_START: u32 = 4;
    pub const LIGATURE_CONTINUATION: u32 = 8;
    pub const HARD_BREAK: u32 = 16;
    pub const EMOJI: u32 = 32;
}

/// Caret motions for `move_caret` (wire values).
pub mod motion {
    pub const LEFT: u32 = 0;
    pub const RIGHT: u32 = 1;
    pub const WORD_LEFT: u32 = 2;
    pub const WORD_RIGHT: u32 = 3;
    pub const LINE_START: u32 = 4;
    pub const LINE_END: u32 = 5;
    pub const UP: u32 = 6;
    pub const DOWN: u32 = 7;
    pub const TEXT_START: u32 = 8;
    pub const TEXT_END: u32 = 9;
    /// The previous grapheme boundary (Backspace deletes back to it).
    pub const PREV_GRAPHEME: u32 = 10;
    /// The next grapheme boundary (Delete deletes up to it).
    pub const NEXT_GRAPHEME: u32 = 11;
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextError(pub String);

impl std::fmt::Display for TextError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<spec::SpecError> for TextError {
    fn from(e: spec::SpecError) -> Self {
        TextError(e.0)
    }
}

/// A caret or selection rectangle in block coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
}

impl Rect {
    fn from_bbox(b: BoundingBox, dy: f32) -> Rect {
        Rect { x0: b.x0 as f32, y0: b.y0 as f32 + dy, x1: b.x1 as f32, y1: b.y1 as f32 + dy }
    }
}

/// UTF-16 position plus caret affinity (0 downstream, 1 upstream).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub offset: u32,
    pub upstream: bool,
}

struct Paragraph {
    layout: Layout<u32>,
    text: String,
    u16_to_byte: Vec<u32>,
    byte_to_u16: Vec<u32>,
    /// Global UTF-16 offset of the paragraph start.
    start: u32,
    len16: u32,
    top: f32,
    bottom: f32,
    rtl: bool,
}

impl Paragraph {
    fn b2u(&self, b: usize) -> u32 {
        self.byte_to_u16[b.min(self.text.len())]
    }
    fn u2b(&self, u: u32) -> usize {
        self.u16_to_byte[(u as usize).min(self.u16_to_byte.len() - 1)] as usize
    }
    fn cursor(&self, local: u32, upstream: bool) -> Cursor {
        Cursor::from_byte_index(&self.layout, self.u2b(local), if upstream { Affinity::Upstream } else { Affinity::Downstream })
    }
    fn position(&self, c: Cursor) -> Position {
        Position { offset: self.start + self.b2u(c.index()), upstream: c.affinity() == Affinity::Upstream }
    }
    fn caret(&self, local: u32, upstream: bool, width: f32) -> Rect {
        Rect::from_bbox(self.cursor(local, upstream).geometry(&self.layout, width), self.top)
    }
}

/// 64-bit FNV-1a over the font bytes (dedupes re-registration; the editor keys fonts by sha-256 itself).
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h ^ (bytes.len() as u64)
}

fn utf16_maps(text: &str) -> (Vec<u32>, Vec<u32>) {
    let mut u16_to_byte = Vec::with_capacity(text.len() + 1);
    let mut byte_to_u16 = vec![0u32; text.len() + 1];
    let mut u = 0u32;
    for (b, ch) in text.char_indices() {
        for _ in 0..ch.len_utf16() {
            u16_to_byte.push(b as u32);
        }
        for k in 0..ch.len_utf8() {
            byte_to_u16[b + k] = u;
        }
        u += ch.len_utf16() as u32;
    }
    u16_to_byte.push(text.len() as u32);
    byte_to_u16[text.len()] = u;
    (u16_to_byte, byte_to_u16)
}

/// A laid-out text element.
pub struct Block {
    paragraphs: Vec<Paragraph>,
    width: f32,
    height: f32,
    /// The encoded layout (kept so repeated reads are free).
    encoded: Vec<f32>,
}

impl Block {
    /// UTF-16 length of the block text (paragraphs joined by `\n`).
    pub fn len(&self) -> u32 {
        let last = self.paragraphs.last().expect("blocks have a paragraph");
        last.start + last.len16
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn size(&self) -> (f32, f32) {
        (self.width, self.height)
    }

    pub fn encoded(&self) -> &[f32] {
        &self.encoded
    }

    /// Paragraph index and local offset of a global offset (a separator belongs to the paragraph it ends).
    fn locate(&self, offset: u32) -> (usize, u32) {
        for (i, p) in self.paragraphs.iter().enumerate() {
            if offset <= p.start + p.len16 {
                return (i, offset.saturating_sub(p.start));
            }
        }
        let last = self.paragraphs.len() - 1;
        (last, self.paragraphs[last].len16)
    }

    fn paragraph_at_y(&self, y: f32) -> usize {
        for (i, p) in self.paragraphs.iter().enumerate() {
            if y < p.bottom {
                return i;
            }
        }
        self.paragraphs.len() - 1
    }

    /// The caret position closest to a point (block coordinates).
    pub fn hit_test(&self, x: f32, y: f32) -> Position {
        let p = &self.paragraphs[self.paragraph_at_y(y)];
        p.position(Cursor::from_point(&p.layout, x, (y - p.top).clamp(0.0, (p.bottom - p.top).max(0.0))))
    }

    /// Caret rectangle at `offset` (`width` px wide).
    pub fn caret(&self, offset: u32, upstream: bool, width: f32) -> Rect {
        let (i, local) = self.locate(offset);
        self.paragraphs[i].caret(local, upstream, width)
    }

    /// Selection highlight rectangles for `[a, b)` (any order). A selected paragraph break adds a narrow rect
    /// at the end of its line so selected empty paragraphs stay visible.
    pub fn selection_rects(&self, a: u32, b: u32) -> Vec<Rect> {
        let (from, to) = (a.min(b), a.max(b));
        let mut out = Vec::new();
        if from == to {
            return out;
        }
        for p in &self.paragraphs {
            let end = p.start + p.len16;
            if to < p.start || from > end {
                continue;
            }
            let s = from.max(p.start) - p.start;
            let e = to.min(end) - p.start;
            if e > s {
                let sel = Selection::new(p.cursor(s, false), p.cursor(e, true));
                sel.geometry_with(&p.layout, |r, _| out.push(Rect::from_bbox(r, p.top)));
            }
            if to > end && from <= end {
                let c = p.caret(p.len16, true, 0.0);
                let w = ((c.y1 - c.y0) * 0.25).max(2.0);
                let x = if p.rtl { c.x0 - w } else { c.x0 };
                out.push(Rect { x0: x, y0: c.y0, x1: x + w, y1: c.y1 });
            }
        }
        out
    }

    /// One rectangle per UTF-16 code unit of `[a, b)` (EditContext `updateCharacterBounds`). Code units of one
    /// cluster (ligature part, conjunct, surrogate pair) share the cluster's rect; a paragraph break gets a
    /// zero-width rect at the end of its line.
    pub fn char_bounds(&self, a: u32, b: u32) -> Vec<Rect> {
        let mut out = Vec::new();
        let mut u = a;
        let end = b.min(self.len());
        while u < end {
            let (i, local) = self.locate(u);
            let p = &self.paragraphs[i];
            if local >= p.len16 {
                out.push(p.caret(p.len16, true, 0.0));
                u += 1;
                continue;
            }
            let byte = p.u2b(local);
            let (sb, eb) = match Cluster::from_byte_index(&p.layout, byte) {
                Some(c) => (c.text_range().start, c.text_range().end.max(c.text_range().start + 1)),
                None => (byte, byte + 1),
            };
            let sel = Selection::new(
                Cursor::from_byte_index(&p.layout, sb, Affinity::Downstream),
                Cursor::from_byte_index(&p.layout, eb.min(p.text.len()), Affinity::Upstream),
            );
            let mut rect = None;
            sel.geometry_with(&p.layout, |r, _| {
                if rect.is_none() {
                    rect = Some(r);
                }
            });
            let r = rect.map_or_else(|| p.caret(local, false, 0.0), |r| Rect::from_bbox(r, p.top));
            let cluster_end = p.start + p.b2u(eb).max(local + 1);
            while u < cluster_end.min(end) {
                out.push(r);
                u += 1;
            }
        }
        out
    }

    /// The word (or whitespace run) around `offset`, as a UTF-16 range (double-click selection).
    pub fn word_at(&self, offset: u32) -> (u32, u32) {
        let (i, local) = self.locate(offset);
        let p = &self.paragraphs[i];
        if p.len16 == 0 {
            return (p.start, p.start);
        }
        let c = p.caret(local.min(p.len16), false, 1.0);
        let sel = Selection::word_from_point(&p.layout, (c.x0 + c.x1) / 2.0, (c.y0 + c.y1) / 2.0 - p.top);
        let r = sel.text_range();
        (p.start + p.b2u(r.start), p.start + p.b2u(r.end))
    }

    /// Move a caret. `x_hint` keeps the column across `UP`/`DOWN` (pass NaN to use the caret's x).
    pub fn move_caret(&self, from: Position, how: u32, x_hint: f32) -> Position {
        let (i, local) = self.locate(from.offset);
        let p = &self.paragraphs[i];
        let cursor = p.cursor(local, from.upstream);
        let total = self.len();
        let first = &self.paragraphs[0];
        let last = &self.paragraphs[self.paragraphs.len() - 1];
        match how {
            motion::TEXT_START => Position { offset: 0, upstream: false },
            motion::TEXT_END => Position { offset: total, upstream: true },
            motion::LEFT | motion::RIGHT | motion::WORD_LEFT | motion::WORD_RIGHT => {
                let next = match how {
                    motion::LEFT => cursor.previous_visual(&p.layout),
                    motion::RIGHT => cursor.next_visual(&p.layout),
                    motion::WORD_LEFT => cursor.previous_visual_word(&p.layout),
                    _ => cursor.next_visual_word(&p.layout),
                };
                if next.index() != cursor.index() {
                    return p.position(next);
                }
                // At a paragraph edge: step over the paragraph break in logical order. In an RTL paragraph the
                // visual left edge is its logical end.
                let towards_end = matches!(how, motion::RIGHT | motion::WORD_RIGHT) != p.rtl;
                if towards_end && i + 1 < self.paragraphs.len() {
                    Position { offset: self.paragraphs[i + 1].start, upstream: false }
                } else if !towards_end && i > 0 {
                    let prev = &self.paragraphs[i - 1];
                    Position { offset: prev.start + prev.len16, upstream: true }
                } else {
                    from
                }
            }
            motion::LINE_START | motion::LINE_END => {
                let c = p.caret(local, from.upstream, 1.0);
                let y = (c.y0 + c.y1) / 2.0 - p.top;
                let line = Selection::line_from_point(&p.layout, (c.x0 + c.x1) / 2.0, y);
                let r = line.text_range();
                let target = if how == motion::LINE_START { r.start } else { r.end };
                let mut pos = Position { offset: p.start + p.b2u(target), upstream: how == motion::LINE_END };
                // A soft-wrapped line ends before the next line's first character: stay on this line.
                if how == motion::LINE_END && target > r.start && target < p.text.len() && p.text.as_bytes().get(target - 1) == Some(&b' ') {
                    pos.offset -= 1;
                }
                pos
            }
            motion::UP | motion::DOWN => {
                let c = p.caret(local, from.upstream, 1.0);
                let x = if x_hint.is_nan() { c.x0 } else { x_hint };
                let h = (c.y1 - c.y0).max(1.0);
                let y = if how == motion::UP { c.y0 - h * 0.5 } else { c.y1 + h * 0.5 };
                if y < first.top {
                    return Position { offset: 0, upstream: false };
                }
                if y >= last.bottom {
                    return Position { offset: total, upstream: true };
                }
                self.hit_test(x, y)
            }
            motion::PREV_GRAPHEME => {
                if from.offset == 0 {
                    return Position { offset: 0, upstream: false };
                }
                if local == 0 {
                    return Position { offset: from.offset - 1, upstream: true };
                }
                let byte = p.u2b(local);
                let start = Cluster::from_byte_index(&p.layout, byte.saturating_sub(1).min(byte)).map_or(byte - 1, |c| c.text_range().start);
                Position { offset: p.start + p.b2u(start.min(byte - 1)), upstream: false }
            }
            motion::NEXT_GRAPHEME => {
                if from.offset >= total {
                    return Position { offset: total, upstream: true };
                }
                if local >= p.len16 {
                    return Position { offset: from.offset + 1, upstream: false };
                }
                let byte = p.u2b(local);
                let end = Cluster::from_byte_index(&p.layout, byte).map_or(byte + 1, |c| c.text_range().end.max(byte + 1));
                Position { offset: p.start + p.b2u(end), upstream: false }
            }
            _ => from,
        }
    }
}

/// Registered fonts plus the Parley contexts and retained blocks.
pub struct Engine {
    font_cx: FontContext,
    layout_cx: LayoutContext<u32>,
    /// (content digest, face) per font id.
    fonts: Vec<(u64, FontData)>,
    blocks: HashMap<u32, Block>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

/// A CSS family list (`"Noto Sans", sans-serif`); empty means `sans-serif`.
fn family_of(css: &str) -> FontFamily<'_> {
    if css.trim().is_empty() { FontFamily::from(GenericFamily::SansSerif) } else { FontFamily::Source(css.into()) }
}

fn parse_script(tag: &str) -> Result<Script, TextError> {
    tag.parse::<Script>().map_err(|_| TextError(format!("\"{tag}\" is not an ISO 15924 script tag (e.g. Arab, Deva, Latn)")))
}

impl Engine {
    pub fn new() -> Self {
        // `parley` is built without the `system` feature: the collection starts empty and only holds fonts the
        // editor registers (deterministic across machines; IF-7.6).
        Engine { font_cx: FontContext::default(), layout_cx: LayoutContext::new(), fonts: Vec::new(), blocks: HashMap::new() }
    }

    /// Register a font file (OpenType/TrueType, or a collection). Returns one font id per face.
    pub fn add_font(&mut self, bytes: Vec<u8>) -> Result<Vec<u32>, TextError> {
        let digest = fnv1a(&bytes);
        if let Some(first) = self.fonts.iter().position(|(d, _)| *d == digest) {
            // Same bytes again: no second registration (fonts are content-addressed, IF-7.6).
            let count = self.fonts.iter().filter(|(d, _)| *d == digest).count();
            return Ok((first as u32..(first + count) as u32).collect());
        }
        let blob = Blob::from(bytes);
        let id = digest;
        let registered = self.font_cx.collection.register_fonts(blob.clone(), None);
        if registered.is_empty() {
            return Err(TextError("the font file has no usable faces (not OpenType/TrueType?)".into()));
        }
        let faces = registered.iter().flat_map(|(_, infos)| infos.iter()).map(|i| i.index()).max().unwrap_or(0) + 1;
        let mut ids = Vec::new();
        for index in 0..faces {
            self.fonts.push((id, FontData::new(blob.clone(), index)));
            ids.push((self.fonts.len() - 1) as u32);
        }
        Ok(ids)
    }

    /// Family names of every registered font (one per line, registration order, deduplicated).
    pub fn family_names(&mut self) -> Vec<String> {
        self.font_cx.collection.family_names().map(str::to_string).collect()
    }

    pub fn font_count(&self) -> usize {
        self.fonts.len()
    }

    /// Per-script fallback families (S3 lesson: order fallbacks per script, not one long family list).
    pub fn set_fallbacks(&mut self, script: &str, families: &[&str]) -> Result<(), TextError> {
        let script = parse_script(script)?;
        let ids = self.family_ids(families)?;
        self.font_cx.collection.set_fallbacks(FallbackKey::new(script, None), ids.into_iter());
        Ok(())
    }

    /// Families behind the generic `sans-serif` / `serif` / `monospace` names.
    pub fn set_generic(&mut self, generic: &str, families: &[&str]) -> Result<(), TextError> {
        let g = GenericFamily::parse(generic).ok_or_else(|| TextError(format!("unknown generic family \"{generic}\"")))?;
        let ids = self.family_ids(families)?;
        self.font_cx.collection.set_generic_families(g, ids.into_iter());
        Ok(())
    }

    fn family_ids(&mut self, families: &[&str]) -> Result<Vec<parley::fontique::FamilyId>, TextError> {
        families
            .iter()
            .map(|name| self.font_cx.collection.family_id(name).ok_or_else(|| TextError(format!("font family \"{name}\" is not registered"))))
            .collect()
    }

    fn font_id(&self, font: &FontData) -> Option<u32> {
        let blob = font.data.id();
        self.fonts.iter().position(|(_, f)| f.data.id() == blob && f.index == font.index).map(|i| i as u32)
    }

    /// Lay out a block from an encoded spec and retain it under `id` (replacing an earlier one).
    pub fn layout(&mut self, id: u32, spec_bytes: &[u8]) -> Result<&Block, TextError> {
        let spec = spec::decode(spec_bytes)?;
        let block = self.build(&spec)?;
        self.blocks.insert(id, block);
        Ok(&self.blocks[&id])
    }

    pub fn block(&self, id: u32) -> Option<&Block> {
        self.blocks.get(&id)
    }

    pub fn drop_block(&mut self, id: u32) -> bool {
        self.blocks.remove(&id).is_some()
    }

    pub fn block_count(&self) -> usize {
        self.blocks.len()
    }

    fn build_paragraph(&mut self, p: &ParagraphSpec, width: Option<f32>) -> Layout<u32> {
        let (u16_to_byte, _) = utf16_maps(&p.text);
        let byte = |u: u32| u16_to_byte[(u as usize).min(u16_to_byte.len() - 1)] as usize;
        let mut b = self.layout_cx.ranged_builder(&mut self.font_cx, &p.text, 1.0, true);
        b.set_base_direction(match p.direction {
            Direction::Auto => BaseDirection::Auto,
            Direction::Ltr => BaseDirection::Ltr,
            Direction::Rtl => BaseDirection::Rtl,
        });
        let first = &p.spans[0];
        // Defaults come from the first span, so an empty paragraph still has a font size and line height.
        b.push_default(StyleProperty::FontFamily(family_of(&first.family)));
        b.push_default(StyleProperty::FontSize(first.size));
        b.push_default(StyleProperty::Brush(first.brush));
        if p.line_height > 0.0 {
            b.push_default(StyleProperty::LineHeight(LineHeight::FontSizeRelative(p.line_height)));
        }
        for s in &p.spans {
            let range = byte(s.start)..byte(s.end);
            if range.is_empty() {
                continue;
            }
            let family = family_of(&s.family);
            b.push(StyleProperty::FontFamily(family), range.clone());
            b.push(StyleProperty::FontSize(s.size), range.clone());
            b.push(StyleProperty::FontWeight(FontWeight::new(s.weight)), range.clone());
            b.push(StyleProperty::FontStyle(if s.italic { FontStyle::Italic } else { FontStyle::Normal }), range.clone());
            b.push(StyleProperty::Brush(s.brush), range.clone());
            if s.letter_spacing != 0.0 {
                b.push(StyleProperty::LetterSpacing(s.letter_spacing), range.clone());
            }
            if s.underline {
                b.push(StyleProperty::Underline(true), range.clone());
            }
            if s.strike {
                b.push(StyleProperty::Strikethrough(true), range.clone());
            }
            if !s.locale.is_empty() {
                if let Ok(lang) = parley::fontique::Language::parse(&s.locale) {
                    b.push(StyleProperty::Locale(Some(lang)), range.clone());
                }
            }
        }
        let mut layout = b.build(&p.text);
        if p.indent != 0.0 {
            layout.set_text_indent(p.indent, IndentOptions::default());
        }
        layout.break_all_lines(width);
        let alignment = match p.align {
            Align::Start => Alignment::Start,
            Align::Center => Alignment::Center,
            Align::End => Alignment::End,
            Align::Justify => Alignment::Justify,
        };
        layout.align(alignment, AlignmentOptions { align_when_overflowing: false, ..AlignmentOptions::default() });
        layout
    }

    fn build(&mut self, spec: &BlockSpec) -> Result<Block, TextError> {
        let width = if spec.width > 0.0 { Some(spec.width) } else { None };
        let mut paragraphs = Vec::with_capacity(spec.paragraphs.len());
        let mut y = 0.0f32;
        let mut start = 0u32;
        let mut max_width = 0.0f32;
        for (i, p) in spec.paragraphs.iter().enumerate() {
            if i > 0 {
                y += p.space_before;
            }
            let layout = self.build_paragraph(p, width);
            let (u16_to_byte, byte_to_u16) = utf16_maps(&p.text);
            let len16 = (u16_to_byte.len() - 1) as u32;
            let top = y;
            let height = layout.height();
            max_width = max_width.max(layout.width());
            y += height;
            let bottom = y;
            if i + 1 < spec.paragraphs.len() {
                y += p.space_after;
            }
            let rtl = layout.is_rtl();
            paragraphs.push(Paragraph { layout, text: p.text.clone(), u16_to_byte, byte_to_u16, start, len16, top, bottom, rtl });
            start += len16 + 1;
        }
        let mut block = Block { paragraphs, width: width.unwrap_or(max_width), height: y, encoded: Vec::new() };
        block.encoded = self.encode(&block);
        Ok(block)
    }

    fn encode(&self, block: &Block) -> Vec<f32> {
        struct ClusterRec {
            start: u32,
            end: u32,
            line: u32,
            x0: f32,
            top: f32,
            x1: f32,
            bottom: f32,
            flags: u32,
        }
        let mut paragraphs = Vec::new();
        let mut lines = Vec::new();
        let mut runs: Vec<f32> = Vec::new();
        let mut glyphs: Vec<(u32, f32, f32, usize)> = Vec::new(); // id, x, y, visual cluster index
        let mut clusters: Vec<ClusterRec> = Vec::new();
        let mut decorations = Vec::new();
        let mut run_count = 0u32;
        let mut line_index = 0u32;
        for (pi, p) in block.paragraphs.iter().enumerate() {
            paragraphs.extend_from_slice(&[p.start as f32, (p.start + p.len16) as f32, p.top, p.bottom, f32::from(u8::from(p.rtl)), line_index as f32]);
            for line in p.layout.lines() {
                let m = line.metrics();
                let top = p.top + m.block_min_coord;
                let bottom = p.top + m.block_max_coord;
                let baseline = p.top + m.baseline;
                let tr = line.text_range();
                let first_cluster = clusters.len();
                let mut x = m.offset;
                for run in line.runs() {
                    let font_id = self.font_id(run.font()).map_or(-1.0, |f| f as f32);
                    let synthesis = run.synthesis();
                    let coords: Vec<f32> = run.normalized_coords().iter().map(|c| c.to_bits() as f32).collect();
                    let metrics = *run.font_metrics();
                    // Split the shaping run into glyph runs of one style (brush and decorations).
                    let mut segment: Option<(u16, usize, f32, u32, u32)> = None; // style, first glyph, x0, u16 min, u16 max
                    let flush = |seg: Option<(u16, usize, f32, u32, u32)>, x_end: f32, glyphs: &Vec<(u32, f32, f32, usize)>, runs: &mut Vec<f32>, decorations: &mut Vec<f32>, run_count: &mut u32| {
                        let Some((style_index, first_glyph, x0, umin, umax)) = seg else { return };
                        let style = &p.layout.styles()[usize::from(style_index)];
                        runs.extend_from_slice(&[
                            line_index as f32,
                            font_id,
                            run.font_size(),
                            style.brush as f32,
                            f32::from(u8::from(run.is_rtl())),
                            umin as f32,
                            umax as f32,
                            f32::from(u8::from(synthesis.embolden())),
                            synthesis.skew().unwrap_or(0.0),
                            first_glyph as f32,
                            (glyphs.len() - first_glyph) as f32,
                            coords.len() as f32,
                        ]);
                        runs.extend_from_slice(&coords);
                        *run_count += 1;
                        if let Some(u) = &style.underline {
                            let offset = u.offset.unwrap_or(metrics.underline_offset);
                            let size = u.size.unwrap_or(metrics.underline_size).max(0.5);
                            let y0 = baseline - offset - size / 2.0;
                            decorations.extend_from_slice(&[0.0, u.brush as f32, line_index as f32, x0, y0, x_end, y0 + size]);
                        }
                        if let Some(s) = &style.strikethrough {
                            let offset = s.offset.unwrap_or(metrics.strikethrough_offset);
                            let size = s.size.unwrap_or(metrics.strikethrough_size).max(0.5);
                            let y0 = baseline - offset - size / 2.0;
                            decorations.extend_from_slice(&[1.0, s.brush as f32, line_index as f32, x0, y0, x_end, y0 + size]);
                        }
                    };
                    for cluster in run.visual_clusters() {
                        let style_index = cluster.style_index();
                        let ctr = cluster.text_range();
                        let (cu0, cu1) = (p.start + p.b2u(ctr.start), p.start + p.b2u(ctr.end));
                        if segment.is_some_and(|s| s.0 != style_index) {
                            flush(segment.take(), x, &glyphs, &mut runs, &mut decorations, &mut run_count);
                        }
                        let seg = segment.get_or_insert((style_index, glyphs.len(), x, cu0, cu1));
                        seg.3 = seg.3.min(cu0);
                        seg.4 = seg.4.max(cu1);
                        let ci = clusters.len();
                        let mut pen = x;
                        for g in cluster.glyphs() {
                            glyphs.push((g.id, pen + g.x, baseline + g.y, ci));
                            pen += g.advance;
                        }
                        let x1 = x + cluster.advance();
                        let mut f = 0;
                        if cluster.is_rtl() {
                            f |= flags::RTL;
                        }
                        if cluster.is_space_or_nbsp() {
                            f |= flags::SPACE;
                        }
                        if cluster.is_word_boundary() {
                            f |= flags::WORD_START;
                        }
                        if cluster.is_ligature_continuation() {
                            f |= flags::LIGATURE_CONTINUATION;
                        }
                        if cluster.is_hard_line_break() {
                            f |= flags::HARD_BREAK;
                        }
                        if cluster.is_emoji() {
                            f |= flags::EMOJI;
                        }
                        clusters.push(ClusterRec { start: cu0, end: cu1, line: line_index, x0: x.min(x1), top, x1: x.max(x1), bottom, flags: f });
                        x = x1;
                    }
                    flush(segment.take(), x, &glyphs, &mut runs, &mut decorations, &mut run_count);
                }
                lines.extend_from_slice(&[
                    pi as f32,
                    (p.start + p.b2u(tr.start)) as f32,
                    (p.start + p.b2u(tr.end)) as f32,
                    m.offset,
                    m.offset + m.advance,
                    top,
                    bottom,
                    baseline,
                    first_cluster as f32,
                    (clusters.len() - first_cluster) as f32,
                ]);
                line_index += 1;
            }
        }
        // Logical cluster order (stable indices): sort by text position, remap glyphs and line ranges.
        let mut order: Vec<usize> = (0..clusters.len()).collect();
        order.sort_by_key(|&i| (clusters[i].start, clusters[i].end));
        let mut rank = vec![0usize; clusters.len()];
        for (new, &old) in order.iter().enumerate() {
            rank[old] = new;
        }
        for chunk in lines.chunks_exact_mut(LINE_LEN) {
            let first = chunk[8] as usize;
            let count = chunk[9] as usize;
            if count > 0 {
                chunk[8] = (first..first + count).map(|i| rank[i]).min().unwrap_or(0) as f32;
            }
        }
        // Words: maximal runs of non-space clusters, split at word starts and line changes (logical order).
        let mut words: Vec<f32> = Vec::new();
        let mut cluster_word = vec![-1.0f32; clusters.len()];
        let mut current: Option<(usize, usize)> = None; // first sorted index, count
        let close = |cur: Option<(usize, usize)>, words: &mut Vec<f32>, cluster_word: &mut Vec<f32>| {
            let Some((first, count)) = cur else { return };
            let idx = (words.len() / WORD_LEN) as f32;
            let (mut x0, mut x1, mut top, mut bottom) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
            for k in first..first + count {
                let c = &clusters[order[k]];
                x0 = x0.min(c.x0);
                x1 = x1.max(c.x1);
                top = top.min(c.top);
                bottom = bottom.max(c.bottom);
                cluster_word[k] = idx;
            }
            let a = &clusters[order[first]];
            let b = &clusters[order[first + count - 1]];
            words.extend_from_slice(&[a.start as f32, b.end as f32, a.line as f32, x0, top, x1, bottom, first as f32, count as f32]);
        };
        for k in 0..order.len() {
            let c = &clusters[order[k]];
            let space = c.flags & (flags::SPACE | flags::HARD_BREAK) != 0;
            if space {
                close(current.take(), &mut words, &mut cluster_word);
                continue;
            }
            let split = match current {
                Some((first, count)) => {
                    let prev = &clusters[order[first + count - 1]];
                    prev.line != c.line || (c.flags & flags::WORD_START != 0 && c.flags & flags::LIGATURE_CONTINUATION == 0)
                }
                None => false,
            };
            if split {
                close(current.take(), &mut words, &mut cluster_word);
            }
            match &mut current {
                Some((_, count)) => *count += 1,
                None => current = Some((k, 1)),
            }
        }
        close(current.take(), &mut words, &mut cluster_word);

        let mut out = Vec::with_capacity(HEADER_LEN + paragraphs.len() + lines.len() + runs.len() + glyphs.len() * GLYPH_LEN + clusters.len() * CLUSTER_LEN + words.len() + decorations.len());
        out.extend_from_slice(&[
            LAYOUT_VERSION,
            block.width,
            block.height,
            block.paragraphs.len() as f32,
            line_index as f32,
            run_count as f32,
            glyphs.len() as f32,
            clusters.len() as f32,
            (words.len() / WORD_LEN) as f32,
            (decorations.len() / DECORATION_LEN) as f32,
            0.0,
        ]);
        out.extend_from_slice(&paragraphs);
        out.extend_from_slice(&lines);
        out.extend_from_slice(&runs);
        for (id, x, y, ci) in &glyphs {
            out.extend_from_slice(&[*id as f32, *x, *y, rank[*ci] as f32]);
        }
        for (k, &i) in order.iter().enumerate() {
            let c = &clusters[i];
            out.extend_from_slice(&[c.start as f32, c.end as f32, c.line as f32, c.x0, c.top, c.x1, c.bottom, c.flags as f32, cluster_word[k]]);
        }
        out.extend_from_slice(&words);
        out.extend_from_slice(&decorations);
        out
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod fixture;
