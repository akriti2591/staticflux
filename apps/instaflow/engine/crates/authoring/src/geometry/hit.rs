//! Precise hit tests for tools (B3, IF-7.8): after the spatial index returns candidates by ink bounds, these
//! decide fill or stroke hits on the exact outline, and marquee intersection or containment. Masks (IF-20.x) are
//! composed by the caller: a masked element is hit only where its mask is hit (or not hit, when inverted).

use kurbo::{Affine, BezPath, Line, ParamCurve, ParamCurveNearest, PathSeg, Point, Rect, Shape};
use linesweeper::FillRule;

use super::GeomError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hit {
    None = 0,
    Fill = 1,
    Stroke = 2,
}

/// Distance from `pt` to the nearest segment (∞ for an empty path).
pub fn distance(path: &BezPath, pt: Point) -> f64 {
    path.segments().map(|s| s.nearest(pt, 1e-6).distance_sq.sqrt()).fold(f64::INFINITY, f64::min)
}

/// Hit-test world point `pt` against `path` drawn with `transform`. `tolerance` and `stroke_width` are world units
/// (the stroke width is scaled by the transform's mean scale). A stroke hit wins over a fill hit near the edge.
pub fn hit(path: &BezPath, transform: Affine, pt: Point, tolerance: f64, fill: Option<FillRule>, stroke_width: f64) -> Result<Hit, GeomError> {
    if !(pt.is_finite() && tolerance.is_finite() && tolerance >= 0.0 && stroke_width.is_finite()) {
        return Err(GeomError::new("hit test inputs must be finite (tolerance ≥ 0)"));
    }
    let world = transform * path.clone();
    let scale = transform.determinant().abs().sqrt();
    let half = stroke_width.max(0.0) * scale / 2.0;
    let d = distance(&world, pt);
    if stroke_width > 0.0 && d <= half + tolerance {
        return Ok(Hit::Stroke);
    }
    if let Some(rule) = fill {
        if rule.is_inside(world.winding(pt)) || d <= tolerance {
            return Ok(Hit::Fill);
        }
    }
    Ok(Hit::None)
}

fn seg_hits_rect(seg: PathSeg, rect: Rect) -> bool {
    let corners = [Point::new(rect.x0, rect.y0), Point::new(rect.x1, rect.y0), Point::new(rect.x1, rect.y1), Point::new(rect.x0, rect.y1)];
    for i in 0..4 {
        let edge = Line::new(corners[i], corners[(i + 1) % 4]);
        if !seg.intersect_line(edge).is_empty() {
            return true;
        }
    }
    rect.contains(seg.eval(0.0)) || rect.contains(seg.eval(1.0))
}

/// Marquee test in world space: `contain` = the element's geometry lies inside `rect`; otherwise any overlap with
/// the outline or the filled interior (`filled`) counts.
pub fn intersects_rect(path: &BezPath, transform: Affine, rect: Rect, contain: bool, filled: bool) -> bool {
    let world = transform * path.clone();
    let bounds = world.bounding_box();
    if contain {
        return !world.elements().is_empty() && bounds.x0 >= rect.x0 && bounds.y0 >= rect.y0 && bounds.x1 <= rect.x1 && bounds.y1 <= rect.y1;
    }
    if bounds.intersect(rect).area() <= 0.0 && !(bounds.width() == 0.0 || bounds.height() == 0.0) {
        return false;
    }
    if world.segments().any(|s| seg_hits_rect(s, rect)) {
        return true;
    }
    // The rect may sit wholly inside a filled shape.
    filled && world.winding(rect.center()) != 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::shapes::{ellipse, line, rect};

    #[test]
    fn fill_and_stroke_hits() {
        let r = rect(100.0, 50.0, [0.0; 4]);
        let t = Affine::translate((10.0, 10.0));
        let nz = Some(FillRule::NonZero);
        assert_eq!(hit(&r, t, Point::new(50.0, 30.0), 0.0, nz, 0.0).unwrap(), Hit::Fill);
        assert_eq!(hit(&r, t, Point::new(5.0, 30.0), 0.0, nz, 0.0).unwrap(), Hit::None);
        assert_eq!(hit(&r, t, Point::new(5.0, 30.0), 0.0, nz, 12.0).unwrap(), Hit::Stroke);
        assert_eq!(hit(&r, t, Point::new(7.0, 30.0), 3.0, None, 0.0).unwrap(), Hit::None);
        assert_eq!(hit(&r, t, Point::new(50.0, 30.0), 0.0, None, 2.0).unwrap(), Hit::None, "no fill: inside misses");
        assert!(hit(&r, t, Point::new(f64::NAN, 0.0), 0.0, nz, 0.0).is_err());
        // scaled transforms scale the stroke
        let scaled = Affine::scale(2.0);
        assert_eq!(hit(&r, scaled, Point::new(-3.0, 50.0), 0.0, None, 4.0).unwrap(), Hit::Stroke);
    }

    #[test]
    fn curves_and_lines_are_exact() {
        let c = ellipse(100.0, 100.0);
        let nz = Some(FillRule::NonZero);
        assert_eq!(hit(&c, Affine::IDENTITY, Point::new(50.0, 50.0), 0.0, nz, 0.0).unwrap(), Hit::Fill);
        assert_eq!(hit(&c, Affine::IDENTITY, Point::new(3.0, 3.0), 0.0, nz, 0.0).unwrap(), Hit::None, "corner of the box is outside the circle");
        let l = line(100.0, 0.0);
        assert_eq!(hit(&l, Affine::IDENTITY, Point::new(50.0, 1.5), 0.0, None, 4.0).unwrap(), Hit::Stroke);
        assert_eq!(hit(&l, Affine::IDENTITY, Point::new(50.0, 5.0), 0.0, None, 4.0).unwrap(), Hit::None);
    }

    #[test]
    fn marquee_touch_and_contain() {
        let r = rect(10.0, 10.0, [0.0; 4]);
        let t = Affine::translate((100.0, 100.0));
        assert!(intersects_rect(&r, t, Rect::new(95.0, 95.0, 102.0, 102.0), false, true));
        assert!(!intersects_rect(&r, t, Rect::new(95.0, 95.0, 102.0, 102.0), true, true));
        assert!(intersects_rect(&r, t, Rect::new(90.0, 90.0, 120.0, 120.0), true, true));
        assert!(intersects_rect(&r, t, Rect::new(102.0, 102.0, 104.0, 104.0), false, true), "inside the fill");
        assert!(!intersects_rect(&r, t, Rect::new(102.0, 102.0, 104.0, 104.0), false, false), "outline only");
        assert!(!intersects_rect(&r, t, Rect::new(0.0, 0.0, 50.0, 50.0), false, true));
        // a circle's bounding-box corner region is not part of the circle
        let c = ellipse(100.0, 100.0);
        assert!(!intersects_rect(&c, Affine::IDENTITY, Rect::new(0.0, 0.0, 5.0, 5.0), false, true));
    }
}
