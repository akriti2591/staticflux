//! Element outlines in the element's local box `(0, 0) – (w, h)` (`geometry.shape`, DOCUMENT-FORMAT §3.2):
//! rectangles with a radius per corner, ellipses, regular polygons and stars that fill their box, and lines.

use kurbo::{BezPath, Ellipse, Point, Rect, RoundedRect, RoundedRectRadii, Shape};

use super::GeomError;

/// Curve flattening tolerance for analytic shapes (local px). Shapes stay curves; this only bounds the
/// cubic approximation of arcs.
pub const TOLERANCE: f64 = 0.01;

/// `geometry.shape` codes shared with TypeScript (`SHAPE_CODES` in `apps/instaflow/src/elements/geometry.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShapeKind {
    Rect = 0,
    Ellipse = 1,
    Polygon = 2,
    Star = 3,
    Line = 4,
}

impl ShapeKind {
    pub fn from_code(code: u8) -> Result<Self, GeomError> {
        Ok(match code {
            0 => ShapeKind::Rect,
            1 => ShapeKind::Ellipse,
            2 => ShapeKind::Polygon,
            3 => ShapeKind::Star,
            4 => ShapeKind::Line,
            other => return Err(GeomError::new(format!("unknown shape code {other}"))),
        })
    }
}

/// Corner radii `[top-left, top-right, bottom-right, bottom-left]`, scaled down together when they do not
/// fit (CSS border-radius rule), so adjacent corners never overlap.
pub fn fit_radii(w: f64, h: f64, radii: [f64; 4]) -> [f64; 4] {
    let r = radii.map(|v| if v.is_finite() { v.max(0.0) } else { 0.0 });
    let [tl, tr, br, bl] = r;
    let mut f: f64 = 1.0;
    for (sum, side) in [(tl + tr, w), (bl + br, w), (tl + bl, h), (tr + br, h)] {
        if sum > side && sum > 0.0 {
            f = f.min(side / sum);
        }
    }
    // Never more than half the shortest side.
    let cap = (w.min(h) / 2.0).max(0.0);
    r.map(|v| (v * f).min(cap))
}

/// A rectangle with a radius per corner.
pub fn rect(w: f64, h: f64, radii: [f64; 4]) -> BezPath {
    let [tl, tr, br, bl] = fit_radii(w, h, radii);
    let r = Rect::new(0.0, 0.0, w, h);
    if tl == 0.0 && tr == 0.0 && br == 0.0 && bl == 0.0 {
        return r.to_path(TOLERANCE);
    }
    RoundedRect::from_rect(r, RoundedRectRadii::new(tl, tr, br, bl)).to_path(TOLERANCE)
}

/// A rectangle with smooth ("squircle") corners: each corner's curve starts `(1 + smoothing) × r` from the corner
/// (capped at half the side) with longer handles, so the curvature ramps up instead of jumping (`smoothing` 0…1;
/// 0 is the circular `rect`).
pub fn smooth_rect(w: f64, h: f64, radii: [f64; 4], smoothing: f64) -> BezPath {
    let s = if smoothing.is_finite() { smoothing.clamp(0.0, 1.0) } else { 0.0 };
    let r = fit_radii(w, h, radii);
    if s == 0.0 || r.iter().all(|v| *v == 0.0) {
        return rect(w, h, radii);
    }
    let k = 0.5523 + 0.35 * s;
    let reach = |v: f64| (v * (1.0 + s)).min(w / 2.0).min(h / 2.0);
    let [tl, tr, br, bl] = r.map(reach);
    let mut p = BezPath::new();
    p.move_to((tl, 0.0));
    p.line_to((w - tr, 0.0));
    if tr > 0.0 {
        p.curve_to((w - tr * (1.0 - k), 0.0), (w, tr * (1.0 - k)), (w, tr));
    }
    p.line_to((w, h - br));
    if br > 0.0 {
        p.curve_to((w, h - br * (1.0 - k)), (w - br * (1.0 - k), h), (w - br, h));
    }
    p.line_to((bl, h));
    if bl > 0.0 {
        p.curve_to((bl * (1.0 - k), h), (0.0, h - bl * (1.0 - k)), (0.0, h - bl));
    }
    p.line_to((0.0, tl));
    if tl > 0.0 {
        p.curve_to((0.0, tl * (1.0 - k)), (tl * (1.0 - k), 0.0), (tl, 0.0));
    }
    p.close_path();
    p
}

pub fn ellipse(w: f64, h: f64) -> BezPath {
    Ellipse::from_rect(Rect::new(0.0, 0.0, w, h)).to_path(TOLERANCE)
}

/// Map unit-circle vertices so their bounds fill the box exactly (a triangle touches all four sides).
fn fill_box(vertices: &[Point], w: f64, h: f64) -> BezPath {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in vertices {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    let sx = if x1 > x0 { w / (x1 - x0) } else { 0.0 };
    let sy = if y1 > y0 { h / (y1 - y0) } else { 0.0 };
    let mut path = BezPath::new();
    for (i, p) in vertices.iter().enumerate() {
        let q = Point::new((p.x - x0) * sx, (p.y - y0) * sy);
        if i == 0 { path.move_to(q) } else { path.line_to(q) }
    }
    path.close_path();
    path
}

/// A regular polygon with `sides` vertices (3…1000), the first at the top.
pub fn polygon(w: f64, h: f64, sides: u32) -> Result<BezPath, GeomError> {
    if !(3..=1000).contains(&sides) {
        return Err(GeomError::new(format!("a polygon has 3–1000 sides, got {sides}")));
    }
    let n = sides as usize;
    let vertices: Vec<Point> = (0..n)
        .map(|i| {
            let a = -std::f64::consts::FRAC_PI_2 + std::f64::consts::TAU * i as f64 / n as f64;
            Point::new(a.cos(), a.sin())
        })
        .collect();
    Ok(fill_box(&vertices, w, h))
}

/// A star with `points` tips (3…1000) and inner radius `ratio` × outer (0 < ratio ≤ 1).
pub fn star(w: f64, h: f64, points: u32, ratio: f64) -> Result<BezPath, GeomError> {
    if !(3..=1000).contains(&points) {
        return Err(GeomError::new(format!("a star has 3–1000 points, got {points}")));
    }
    if !(ratio.is_finite() && ratio > 0.0 && ratio <= 1.0) {
        return Err(GeomError::new(format!("a star's inner ratio is in (0, 1], got {ratio}")));
    }
    let n = points as usize * 2;
    let vertices: Vec<Point> = (0..n)
        .map(|i| {
            let a = -std::f64::consts::FRAC_PI_2 + std::f64::consts::TAU * i as f64 / n as f64;
            let r = if i % 2 == 0 { 1.0 } else { ratio };
            Point::new(a.cos() * r, a.sin() * r)
        })
        .collect();
    // Fill the box by the tips, as the outer polygon would.
    let tips: Vec<Point> = vertices.iter().step_by(2).copied().collect();
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for p in &tips {
        x0 = x0.min(p.x);
        y0 = y0.min(p.y);
        x1 = x1.max(p.x);
        y1 = y1.max(p.y);
    }
    let sx = w / (x1 - x0);
    let sy = h / (y1 - y0);
    let mut path = BezPath::new();
    for (i, p) in vertices.iter().enumerate() {
        let q = Point::new((p.x - x0) * sx, (p.y - y0) * sy);
        if i == 0 { path.move_to(q) } else { path.line_to(q) }
    }
    path.close_path();
    Ok(path)
}

/// A horizontal line through the middle of the box (rotate the element for other angles). Open: strokes only.
pub fn line(w: f64, h: f64) -> BezPath {
    let mut path = BezPath::new();
    path.move_to((0.0, h / 2.0));
    path.line_to((w, h / 2.0));
    path
}

/// The outline of an analytic shape. `a` = polygon sides / star points, `b` = star ratio.
pub fn outline(kind: ShapeKind, w: f64, h: f64, a: u32, b: f64, radii: [f64; 4]) -> Result<BezPath, GeomError> {
    outline_smooth(kind, w, h, a, b, radii, 0.0)
}

/// `outline` with rounded (and optionally smooth, `smoothing` 0…1) corners: rect corners `[tl, tr, br, bl]`,
/// polygon vertices `radii[0]`, star tips `radii[0]` and inner vertices `radii[1]`.
pub fn outline_smooth(kind: ShapeKind, w: f64, h: f64, a: u32, b: f64, radii: [f64; 4], smoothing: f64) -> Result<BezPath, GeomError> {
    if !(w.is_finite() && h.is_finite() && w >= 0.0 && h >= 0.0) {
        return Err(GeomError::new(format!("a shape box is finite and non-negative, got {w} × {h}")));
    }
    match kind {
        ShapeKind::Rect => Ok(smooth_rect(w, h, radii, smoothing)),
        ShapeKind::Ellipse => Ok(ellipse(w, h)),
        // Polygon vertices round with radii[0]; a star's tips with radii[0] and its inner vertices with radii[1].
        ShapeKind::Polygon => Ok(super::corners::round_vertices(&polygon(w, h, a)?, &|_| radii[0], smoothing)),
        ShapeKind::Star => {
            let (outer, inner) = (radii[0], radii[1]);
            Ok(super::corners::round_vertices(&star(w, h, a, b)?, &|i| if i % 2 == 0 { outer } else { inner }, smoothing))
        }
        ShapeKind::Line => Ok(line(w, h)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Rect, b: Rect) -> bool {
        (a.x0 - b.x0).abs() < 0.01 && (a.y0 - b.y0).abs() < 0.01 && (a.x1 - b.x1).abs() < 0.01 && (a.y1 - b.y1).abs() < 0.01
    }

    #[test]
    fn shapes_fill_their_box() {
        let boxed = Rect::new(0.0, 0.0, 120.0, 80.0);
        for kind in [ShapeKind::Rect, ShapeKind::Ellipse, ShapeKind::Polygon, ShapeKind::Star] {
            let radii = if kind == ShapeKind::Rect { [10.0, 0.0, 20.0, 0.0] } else { [0.0; 4] };
            let p = outline(kind, 120.0, 80.0, 5, 0.4, radii).unwrap();
            assert!(close(p.bounding_box(), boxed), "{kind:?}: {:?}", p.bounding_box());
        }
        let tri = polygon(100.0, 100.0, 3).unwrap();
        assert!(close(tri.bounding_box(), Rect::new(0.0, 0.0, 100.0, 100.0)));
        assert_eq!(line(10.0, 4.0).bounding_box(), Rect::new(0.0, 2.0, 10.0, 2.0));
    }

    #[test]
    fn radii_are_scaled_to_fit_like_css() {
        assert_eq!(fit_radii(100.0, 50.0, [10.0, 10.0, 10.0, 10.0]), [10.0; 4]);
        assert_eq!(fit_radii(100.0, 50.0, [50.0, 50.0, 50.0, 50.0]), [25.0; 4]);
        assert_eq!(fit_radii(10.0, 10.0, [-3.0, f64::NAN, 4.0, 0.0]), [0.0, 0.0, 4.0, 0.0]);
        let area = rect(100.0, 100.0, [50.0; 4]).area().abs();
        assert!((area - std::f64::consts::PI * 2500.0).abs() < 5.0, "fully rounded square is a circle: {area}");
        let square = rect(10.0, 10.0, [0.0; 4]).area().abs();
        assert!((square - 100.0).abs() < 1e-9);
    }

    #[test]
    fn smooth_corners_stay_in_the_box_and_between_square_and_round() {
        let round = rect(100.0, 100.0, [20.0; 4]).area().abs();
        let smooth = smooth_rect(100.0, 100.0, [20.0; 4], 0.6);
        assert!(close(smooth.bounding_box(), Rect::new(0.0, 0.0, 100.0, 100.0)));
        let a = smooth.area().abs();
        assert!(a < 10_000.0 && a < round + 1.0 && a > round - 400.0, "smooth {a} round {round}");
        assert_eq!(smooth_rect(10.0, 10.0, [2.0; 4], 0.0), rect(10.0, 10.0, [2.0; 4]));
    }

    #[test]
    fn rejects_bad_parameters() {
        assert!(polygon(10.0, 10.0, 2).is_err());
        assert!(star(10.0, 10.0, 5, 0.0).is_err());
        assert!(star(10.0, 10.0, 5, 1.5).is_err());
        assert!(outline(ShapeKind::Rect, f64::NAN, 1.0, 0, 0.0, [0.0; 4]).is_err());
        assert!(ShapeKind::from_code(9).is_err());
        assert_eq!(ShapeKind::from_code(3).unwrap(), ShapeKind::Star);
    }

    #[test]
    fn star_area_is_between_inner_and_outer_polygons() {
        let s = star(100.0, 100.0, 5, 0.5).unwrap().area().abs();
        let p = polygon(100.0, 100.0, 5).unwrap().area().abs();
        assert!(s > 0.0 && s < p, "star {s} polygon {p}");
    }
}
