//! Geometry bounds (align, distribute, snapping) and ink bounds (the A7 spatial index, IF-7.8): the area an element
//! can paint, grown by its stroke and its effects. Stroke outlines are exact (kurbo's stroker); effect outsets follow
//! the renderer (`crates/render/src/draw.rs`): σ = blur / 2 and a Gaussian reaches 3σ.

use kurbo::{Affine, BezPath, Cap, Join, Rect, Shape, Stroke, StrokeOpts};

use super::GeomError;

/// Stroke placement relative to the outline (`style.strokeAlign`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Align {
    Center = 0,
    Inside = 1,
    Outside = 2,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StrokeSpec {
    pub width: f64,
    pub align: Align,
    /// 0 miter, 1 round, 2 bevel.
    pub join: u8,
    /// 0 butt, 1 round, 2 square.
    pub cap: u8,
    pub miter: f64,
    pub dash_offset: f64,
    pub dashes: Vec<f64>,
}

impl StrokeSpec {
    /// From `[width, align, join, cap, miter, dashOffset?, dash…]` (empty or width ≤ 0: no stroke).
    pub fn from_flat(v: &[f64]) -> Result<Option<Self>, GeomError> {
        if v.is_empty() || v[0] <= 0.0 {
            return Ok(None);
        }
        if v.len() < 5 || v.iter().any(|x| !x.is_finite()) || v.iter().skip(6).any(|d| *d < 0.0) {
            return Err(GeomError::new("a stroke is [width, align, join, cap, miter, dashOffset?, dash…], all finite"));
        }
        let align = match v[1] as u8 {
            0 => Align::Center,
            1 => Align::Inside,
            2 => Align::Outside,
            other => return Err(GeomError::new(format!("unknown stroke align {other}"))),
        };
        let dashes: Vec<f64> = v.iter().skip(6).copied().collect();
        let dashes = if dashes.iter().any(|d| *d > 0.0) { dashes } else { Vec::new() };
        Ok(Some(StrokeSpec { width: v[0], align, join: v[2] as u8, cap: v[3] as u8, miter: if v[4] > 0.0 { v[4] } else { 4.0 }, dash_offset: v.get(5).copied().unwrap_or(0.0), dashes }))
    }

    /// The kurbo stroke the renderer draws: inside and outside strokes are centred strokes of twice the width,
    /// clipped to (or outside) the shape, so the outline reaches `width` beyond the edge for `outside`.
    pub fn kurbo(&self) -> Stroke {
        let width = match self.align {
            Align::Center => self.width,
            Align::Inside | Align::Outside => self.width * 2.0,
        };
        let join = match self.join {
            1 => Join::Round,
            2 => Join::Bevel,
            _ => Join::Miter,
        };
        let cap = match self.cap {
            1 => Cap::Round,
            2 => Cap::Square,
            _ => Cap::Butt,
        };
        let stroke = Stroke::new(width).with_join(join).with_caps(cap).with_miter_limit(self.miter);
        if self.dashes.is_empty() { stroke } else { stroke.with_dashes(self.dash_offset, self.dashes.iter().copied()) }
    }
}

/// Effect kinds in flat effect lists (`[kind, x, y, blur, spread, _]` per effect): 1 drop shadow, 2 inner shadow,
/// 3 layer blur (radius in `blur`). Inner shadows never paint outside the shape.
pub const EFFECT_STRIDE: usize = 6;

/// Exact bounds of `path` under `transform` (curves included).
pub fn bounds(path: &BezPath, transform: Affine) -> Rect {
    (transform * path.clone()).bounding_box()
}

/// The filled outline of a stroke (the "Outline stroke" action and exact stroke ink).
pub fn stroke_outline(path: &BezPath, stroke: &StrokeSpec) -> BezPath {
    kurbo::stroke(path.iter(), &stroke.kurbo(), &StrokeOpts::default(), 0.01)
}

/// Local-space ink rect: geometry ∪ stroke outline, then effect outsets.
pub fn local_ink(path: &BezPath, stroke: Option<&StrokeSpec>, effects: &[f64]) -> Result<Rect, GeomError> {
    if effects.len() % EFFECT_STRIDE != 0 || effects.iter().any(|v| !v.is_finite()) {
        return Err(GeomError::new("effects are flat [kind, x, y, blur, spread, 0] groups of finite numbers"));
    }
    let mut ink = path.bounding_box();
    if let Some(s) = stroke {
        if s.align != Align::Inside {
            ink = ink.union(stroke_outline(path, s).bounding_box());
        }
    }
    let base = ink;
    for e in effects.chunks_exact(EFFECT_STRIDE) {
        let (kind, x, y, blur, spread) = (e[0] as u8, e[1], e[2], e[3].max(0.0), e[4]);
        let reach = 1.5 * blur; // 3σ with σ = blur / 2
        match kind {
            1 => {
                let grown = base.inflate((spread + reach).max(0.0), (spread + reach).max(0.0));
                ink = ink.union(grown + kurbo::Vec2::new(x, y));
            }
            2 => {}
            3 => ink = ink.union(base.inflate(reach, reach)),
            other => return Err(GeomError::new(format!("unknown effect kind {other}"))),
        }
    }
    Ok(ink)
}

/// World ink bounds: the local ink rect's corners under `transform` (conservative under rotation).
pub fn ink_bounds(path: &BezPath, transform: Affine, stroke: Option<&StrokeSpec>, effects: &[f64]) -> Result<Rect, GeomError> {
    if path.elements().is_empty() {
        return Ok(Rect::ZERO);
    }
    let local = local_ink(path, stroke, effects)?;
    if stroke.is_none() && effects.is_empty() {
        return Ok(bounds(path, transform));
    }
    Ok(transform.transform_rect_bbox(local).union(bounds(path, transform)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::shapes::{ellipse, line, rect};

    fn spec(width: f64, align: Align) -> StrokeSpec {
        StrokeSpec { width, align, join: 0, cap: 0, miter: 4.0, dash_offset: 0.0, dashes: Vec::new() }
    }

    #[test]
    fn geometry_bounds_are_exact_under_rotation() {
        let r = rect(100.0, 50.0, [0.0; 4]);
        let b = bounds(&r, Affine::rotate(std::f64::consts::FRAC_PI_2));
        assert!((b.width() - 50.0).abs() < 1e-9 && (b.height() - 100.0).abs() < 1e-9);
        // a circle's bounds stay tight under rotation (no corner growth)
        let c = bounds(&ellipse(100.0, 100.0), Affine::rotate(0.7));
        assert!((c.width() - 100.0).abs() < 0.05, "{c:?}");
    }

    #[test]
    fn stroke_alignment_grows_ink() {
        let r = rect(100.0, 50.0, [0.0; 4]);
        let center = ink_bounds(&r, Affine::IDENTITY, Some(&spec(10.0, Align::Center)), &[]).unwrap();
        assert_eq!(center, Rect::new(-5.0, -5.0, 105.0, 55.0));
        let outside = ink_bounds(&r, Affine::IDENTITY, Some(&spec(10.0, Align::Outside)), &[]).unwrap();
        assert_eq!(outside, Rect::new(-10.0, -10.0, 110.0, 60.0));
        let inside = ink_bounds(&r, Affine::IDENTITY, Some(&spec(10.0, Align::Inside)), &[]).unwrap();
        assert_eq!(inside, Rect::new(0.0, 0.0, 100.0, 50.0));
        let l = ink_bounds(&line(100.0, 0.0), Affine::IDENTITY, Some(&StrokeSpec { width: 4.0, align: Align::Center, join: 0, cap: 2, miter: 4.0, dash_offset: 0.0, dashes: Vec::new() }), &[]).unwrap();
        assert_eq!(l, Rect::new(-2.0, -2.0, 102.0, 2.0), "square caps extend the line");
    }

    #[test]
    fn effects_grow_ink_like_the_renderer() {
        let r = rect(100.0, 100.0, [0.0; 4]);
        let shadow = [1.0, 10.0, 20.0, 8.0, 2.0, 0.0];
        let ink = ink_bounds(&r, Affine::IDENTITY, None, &shadow).unwrap();
        // grown by spread 2 + 3σ (σ = 4) = 14, then offset (10, 20)
        assert_eq!(ink, Rect::new(-4.0, 0.0, 124.0, 134.0));
        let blur = ink_bounds(&r, Affine::IDENTITY, None, &[3.0, 0.0, 0.0, 4.0, 0.0, 0.0]).unwrap();
        assert_eq!(blur, Rect::new(-6.0, -6.0, 106.0, 106.0));
        let inner = ink_bounds(&r, Affine::IDENTITY, None, &[2.0, 5.0, 5.0, 10.0, 0.0, 0.0]).unwrap();
        assert_eq!(inner, Rect::new(0.0, 0.0, 100.0, 100.0));
        assert!(ink_bounds(&r, Affine::IDENTITY, None, &[1.0]).is_err());
        assert!(ink_bounds(&r, Affine::IDENTITY, None, &[9.0, 0.0, 0.0, 0.0, 0.0, 0.0]).is_err());
    }

    #[test]
    fn stroke_specs_parse_and_outline() {
        assert_eq!(StrokeSpec::from_flat(&[]).unwrap(), None);
        assert_eq!(StrokeSpec::from_flat(&[0.0, 0.0, 0.0, 0.0, 0.0]).unwrap(), None);
        assert!(StrokeSpec::from_flat(&[1.0, 7.0, 0.0, 0.0, 4.0]).is_err());
        assert!(StrokeSpec::from_flat(&[1.0, 0.0]).is_err());
        let s = StrokeSpec::from_flat(&[4.0, 0.0, 1.0, 1.0, 0.0]).unwrap().unwrap();
        assert_eq!(s.miter, 4.0);
        let outline = stroke_outline(&rect(10.0, 10.0, [0.0; 4]), &s);
        assert_eq!(outline.bounding_box(), Rect::new(-2.0, -2.0, 12.0, 12.0));
        assert_ne!(outline.winding(kurbo::Point::new(0.0, 5.0)), 0, "on the stroke");
        let dashed = StrokeSpec::from_flat(&[2.0, 0.0, 0.0, 0.0, 4.0, 0.0, 2.0, 2.0]).unwrap().unwrap();
        assert_eq!(dashed.dashes, vec![2.0, 2.0]);
        let d = stroke_outline(&line(20.0, 0.0), &dashed);
        assert!(d.elements().iter().filter(|e| matches!(e, kurbo::PathEl::MoveTo(_))).count() >= 4, "dashes are separate pieces");
        assert!(StrokeSpec::from_flat(&[2.0, 0.0, 0.0, 0.0, 4.0, 0.0, -1.0]).is_err());
    }
}
