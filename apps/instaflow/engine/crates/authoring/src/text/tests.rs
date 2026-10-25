//! Host tests for text layout (fonts: `apps/instaflow/test/fonts`, OFL subsets of Noto).
use super::spec::{Align, Direction, ParagraphSpec, SpecWriter, simple_paragraph};
use super::*;
use std::path::PathBuf;

pub(crate) fn font(name: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/fonts").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

pub(crate) const STACK: &str = "\"Noto Sans\", \"Noto Sans Arabic\", \"Noto Sans Devanagari\"";

pub(crate) fn engine() -> Engine {
    let mut e = Engine::new();
    for f in ["NotoSans-Latin.wght.ttf", "NotoSansArabic.wght.ttf", "NotoSansDevanagari.wght.ttf", "NotoSansThai.wght.ttf"] {
        assert_eq!(e.add_font(font(f)).unwrap().len(), 1);
    }
    e.set_fallbacks("Arab", &["Noto Sans Arabic"]).unwrap();
    e.set_fallbacks("Deva", &["Noto Sans Devanagari"]).unwrap();
    e.set_fallbacks("Thai", &["Noto Sans Thai"]).unwrap();
    e.set_generic("sans-serif", &["Noto Sans"]).unwrap();
    e
}

pub(crate) fn spec(width: f32, paragraphs: &[ParagraphSpec]) -> Vec<u8> {
    let mut w = SpecWriter::new(width);
    for p in paragraphs {
        w.paragraph(p);
    }
    w.finish()
}

/// Decoded view of the encoded layout (mirrors layout-result.ts).
pub(crate) struct Decoded {
    pub header: Vec<f32>,
    pub paragraphs: Vec<Vec<f32>>,
    pub lines: Vec<Vec<f32>>,
    pub runs: Vec<(Vec<f32>, Vec<f32>)>,
    pub glyphs: Vec<Vec<f32>>,
    pub clusters: Vec<Vec<f32>>,
    pub words: Vec<Vec<f32>>,
    pub decorations: Vec<Vec<f32>>,
}

pub(crate) fn decode_layout(v: &[f32]) -> Decoded {
    let h = v[..HEADER_LEN].to_vec();
    let mut at = HEADER_LEN;
    let mut take = |n: usize, len: usize| -> Vec<Vec<f32>> {
        let out = (0..n).map(|i| v[at + i * len..at + (i + 1) * len].to_vec()).collect();
        at += n * len;
        out
    };
    let paragraphs = take(h[3] as usize, PARAGRAPH_LEN);
    let lines = take(h[4] as usize, LINE_LEN);
    let mut runs = Vec::new();
    for _ in 0..h[5] as usize {
        let fixed = v[at..at + RUN_LEN].to_vec();
        let n = fixed[11] as usize;
        let coords = v[at + RUN_LEN..at + RUN_LEN + n].to_vec();
        at += RUN_LEN + n;
        runs.push((fixed, coords));
    }
    let mut take = |n: usize, len: usize| -> Vec<Vec<f32>> {
        let out = (0..n).map(|i| v[at + i * len..at + (i + 1) * len].to_vec()).collect();
        at += n * len;
        out
    };
    let glyphs = take(h[6] as usize, GLYPH_LEN);
    let clusters = take(h[7] as usize, CLUSTER_LEN);
    let words = take(h[8] as usize, WORD_LEN);
    let decorations = take(h[9] as usize, DECORATION_LEN);
    assert_eq!(at, v.len(), "layout encoding has trailing data");
    Decoded { header: h, paragraphs, lines, runs, glyphs, clusters, words, decorations }
}

fn para(text: &str) -> ParagraphSpec {
    simple_paragraph(text, STACK, 20.0)
}

#[test]
fn rejects_unknown_scripts_and_families() {
    let mut e = Engine::new();
    assert!(e.set_fallbacks("Xyzzy", &[]).is_err());
    assert!(e.set_fallbacks("Arab", &["Missing"]).unwrap_err().0.contains("not registered"));
    assert!(e.set_generic("fancy", &[]).is_err());
    assert!(e.add_font(vec![1, 2, 3]).is_err());
    assert!(e.layout(1, b"bad").is_err());
}

#[test]
fn registers_fonts_once_per_face() {
    let mut e = engine();
    assert_eq!(e.font_count(), 4);
    assert_eq!(e.add_font(font("NotoSans-Latin.wght.ttf")).unwrap(), vec![0]);
    assert_eq!(e.font_count(), 4);
    let names = e.family_names();
    for n in ["Noto Sans", "Noto Sans Arabic", "Noto Sans Devanagari", "Noto Sans Thai"] {
        assert!(names.iter().any(|x| x == n), "{names:?}");
    }
}

#[test]
fn lays_out_glyph_runs_lines_and_paragraphs() {
    let mut e = engine();
    let block = e.layout(7, &spec(120.0, &[para("Hello world, this wraps"), para(""), para("مرحبا بالعالم")])).unwrap();
    let d = decode_layout(block.encoded());
    assert_eq!(d.header[0], LAYOUT_VERSION);
    assert_eq!(d.paragraphs.len(), 3);
    assert!(d.lines.len() >= 4, "wrapped first paragraph, empty one, arabic: {}", d.lines.len());
    // paragraph ranges are joined by one separator each
    assert_eq!(d.paragraphs[0][..2], [0.0, 23.0]);
    assert_eq!(d.paragraphs[1][..2], [24.0, 24.0]);
    assert_eq!(d.paragraphs[2][..2], [25.0, 38.0]);
    assert_eq!(d.paragraphs[2][4], 1.0, "arabic paragraph is rtl");
    // paragraphs stack without overlap
    assert!(d.paragraphs[1][2] >= d.paragraphs[0][3] - 0.01 && d.paragraphs[2][2] >= d.paragraphs[1][3] - 0.01);
    assert!(d.paragraphs[1][3] > d.paragraphs[1][2], "an empty paragraph keeps its line height");
    // every glyph belongs to a run, every run has a known font and a valid glyph range
    let glyphs: usize = d.runs.iter().map(|(r, _)| r[10] as usize).sum();
    assert_eq!(glyphs, d.glyphs.len());
    for (r, coords) in &d.runs {
        assert!(r[1] >= 0.0 && r[1] < 4.0, "font id {}", r[1]);
        assert!(coords.len() <= 1, "at most the wght coordinate");
    }
    // the Arabic run uses the Arabic font (fallback per script)
    let arabic: Vec<_> = d.runs.iter().filter(|(r, _)| r[5] >= 25.0).collect();
    assert!(arabic.iter().any(|(r, _)| r[1] == 1.0 && r[4] == 1.0));
    assert_eq!(e.block_count(), 1);
    assert!(e.drop_block(7));
    assert!(!e.drop_block(7));
}

#[test]
fn glyph_positions_match_parley_positioned_glyphs() {
    let mut e = engine();
    let text = "Type: नमस्ते और مرحبا";
    let block = e.layout(1, &spec(0.0, &[para(text)])).unwrap();
    let d = decode_layout(block.encoded());
    let mut expected = Vec::new();
    for line in block.paragraphs[0].layout.lines() {
        for item in line.items() {
            if let parley::layout::PositionedLayoutItem::GlyphRun(gr) = item {
                for g in gr.positioned_glyphs() {
                    expected.push((g.id, g.x, g.y));
                }
            }
        }
    }
    assert_eq!(expected.len(), d.glyphs.len());
    for (a, b) in expected.iter().zip(&d.glyphs) {
        assert_eq!(a.0 as f32, b[0]);
        assert!((a.1 - b[1]).abs() < 0.01 && (a.2 - b[2]).abs() < 0.01, "{a:?} vs {b:?}");
    }
}

#[test]
fn clusters_words_and_lines_have_stable_logical_indices() {
    let mut e = engine();
    let bytes = spec(100.0, &[para("one two three four"), para("پنج شش")]);
    let first = decode_layout(e.layout(1, &bytes).unwrap().encoded());
    let again = decode_layout(e.layout(2, &bytes).unwrap().encoded());
    assert_eq!(first.clusters, again.clusters);
    assert_eq!(first.words, again.words);
    // clusters are in logical order and cover the text except separators
    let starts: Vec<f32> = first.clusters.iter().map(|c| c[0]).collect();
    let mut sorted = starts.clone();
    sorted.sort_by(f32::total_cmp);
    assert_eq!(starts, sorted);
    let words: Vec<(u32, u32)> = first.words.iter().map(|w| (w[0] as u32, w[1] as u32)).collect();
    assert_eq!(words, vec![(0, 3), (4, 7), (8, 13), (14, 18), (19, 22), (23, 25)]);
    // each word's clusters point back at it; each glyph's cluster is in range
    for (wi, w) in first.words.iter().enumerate() {
        for k in w[7] as usize..(w[7] + w[8]) as usize {
            assert_eq!(first.clusters[k][8], wi as f32);
        }
    }
    for g in &first.glyphs {
        assert!((g[3] as usize) < first.clusters.len());
    }
    // lines list their clusters
    let total: f32 = first.lines.iter().map(|l| l[9]).sum();
    assert_eq!(total as usize, first.clusters.len());
    assert!(first.lines.len() >= 3, "wraps at 100 px");
    // RTL words are flagged rtl
    assert!(first.clusters.iter().filter(|c| c[0] >= 19.0).all(|c| c[7] as u32 & flags::RTL != 0));
}

#[test]
fn styles_split_runs_and_emit_decorations() {
    let mut e = engine();
    let mut p = para("bold under strike");
    let base = p.spans[0].clone();
    p.spans = vec![
        SpanSpec { end: 4, weight: 700.0, brush: 1, ..base.clone() },
        SpanSpec { start: 4, end: 11, underline: true, brush: 2, ..base.clone() },
        SpanSpec { start: 11, end: 17, strike: true, brush: 3, italic: true, ..base.clone() },
    ];
    let d = decode_layout(e.layout(1, &spec(0.0, &[p])).unwrap().encoded());
    let brushes: Vec<f32> = d.runs.iter().map(|(r, _)| r[3]).collect();
    assert_eq!(brushes, vec![1.0, 2.0, 3.0]);
    // bold run uses the wght axis at 700 (normalized 1.0 = 16384 in F2Dot14)
    assert!(d.runs[0].1.first().copied().unwrap_or(0.0) > 0.0 && d.runs[1].1.iter().all(|c| *c == 0.0), "{:?}", d.runs);
    // the italic run has no italic face: synthesized skew
    assert!(d.runs[2].0[8] != 0.0, "italic is synthesized: {:?}", d.runs[2].0);
    let kinds: Vec<(f32, f32)> = d.decorations.iter().map(|x| (x[0], x[1])).collect();
    assert_eq!(kinds, vec![(0.0, 2.0), (1.0, 3.0)]);
    let baseline = d.lines[0][7];
    assert!(d.decorations[0][4] > baseline, "underline below the baseline");
    assert!(d.decorations[1][6] < baseline, "strikethrough above the baseline");
}

use super::spec::SpanSpec;

#[test]
fn alignment_and_spacing() {
    let mut e = engine();
    let mut center = para("Hi");
    center.align = Align::Center;
    let mut end = para("Hi");
    end.align = Align::End;
    end.space_before = 10.0;
    let d = decode_layout(e.layout(1, &spec(200.0, &[para("Hi"), center, end])).unwrap().encoded());
    let x0: Vec<f32> = d.lines.iter().map(|l| l[3]).collect();
    assert!(x0[0] < 1.0 && x0[1] > 80.0 && x0[1] < 100.0 && x0[2] > 170.0, "{x0:?}");
    assert!((d.paragraphs[2][2] - d.paragraphs[1][3] - 10.0).abs() < 0.01);
    let mut rtl = para("abc");
    rtl.direction = Direction::Rtl;
    let d = decode_layout(e.layout(2, &spec(200.0, &[rtl])).unwrap().encoded());
    assert!(d.lines[0][3] > 150.0, "rtl base direction starts at the right");
    let mut indented = para("indented first line wraps here");
    indented.indent = 24.0;
    let d = decode_layout(e.layout(3, &spec(150.0, &[indented])).unwrap().encoded());
    assert!((d.lines[0][3] - 24.0).abs() < 0.01 && d.lines[1][3] < 0.01);
}

#[test]
fn caret_hit_test_round_trip() {
    // S3: caret rect → hit test → the same visual position, for every index (cluster-internal indices snap).
    let mut e = engine();
    let texts = ["Hello, world", "مرحبا بالعالم", "नमस्ते दुनिया", "abc مرحبا 123 def", "क्षत्रिय"];
    let paragraphs: Vec<ParagraphSpec> = texts.iter().map(|t| para(t)).collect();
    let block = e.layout(1, &spec(160.0, &paragraphs)).unwrap();
    let mut exact = 0;
    let mut checked = 0;
    for offset in 0..=block.len() {
        for upstream in [false, true] {
            let c = block.caret(offset, upstream, 1.0);
            let hit = block.hit_test((c.x0 + c.x1) / 2.0, (c.y0 + c.y1) / 2.0);
            let back = block.caret(hit.offset, hit.upstream, 1.0);
            checked += 1;
            assert!((back.x0 - c.x0).abs() < 1.0 && (back.y0 - c.y0).abs() < 1.0, "offset {offset}/{upstream}: {c:?} → {hit:?} → {back:?}");
            if hit.offset == offset {
                exact += 1;
            }
        }
    }
    assert!(exact * 10 >= checked * 7, "most indices are exact: {exact}/{checked}");
}

#[test]
fn selection_and_char_bounds() {
    let mut e = engine();
    let block = e.layout(1, &spec(0.0, &[para("ab"), para(""), para("مرحبا")])).unwrap();
    assert!(block.selection_rects(1, 1).is_empty());
    let one = block.selection_rects(0, 2);
    assert_eq!(one.len(), 1);
    // across the empty paragraph: break markers keep it visible
    let across = block.selection_rects(4, 0);
    assert!(across.len() >= 3, "{across:?}");
    let bounds = block.char_bounds(0, block.len());
    assert_eq!(bounds.len() as u32, block.len());
    assert!(bounds[0].x1 <= bounds[1].x0 + 0.01, "LTR left to right");
    assert_eq!(bounds[2].x0, bounds[2].x1, "the paragraph break is zero width");
    // Arabic composition bounds run right to left (S3)
    let ar: Vec<Rect> = bounds[4..9].to_vec();
    assert!(ar[0].x0 >= ar[4].x1 - 0.01, "{ar:?}");
    // surrogate pairs share one rect
    let emoji = e.layout(2, &spec(0.0, &[para("a😀b")])).unwrap();
    let b = emoji.char_bounds(0, 4);
    assert_eq!(b.len(), 4);
    assert_eq!(b[1], b[2]);
}

#[test]
fn caret_motions() {
    let mut e = engine();
    let block = e.layout(1, &spec(90.0, &[para("one two three"), para("x")])).unwrap();
    let at = |o: u32| Position { offset: o, upstream: false };
    assert_eq!(block.move_caret(at(0), motion::RIGHT, f32::NAN).offset, 1);
    assert_eq!(block.move_caret(at(0), motion::LEFT, f32::NAN).offset, 0);
    assert_eq!(block.move_caret(at(13), motion::RIGHT, f32::NAN).offset, 14, "steps over the paragraph break");
    assert_eq!(block.move_caret(at(14), motion::LEFT, f32::NAN).offset, 13);
    assert_eq!(block.move_caret(at(0), motion::WORD_RIGHT, f32::NAN).offset, 3);
    assert_eq!(block.move_caret(at(5), motion::TEXT_END, f32::NAN).offset, 15);
    assert_eq!(block.move_caret(at(5), motion::TEXT_START, f32::NAN).offset, 0);
    // 90 px wraps "one two | three": line starts and ends
    assert_eq!(block.move_caret(at(5), motion::LINE_START, f32::NAN).offset, 0);
    assert_eq!(block.move_caret(at(10), motion::LINE_START, f32::NAN).offset, 8);
    assert_eq!(block.move_caret(at(1), motion::LINE_END, f32::NAN).offset, 7);
    assert_eq!(block.move_caret(at(9), motion::LINE_END, f32::NAN).offset, 13);
    let down = block.move_caret(at(1), motion::DOWN, f32::NAN);
    assert!(down.offset > 3, "moved to the next line: {down:?}");
    let up = block.move_caret(down, motion::UP, block.caret(1, false, 1.0).x0);
    assert_eq!(up.offset, 1);
    assert_eq!(block.move_caret(at(1), motion::UP, f32::NAN).offset, 0);
    assert_eq!(block.move_caret(at(14), motion::DOWN, f32::NAN).offset, 15);
    assert_eq!(block.move_caret(at(14), motion::PREV_GRAPHEME, f32::NAN).offset, 13);
    assert_eq!(block.move_caret(at(13), motion::NEXT_GRAPHEME, f32::NAN).offset, 14);
    assert_eq!(block.word_at(5), (4, 7));
    let deva = e.layout(2, &spec(0.0, &[para("क्षा")])).unwrap();
    // the conjunct + matra is one grapheme cluster: Backspace from the end removes it all
    assert_eq!(deva.move_caret(at(4), motion::PREV_GRAPHEME, f32::NAN).offset, 0);
    let pair = e.layout(3, &spec(0.0, &[para("a😀")])).unwrap();
    assert_eq!(pair.move_caret(at(3), motion::PREV_GRAPHEME, f32::NAN).offset, 1);
    assert_eq!(pair.move_caret(at(1), motion::NEXT_GRAPHEME, f32::NAN).offset, 3);
}

#[test]
fn thai_needs_complex_scripts_to_wrap() {
    // S3 surprise 1: without the dictionary segmenter a Thai paragraph does not wrap at all.
    let mut e = engine();
    let thai = "ภาษาไทยเป็นภาษาที่สวยงามมากและมีประวัติศาสตร์ยาวนาน";
    let d = decode_layout(e.layout(1, &spec(200.0, &[para(thai)])).unwrap().encoded());
    if cfg!(feature = "complex-scripts") {
        assert!(d.lines.len() > 1);
    } else {
        assert_eq!(d.lines.len(), 1);
    }
}
