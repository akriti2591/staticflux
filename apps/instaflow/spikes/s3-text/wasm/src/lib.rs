//! S3 spike: Parley text layout behind a tiny hand-written C ABI (no wasm-bindgen).
//!
//! All text indices crossing the ABI are UTF-16 code units (what EditContext uses);
//! Parley works in UTF-8 byte offsets, so we keep both maps.
//! Results are written into a shared f32 output buffer; JS reads `out_ptr()`/`out_len()`.

use std::cell::RefCell;

use parley::editing::{Cursor, Selection};
use parley::layout::{Affinity, Alignment, AlignmentOptions, PositionedLayoutItem};
use parley::style::{FontFamily, StyleProperty};
use parley::{FontContext, FontData, Layout, LayoutContext};

struct State {
    font_cx: FontContext,
    layout_cx: LayoutContext<()>,
    layout: Layout<()>,
    text: String,
    u16_to_byte: Vec<u32>,
    byte_to_u16: Vec<u32>,
    /// blob ids of registered font files, in registration order (index = font id for JS)
    fonts: Vec<(u64, FontData)>,
    family_stack: String,
    width: f32,
    /// distinct variation-coordinate sets seen in runs (index = coords id for JS)
    coords: Vec<Vec<i16>>,
    out: Vec<f32>,
    strbuf: Vec<u8>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let st = s.get_or_insert_with(|| State {
            font_cx: FontContext::default(),
            layout_cx: LayoutContext::new(),
            layout: Layout::new(),
            text: String::new(),
            u16_to_byte: vec![0],
            byte_to_u16: vec![0],
            fonts: Vec::new(),
            family_stack: String::from("sans-serif"),
            width: 0.0,
            coords: vec![Vec::new()],
            out: Vec::new(),
            strbuf: Vec::new(),
        });
        f(st)
    })
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    core::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

unsafe fn take_bytes(ptr: *mut u8, len: usize) -> Vec<u8> {
    Vec::from_raw_parts(ptr, len, len)
}

#[no_mangle]
pub extern "C" fn out_ptr() -> *const f32 {
    with(|s| s.out.as_ptr())
}
#[no_mangle]
pub extern "C" fn out_len() -> usize {
    with(|s| s.out.len())
}
#[no_mangle]
pub extern "C" fn str_ptr() -> *const u8 {
    with(|s| s.strbuf.as_ptr())
}
#[no_mangle]
pub extern "C" fn str_len() -> usize {
    with(|s| s.strbuf.len())
}

/// Register a font file (takes ownership of the bytes). Returns number of faces registered;
/// the family names are written to strbuf separated by '\n'.
#[no_mangle]
pub unsafe extern "C" fn add_font(ptr: *mut u8, len: usize) -> u32 {
    let bytes = take_bytes(ptr, len);
    with(|s| {
        let blob = parley::fontique::Blob::from(bytes);
        let id = blob.id();
        let reg = s.font_cx.collection.register_fonts(blob.clone(), None);
        let mut names = String::new();
        let mut faces = 0;
        for (fam, infos) in &reg {
            if let Some(n) = s.font_cx.collection.family_name(*fam) {
                names.push_str(n);
                names.push('\n');
            }
            faces += infos.len() as u32;
        }
        // one entry per collection index (TTC) so FontData identity is (blob, index)
        let count = reg.iter().flat_map(|(_, i)| i.iter()).map(|i| i.index()).max().unwrap_or(0) + 1;
        for index in 0..count {
            s.fonts.push((id, FontData::new(blob.clone(), index)));
        }
        s.strbuf = names.into_bytes();
        faces
    })
}

/// CSS-like family list, e.g. `"Noto Sans", "Noto Sans Arabic", ...`
#[no_mangle]
pub unsafe extern "C" fn set_family(ptr: *mut u8, len: usize) {
    let bytes = take_bytes(ptr, len);
    with(|s| s.family_stack = String::from_utf8(bytes).unwrap_or_default());
}

fn font_index(s: &State, f: &FontData) -> f32 {
    let id = f.data.id();
    s.fonts
        .iter()
        .position(|(bid, fd)| *bid == id && fd.index == f.index)
        .map(|i| i as f32)
        .unwrap_or(-1.0)
}

fn rebuild_maps(s: &mut State) {
    s.u16_to_byte.clear();
    s.byte_to_u16.clear();
    s.byte_to_u16.resize(s.text.len() + 1, 0);
    let mut u = 0u32;
    for (b, ch) in s.text.char_indices() {
        let n = ch.len_utf16();
        for _ in 0..n {
            s.u16_to_byte.push(b as u32);
        }
        for k in 0..ch.len_utf8() {
            s.byte_to_u16[b + k] = u;
        }
        u += n as u32;
    }
    s.u16_to_byte.push(s.text.len() as u32);
    s.byte_to_u16[s.text.len()] = u;
}

fn b2u(s: &State, b: usize) -> f32 {
    s.byte_to_u16[b.min(s.text.len())] as f32
}
fn u2b(s: &State, u: u32) -> usize {
    s.u16_to_byte[(u as usize).min(s.u16_to_byte.len() - 1)] as usize
}

/// Set text (UTF-8 bytes, ownership taken), shape, break and align.
/// align: 0 start 1 end 2 center 3 justify 4 left 5 right. width<=0 => no wrapping.
/// Writes the layout dump into `out` (see `dump`). Returns number of lines.
#[no_mangle]
pub unsafe extern "C" fn layout(ptr: *mut u8, len: usize, font_size: f32, width: f32, align: u32, dump: u32) -> u32 {
    let bytes = take_bytes(ptr, len);
    with(|s| {
        s.text = String::from_utf8(bytes).unwrap_or_default();
        rebuild_maps(s);
        let fam = s.family_stack.clone();
        let mut b = s.layout_cx.ranged_builder(&mut s.font_cx, &s.text, 1.0, true);
        b.push_default(StyleProperty::FontSize(font_size));
        b.push_default(StyleProperty::FontFamily(FontFamily::Source(fam.as_str().into())));
        b.build_into(&mut s.layout, &s.text);
        s.width = width;
        s.layout.break_all_lines(if width > 0.0 { Some(width) } else { None });
        let a = match align {
            1 => Alignment::End,
            2 => Alignment::Center,
            3 => Alignment::Justify,
            4 => Alignment::Left,
            5 => Alignment::Right,
            _ => Alignment::Start,
        };
        s.layout.align(a, AlignmentOptions::default());
        if dump != 0 {
            dump_layout(s);
        }
        s.layout.len() as u32
    })
}

/// out = [width, height, nLines, (per line: baseline, lineHeight, top, bottom, offset, advance,
///        u16Start, u16End, nRuns, (per run: fontIdx, coordsId, fontSize, rtl, u16Start, u16End, nGlyphs,
///        (per glyph: id, x, y, advance)...)...)...]
fn dump_layout(s: &mut State) {
    let mut out = core::mem::take(&mut s.out);
    out.clear();
    out.push(s.layout.width());
    out.push(s.layout.height());
    out.push(s.layout.len() as f32);
    for line in s.layout.lines() {
        let m = line.metrics();
        let tr = line.text_range();
        out.extend_from_slice(&[m.baseline, m.line_height, m.block_min_coord, m.block_max_coord, m.offset, m.advance]);
        out.push(b2u(s, tr.start));
        out.push(b2u(s, tr.end));
        let nruns_at = out.len();
        out.push(0.0);
        let mut nruns = 0;
        for item in line.items() {
            if let PositionedLayoutItem::GlyphRun(gr) = item {
                let run = gr.run();
                let rtr = run.text_range();
                out.push(font_index(s, run.font()));
                let c: Vec<i16> = run.normalized_coords().iter().map(|c| c.to_bits()).collect();
                let cid = match s.coords.iter().position(|x| *x == c) {
                    Some(i) => i,
                    None => { s.coords.push(c); s.coords.len() - 1 }
                };
                out.push(cid as f32);
                out.push(run.font_size());
                out.push(if run.is_rtl() { 1.0 } else { 0.0 });
                out.push(b2u(s, rtr.start));
                out.push(b2u(s, rtr.end));
                let ng_at = out.len();
                out.push(0.0);
                let mut ng = 0;
                for g in gr.positioned_glyphs() {
                    out.extend_from_slice(&[g.id as f32, g.x, g.y, g.advance]);
                    ng += 1;
                }
                out[ng_at] = ng as f32;
                nruns += 1;
            }
        }
        out[nruns_at] = nruns as f32;
    }
    s.out = out;
}

fn aff(a: u32) -> Affinity {
    if a == 1 { Affinity::Upstream } else { Affinity::Downstream }
}

/// Hit test: out = [u16Index, affinity]. Returns u16 index.
#[no_mangle]
pub extern "C" fn hit_test(x: f32, y: f32) -> u32 {
    with(|s| {
        let c = Cursor::from_point(&s.layout, x, y);
        let u = b2u(s, c.index());
        s.out.clear();
        s.out.push(u);
        s.out.push(if c.affinity() == Affinity::Upstream { 1.0 } else { 0.0 });
        u as u32
    })
}

/// Caret rect for a u16 index: out = [x0, y0, x1, y1]
#[no_mangle]
pub extern "C" fn caret_rect(u: u32, affinity: u32, caret_width: f32) {
    with(|s| {
        let c = Cursor::from_byte_index(&s.layout, u2b(s, u), aff(affinity));
        let r = c.geometry(&s.layout, caret_width);
        s.out.clear();
        s.out.extend_from_slice(&[r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32]);
    })
}

/// Selection rects between u16 indices: out = [n, (x0,y0,x1,y1)*n]
#[no_mangle]
pub extern "C" fn selection_rects(a: u32, b: u32) -> u32 {
    with(|s| {
        let sel = Selection::new(
            Cursor::from_byte_index(&s.layout, u2b(s, a), Affinity::Downstream),
            Cursor::from_byte_index(&s.layout, u2b(s, b), Affinity::Upstream),
        );
        let mut out = core::mem::take(&mut s.out);
        out.clear();
        out.push(0.0);
        let mut n = 0;
        sel.geometry_with(&s.layout, |r, _| {
            out.extend_from_slice(&[r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32]);
            n += 1;
        });
        out[0] = n as f32;
        s.out = out;
        n
    })
}

/// Per-UTF-16-code-unit bounds for [a, b) (EditContext.updateCharacterBounds wants one rect per
/// code unit). Code units inside one cluster (ligature, conjunct, surrogate pair) share the cluster rect.
/// out = [(x0,y0,x1,y1) * (b-a)]
#[no_mangle]
pub extern "C" fn char_bounds(a: u32, b: u32) {
    with(|s| {
        let mut out = core::mem::take(&mut s.out);
        out.clear();
        let mut u = a;
        while u < b {
            let byte = u2b(s, u);
            let cl = parley::layout::Cluster::from_byte_index(&s.layout, byte);
            let (start_b, end_b) = match &cl {
                Some(c) => (c.text_range().start, c.text_range().end.max(c.text_range().start + 1)),
                None => (byte, byte + 1),
            };
            let sel = Selection::new(
                Cursor::from_byte_index(&s.layout, start_b, Affinity::Downstream),
                Cursor::from_byte_index(&s.layout, end_b.min(s.text.len()), Affinity::Upstream),
            );
            let mut rect = None;
            sel.geometry_with(&s.layout, |r, _| {
                if rect.is_none() {
                    rect = Some(r);
                }
            });
            let r = rect.unwrap_or_else(|| {
                Cursor::from_byte_index(&s.layout, byte, Affinity::Downstream).geometry(&s.layout, 1.0)
            });
            let end_u = b2u(s, end_b) as u32;
            let mut k = u;
            while k < end_u.max(u + 1) && k < b {
                out.extend_from_slice(&[r.x0 as f32, r.y0 as f32, r.x1 as f32, r.y1 as f32]);
                k += 1;
            }
            u = k;
        }
        s.out = out;
    })
}

#[cfg(feature = "outlines")]
mod outlines {
    use super::*;
    use skrifa::instance::{LocationRef, Size};
    use skrifa::outline::{DrawSettings, OutlinePen};
    use skrifa::{FontRef, GlyphId, MetadataProvider};
    use std::fmt::Write;

    struct SvgPen<'a>(&'a mut String);
    impl OutlinePen for SvgPen<'_> {
        fn move_to(&mut self, x: f32, y: f32) {
            let _ = write!(self.0, "M{x:.2} {:.2}", -y);
        }
        fn line_to(&mut self, x: f32, y: f32) {
            let _ = write!(self.0, "L{x:.2} {:.2}", -y);
        }
        fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
            let _ = write!(self.0, "Q{cx0:.2} {:.2} {x:.2} {:.2}", -cy0, -y);
        }
        fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
            let _ = write!(self.0, "C{cx0:.2} {:.2} {cx1:.2} {:.2} {x:.2} {:.2}", -cy0, -cy1, -y);
        }
        fn close(&mut self) {
            self.0.push('Z');
        }
    }

    /// SVG path (y down) for a glyph at `size` px, written to strbuf. Returns 0 if no outline
    /// (e.g. bitmap emoji).
    #[no_mangle]
    pub extern "C" fn glyph_path(font: u32, glyph: u32, size: f32, coords: u32) -> u32 {
        with(|s| {
            let mut path = String::new();
            if let Some((_, fd)) = s.fonts.get(font as usize) {
                if let Ok(f) = FontRef::from_index(fd.data.data(), fd.index) {
                    let c: Vec<skrifa::instance::NormalizedCoord> = s.coords.get(coords as usize).map(|v| v.iter().map(|b| skrifa::instance::NormalizedCoord::from_bits(*b)).collect()).unwrap_or_default();
                    if let Some(g) = f.outline_glyphs().get(GlyphId::new(glyph)) {
                        let _ = g.draw(DrawSettings::unhinted(Size::new(size), LocationRef::new(&c)), &mut SvgPen(&mut path));
                    }
                }
            }
            s.strbuf = path.into_bytes();
            s.strbuf.len() as u32
        })
    }
}
