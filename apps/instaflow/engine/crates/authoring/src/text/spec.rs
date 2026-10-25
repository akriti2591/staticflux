//! Text block spec: the binary input of `TextEngine::layout` (written by `apps/instaflow/src/text/layout-spec.ts`).
//!
//! ```text
//! spec  = "SFTX" version:u16 reserved:u16 width:f32 para_count:u32 para*
//! para  = align:u8 direction:u8 line_height:f32 space_before:f32 space_after:f32 indent:f32
//!         text_len:u32 utf8[text_len] span_count:u32 span*
//! span  = start:u32 end:u32 (UTF-16 offsets inside the paragraph, contiguous, covering it)
//!         family_len:u16 utf8 (CSS family list) size:f32 weight:f32 italic:u8 letter_spacing:f32
//!         underline:u8 strike:u8 brush:u32 locale_len:u8 utf8
//! ```
//! `width <= 0` means no wrapping. `align`: 0 start, 1 center, 2 end, 3 justify. `direction`: 0 auto, 1 ltr,
//! 2 rtl. `line_height` is a multiple of the font size (0 = the font's metrics). `brush` is opaque to the
//! engine and comes back on every glyph run and decoration (the TypeScript side maps it to paint and links).

pub const MAGIC: [u8; 4] = *b"SFTX";
pub const VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Start,
    Center,
    End,
    Justify,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Auto,
    Ltr,
    Rtl,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpanSpec {
    pub start: u32,
    pub end: u32,
    pub family: String,
    pub size: f32,
    pub weight: f32,
    pub italic: bool,
    pub letter_spacing: f32,
    pub underline: bool,
    pub strike: bool,
    pub brush: u32,
    pub locale: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParagraphSpec {
    pub align: Align,
    pub direction: Direction,
    pub line_height: f32,
    pub space_before: f32,
    pub space_after: f32,
    pub indent: f32,
    pub text: String,
    pub spans: Vec<SpanSpec>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BlockSpec {
    pub width: f32,
    pub paragraphs: Vec<ParagraphSpec>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SpecError(pub String);

impl std::fmt::Display for SpecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], SpecError> {
        if self.pos + n > self.buf.len() {
            return Err(SpecError(format!("truncated text spec at byte {} (need {n} more)", self.pos)));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, SpecError> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, SpecError> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, SpecError> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn f32(&mut self) -> Result<f32, SpecError> {
        let v = f32::from_le_bytes(self.take(4)?.try_into().unwrap());
        if v.is_finite() { Ok(v) } else { Err(SpecError("non-finite number in text spec".into())) }
    }
    fn string(&mut self, len: usize) -> Result<String, SpecError> {
        String::from_utf8(self.take(len)?.to_vec()).map_err(|_| SpecError("text spec string is not UTF-8".into()))
    }
}

fn utf16_len(s: &str) -> u32 {
    s.encode_utf16().count() as u32
}

/// Decode and validate a block spec.
pub fn decode(bytes: &[u8]) -> Result<BlockSpec, SpecError> {
    let mut r = Reader { buf: bytes, pos: 0 };
    if r.take(4)? != MAGIC {
        return Err(SpecError("not a text spec (bad magic)".into()));
    }
    let version = r.u16()?;
    if version != VERSION {
        return Err(SpecError(format!("unsupported text spec version {version} (expected {VERSION})")));
    }
    r.u16()?;
    let width = r.f32()?;
    let count = r.u32()? as usize;
    let mut paragraphs = Vec::with_capacity(count.min(1 << 16));
    for p in 0..count {
        let align = match r.u8()? {
            0 => Align::Start,
            1 => Align::Center,
            2 => Align::End,
            3 => Align::Justify,
            other => return Err(SpecError(format!("paragraph {p}: unknown alignment {other}"))),
        };
        let direction = match r.u8()? {
            0 => Direction::Auto,
            1 => Direction::Ltr,
            2 => Direction::Rtl,
            other => return Err(SpecError(format!("paragraph {p}: unknown direction {other}"))),
        };
        let line_height = r.f32()?;
        let space_before = r.f32()?;
        let space_after = r.f32()?;
        let indent = r.f32()?;
        let len = r.u32()? as usize;
        let text = r.string(len)?;
        if text.contains('\n') {
            return Err(SpecError(format!("paragraph {p} contains a line feed (paragraphs are split before layout)")));
        }
        let n = r.u32()? as usize;
        let mut spans = Vec::with_capacity(n.min(1 << 16));
        for _ in 0..n {
            let start = r.u32()?;
            let end = r.u32()?;
            let flen = r.u16()? as usize;
            let family = r.string(flen)?;
            let size = r.f32()?;
            let weight = r.f32()?;
            let italic = r.u8()? != 0;
            let letter_spacing = r.f32()?;
            let underline = r.u8()? != 0;
            let strike = r.u8()? != 0;
            let brush = r.u32()?;
            let llen = r.u8()? as usize;
            let locale = r.string(llen)?;
            if !(size > 0.0) {
                return Err(SpecError(format!("paragraph {p}: span font size must be positive")));
            }
            spans.push(SpanSpec { start, end, family, size, weight, italic, letter_spacing, underline, strike, brush, locale });
        }
        let total = utf16_len(&text);
        if spans.is_empty() {
            return Err(SpecError(format!("paragraph {p} has no spans (every paragraph needs at least one style span)")));
        }
        let mut at = 0;
        for s in &spans {
            if s.start != at || s.end < s.start {
                return Err(SpecError(format!("paragraph {p}: spans must be contiguous from 0 (span {}..{} at {at})", s.start, s.end)));
            }
            at = s.end;
        }
        if at != total {
            return Err(SpecError(format!("paragraph {p}: spans cover {at} of {total} UTF-16 units")));
        }
        paragraphs.push(ParagraphSpec { align, direction, line_height, space_before, space_after, indent, text, spans });
    }
    if r.pos != bytes.len() {
        return Err(SpecError(format!("{} trailing bytes after the text spec", bytes.len() - r.pos)));
    }
    if paragraphs.is_empty() {
        return Err(SpecError("a text block needs at least one paragraph".into()));
    }
    Ok(BlockSpec { width, paragraphs })
}

/// Writer (host tests and fixtures; the TypeScript writer emits the same bytes).
#[derive(Default)]
pub struct SpecWriter {
    buf: Vec<u8>,
    count: u32,
}

impl SpecWriter {
    pub fn new(width: f32) -> Self {
        let mut buf = Vec::new();
        buf.extend_from_slice(&MAGIC);
        buf.extend_from_slice(&VERSION.to_le_bytes());
        buf.extend_from_slice(&0u16.to_le_bytes());
        buf.extend_from_slice(&width.to_le_bytes());
        buf.extend_from_slice(&0u32.to_le_bytes());
        Self { buf, count: 0 }
    }

    pub fn paragraph(&mut self, p: &ParagraphSpec) -> &mut Self {
        self.count += 1;
        self.buf.push(match p.align {
            Align::Start => 0,
            Align::Center => 1,
            Align::End => 2,
            Align::Justify => 3,
        });
        self.buf.push(match p.direction {
            Direction::Auto => 0,
            Direction::Ltr => 1,
            Direction::Rtl => 2,
        });
        for v in [p.line_height, p.space_before, p.space_after, p.indent] {
            self.buf.extend_from_slice(&v.to_le_bytes());
        }
        self.buf.extend_from_slice(&(p.text.len() as u32).to_le_bytes());
        self.buf.extend_from_slice(p.text.as_bytes());
        self.buf.extend_from_slice(&(p.spans.len() as u32).to_le_bytes());
        for s in &p.spans {
            self.buf.extend_from_slice(&s.start.to_le_bytes());
            self.buf.extend_from_slice(&s.end.to_le_bytes());
            self.buf.extend_from_slice(&(s.family.len() as u16).to_le_bytes());
            self.buf.extend_from_slice(s.family.as_bytes());
            self.buf.extend_from_slice(&s.size.to_le_bytes());
            self.buf.extend_from_slice(&s.weight.to_le_bytes());
            self.buf.push(u8::from(s.italic));
            self.buf.extend_from_slice(&s.letter_spacing.to_le_bytes());
            self.buf.push(u8::from(s.underline));
            self.buf.push(u8::from(s.strike));
            self.buf.extend_from_slice(&s.brush.to_le_bytes());
            self.buf.push(s.locale.len() as u8);
            self.buf.extend_from_slice(s.locale.as_bytes());
        }
        self
    }

    pub fn finish(mut self) -> Vec<u8> {
        self.buf[12..16].copy_from_slice(&self.count.to_le_bytes());
        self.buf
    }
}

/// One paragraph with a single style span (tests, fixtures).
pub fn simple_paragraph(text: &str, family: &str, size: f32) -> ParagraphSpec {
    ParagraphSpec {
        align: Align::Start,
        direction: Direction::Auto,
        line_height: 0.0,
        space_before: 0.0,
        space_after: 0.0,
        indent: 0.0,
        text: text.to_string(),
        spans: vec![SpanSpec {
            start: 0,
            end: utf16_len(text),
            family: family.to_string(),
            size,
            weight: 400.0,
            italic: false,
            letter_spacing: 0.0,
            underline: false,
            strike: false,
            brush: 0,
            locale: String::new(),
        }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_validates() {
        let mut w = SpecWriter::new(200.0);
        let mut p = simple_paragraph("héllo 👋", "Noto Sans", 16.0);
        p.align = Align::Justify;
        p.direction = Direction::Rtl;
        p.spans[0].locale = "fr".into();
        w.paragraph(&p);
        w.paragraph(&simple_paragraph("", "Noto Sans", 12.0));
        let spec = decode(&w.finish()).unwrap();
        assert_eq!(spec.width, 200.0);
        assert_eq!(spec.paragraphs, vec![p, simple_paragraph("", "Noto Sans", 12.0)]);
    }

    #[test]
    fn rejects_malformed_specs() {
        assert!(decode(b"NOPE").unwrap_err().0.contains("magic"));
        assert!(decode(&SpecWriter::new(0.0).finish()).unwrap_err().0.contains("at least one paragraph"));
        let mut gap = simple_paragraph("abc", "x", 10.0);
        gap.spans[0].end = 2;
        let mut w = SpecWriter::new(0.0);
        w.paragraph(&gap);
        assert!(decode(&w.finish()).unwrap_err().0.contains("cover 2 of 3"));
        let mut w = SpecWriter::new(0.0);
        w.paragraph(&simple_paragraph("a\nb", "x", 10.0));
        assert!(decode(&w.finish()).unwrap_err().0.contains("line feed"));
        let mut w = SpecWriter::new(0.0);
        w.paragraph(&simple_paragraph("a", "x", 0.0));
        assert!(decode(&w.finish()).unwrap_err().0.contains("positive"));
        let mut w = SpecWriter::new(0.0);
        w.paragraph(&simple_paragraph("a", "x", 10.0));
        let mut bytes = w.finish();
        bytes.push(1);
        assert!(decode(&bytes).unwrap_err().0.contains("trailing"));
        bytes.truncate(bytes.len() - 4);
        assert!(decode(&bytes).unwrap_err().0.contains("truncated"));
    }
}
