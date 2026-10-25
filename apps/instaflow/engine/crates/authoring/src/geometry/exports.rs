//! The geometry Wasm ABI (version `GEOMETRY_VERSION`). Paths cross as flat `verbs: Uint8Array` +
//! `points: Float64Array` (see `path.rs`), transforms as six numbers, rects as `[x0, y0, x1, y1]`. Every export has a
//! pure `*_impl` twin returning `Result<_, GeomError>` (host tests call those); errors reach JavaScript as thrown
//! strings, which the TypeScript service turns into `IF-EL-005` values.

use kurbo::{Point, Rect};
use wasm_bindgen::prelude::*;

use super::boolean::{BooleanOp, boolean, fill_rule};
use super::bounds::{StrokeSpec, bounds, ink_bounds, stroke_outline};
use super::hit::{hit, intersects_rect};
use super::path::{affine, from_flat, parse_svg, split_flat, to_flat};
use super::shapes::{ShapeKind, outline_smooth};
use super::{GEOMETRY_VERSION, GeomError};

/// A path in flat form.
#[wasm_bindgen]
#[derive(Clone, Debug, PartialEq)]
pub struct PathData {
    verbs: Vec<u8>,
    points: Vec<f64>,
}

#[wasm_bindgen]
impl PathData {
    #[wasm_bindgen(getter)]
    pub fn verbs(&self) -> Vec<u8> {
        self.verbs.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn points(&self) -> Vec<f64> {
        self.points.clone()
    }
    /// SVG path data (`geometry.path`).
    pub fn svg(&self) -> String {
        from_flat(&self.verbs, &self.points).map(|p| p.to_svg()).unwrap_or_default()
    }
}

impl PathData {
    fn of(path: &kurbo::BezPath) -> Self {
        let (verbs, points) = to_flat(path);
        PathData { verbs, points }
    }
}

fn js(e: GeomError) -> JsValue {
    JsValue::from_str(&e.0)
}

fn rect_of(v: &[f64]) -> Result<Rect, GeomError> {
    match v {
        [x0, y0, x1, y1] if v.iter().all(|x| x.is_finite()) => Ok(Rect::new(*x0, *y0, *x1, *y1)),
        _ => Err(GeomError::new("a rect is [x0, y0, x1, y1], all finite")),
    }
}

fn radii_of(v: &[f64]) -> Result<[f64; 4], GeomError> {
    match v {
        [] => Ok([0.0; 4]),
        [r] => Ok([*r; 4]),
        [outer, inner] => Ok([*outer, *inner, 0.0, 0.0]),
        [a, b, c, d] => Ok([*a, *b, *c, *d]),
        _ => Err(GeomError::new("corner radii are [], [r], [outer, inner] (stars) or [tl, tr, br, bl]")),
    }
}

fn rect_out(r: Rect) -> Vec<f64> {
    vec![r.x0, r.y0, r.x1, r.y1]
}

#[wasm_bindgen]
pub fn geometry_version() -> u32 {
    GEOMETRY_VERSION
}

pub fn parse_path_impl(d: &str) -> Result<PathData, GeomError> {
    Ok(PathData::of(&parse_svg(d)?))
}
/// Parse SVG path data.
#[wasm_bindgen]
pub fn parse_path(d: &str) -> Result<PathData, JsValue> {
    parse_path_impl(d).map_err(js)
}

pub fn shape_outline_impl(kind: u8, w: f64, h: f64, a: u32, b: f64, radii: &[f64], smoothing: f64) -> Result<PathData, GeomError> {
    Ok(PathData::of(&outline_smooth(ShapeKind::from_code(kind)?, w, h, a, b, radii_of(radii)?, smoothing)?))
}
/// Outline of an analytic shape in its local box (`kind`: 0 rect, 1 ellipse, 2 polygon, 3 star, 4 line;
/// `smoothing` 0…1 = smooth rectangle corners).
#[wasm_bindgen]
pub fn shape_outline(kind: u8, w: f64, h: f64, a: u32, b: f64, radii: &[f64], smoothing: f64) -> Result<PathData, JsValue> {
    shape_outline_impl(kind, w, h, a, b, radii, smoothing).map_err(js)
}

pub fn round_path_impl(verbs: &[u8], points: &[f64], radii: &[f64], smoothing: f64) -> Result<PathData, GeomError> {
    if radii.iter().any(|r| !r.is_finite()) {
        return Err(GeomError::new("vertex radii must be finite"));
    }
    let path = from_flat(verbs, points)?;
    let uniform = if radii.len() == 1 { radii[0] } else { 0.0 };
    let radius = |i: usize| if radii.len() == 1 { uniform } else { radii.get(i).copied().unwrap_or(0.0) };
    Ok(PathData::of(&super::corners::round_vertices(&path, &radius, smoothing)))
}
/// Round the straight-line vertices of a vector path: `radii` = one radius for all, or one per vertex (across
/// subpaths, in order); `smoothing` 0…1.
#[wasm_bindgen]
pub fn round_path(verbs: &[u8], points: &[f64], radii: &[f64], smoothing: f64) -> Result<PathData, JsValue> {
    round_path_impl(verbs, points, radii, smoothing).map_err(js)
}

pub fn transform_path_impl(verbs: &[u8], points: &[f64], transform: &[f64]) -> Result<PathData, GeomError> {
    Ok(PathData::of(&(affine(transform)? * from_flat(verbs, points)?)))
}
/// Apply an affine to a path.
#[wasm_bindgen]
pub fn transform_path(verbs: &[u8], points: &[f64], transform: &[f64]) -> Result<PathData, JsValue> {
    transform_path_impl(verbs, points, transform).map_err(js)
}

pub fn boolean_op_impl(op: u8, verbs: &[u8], points: &[f64], verb_counts: &[u32], fill_rules: &[u8]) -> Result<PathData, GeomError> {
    let paths = split_flat(verbs, points, verb_counts)?;
    if fill_rules.len() != paths.len() {
        return Err(GeomError::new("one fill rule per operand"));
    }
    let mut operands = Vec::with_capacity(paths.len());
    for (path, rule) in paths.into_iter().zip(fill_rules) {
        operands.push((path, fill_rule(*rule)?));
    }
    Ok(PathData::of(&boolean(BooleanOp::from_code(op)?, &operands)?))
}
/// Boolean of concatenated operands (`verb_counts[i]` verbs each; `op`: 0 union, 1 subtract, 2 intersect, 3 exclude).
#[wasm_bindgen]
pub fn boolean_op(op: u8, verbs: &[u8], points: &[f64], verb_counts: &[u32], fill_rules: &[u8]) -> Result<PathData, JsValue> {
    boolean_op_impl(op, verbs, points, verb_counts, fill_rules).map_err(js)
}

pub fn outline_stroke_impl(verbs: &[u8], points: &[f64], stroke: &[f64]) -> Result<PathData, GeomError> {
    let path = from_flat(verbs, points)?;
    let Some(spec) = StrokeSpec::from_flat(stroke)? else { return Ok(PathData { verbs: vec![], points: vec![] }) };
    let outline = stroke_outline(&path, &spec);
    // Inside and outside strokes keep only the half on their side of a closed outline.
    let clipped = match spec.align {
        super::bounds::Align::Center => outline,
        super::bounds::Align::Inside => boolean(BooleanOp::Intersect, &[(outline, linesweeper::FillRule::NonZero), (path, linesweeper::FillRule::NonZero)])?,
        super::bounds::Align::Outside => boolean(BooleanOp::Subtract, &[(outline, linesweeper::FillRule::NonZero), (path, linesweeper::FillRule::NonZero)])?,
    };
    Ok(PathData::of(&clipped))
}
/// The filled outline of a stroke (`stroke` = `[width, align, join, cap, miter, dashOffset?, dash…]`): the
/// "Outline stroke" action and the ring of inside / outside / dashed strokes.
#[wasm_bindgen]
pub fn outline_stroke(verbs: &[u8], points: &[f64], stroke: &[f64]) -> Result<PathData, JsValue> {
    outline_stroke_impl(verbs, points, stroke).map_err(js)
}

pub fn path_bounds_impl(verbs: &[u8], points: &[f64], transform: &[f64]) -> Result<Vec<f64>, GeomError> {
    Ok(rect_out(bounds(&from_flat(verbs, points)?, affine(transform)?)))
}
/// Exact geometry bounds `[x0, y0, x1, y1]` under a transform.
#[wasm_bindgen]
pub fn path_bounds(verbs: &[u8], points: &[f64], transform: &[f64]) -> Result<Vec<f64>, JsValue> {
    path_bounds_impl(verbs, points, transform).map_err(js)
}

pub fn ink_bounds_impl(verbs: &[u8], points: &[f64], transform: &[f64], stroke: &[f64], effects: &[f64]) -> Result<Vec<f64>, GeomError> {
    let spec = StrokeSpec::from_flat(stroke)?;
    Ok(rect_out(ink_bounds(&from_flat(verbs, points)?, affine(transform)?, spec.as_ref(), effects)?))
}
/// Ink bounds (geometry ∪ stroke ∪ effects) `[x0, y0, x1, y1]` under a transform.
#[wasm_bindgen]
pub fn ink_bounds_of(verbs: &[u8], points: &[f64], transform: &[f64], stroke: &[f64], effects: &[f64]) -> Result<Vec<f64>, JsValue> {
    ink_bounds_impl(verbs, points, transform, stroke, effects).map_err(js)
}

#[allow(clippy::too_many_arguments)]
pub fn hit_test_impl(verbs: &[u8], points: &[f64], transform: &[f64], x: f64, y: f64, tolerance: f64, fill: i32, stroke_width: f64) -> Result<u8, GeomError> {
    let rule = if fill < 0 { None } else { Some(fill_rule(fill as u8)?) };
    Ok(hit(&from_flat(verbs, points)?, affine(transform)?, Point::new(x, y), tolerance, rule, stroke_width)? as u8)
}
/// Hit test (`fill`: −1 not filled, 0 non-zero, 1 even-odd) → 0 none, 1 fill, 2 stroke.
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen]
pub fn hit_test(verbs: &[u8], points: &[f64], transform: &[f64], x: f64, y: f64, tolerance: f64, fill: i32, stroke_width: f64) -> Result<u8, JsValue> {
    hit_test_impl(verbs, points, transform, x, y, tolerance, fill, stroke_width).map_err(js)
}

pub fn intersects_rect_impl(verbs: &[u8], points: &[f64], transform: &[f64], rect: &[f64], contain: bool, filled: bool) -> Result<bool, GeomError> {
    Ok(intersects_rect(&from_flat(verbs, points)?, affine(transform)?, rect_of(rect)?, contain, filled))
}
/// Marquee test: overlap (or containment with `contain`) of a path with a world rect.
#[wasm_bindgen]
pub fn intersects(verbs: &[u8], points: &[f64], transform: &[f64], rect: &[f64], contain: bool, filled: bool) -> Result<bool, JsValue> {
    intersects_rect_impl(verbs, points, transform, rect, contain, filled).map_err(js)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exports_compose() {
        let r = shape_outline_impl(0, 10.0, 10.0, 0, 0.0, &[], 0.0).unwrap();
        let moved = transform_path_impl(&r.verbs, &r.points, &[1.0, 0.0, 0.0, 1.0, 5.0, 5.0]).unwrap();
        let verbs = [r.verbs.clone(), moved.verbs.clone()].concat();
        let points = [r.points.clone(), moved.points.clone()].concat();
        let u = boolean_op_impl(0, &verbs, &points, &[r.verbs.len() as u32, moved.verbs.len() as u32], &[0, 0]).unwrap();
        assert_eq!(path_bounds_impl(&u.verbs, &u.points, &[]).unwrap(), vec![0.0, 0.0, 15.0, 15.0]);
        assert!(boolean_op_impl(0, &verbs, &points, &[r.verbs.len() as u32, moved.verbs.len() as u32], &[0]).is_err());
        assert_eq!(hit_test_impl(&u.verbs, &u.points, &[], 12.0, 12.0, 0.0, 0, 0.0).unwrap(), 1);
        assert_eq!(hit_test_impl(&u.verbs, &u.points, &[], 12.0, 2.0, 0.0, 0, 0.0).unwrap(), 0);
        assert!(intersects_rect_impl(&u.verbs, &u.points, &[], &[14.0, 14.0, 20.0, 20.0], false, true).unwrap());
        assert_eq!(ink_bounds_impl(&r.verbs, &r.points, &[], &[2.0, 0.0, 0.0, 0.0, 4.0], &[]).unwrap(), vec![-1.0, -1.0, 11.0, 11.0]);
        let p = parse_path_impl("M0 0 L4 0 L4 4 Z").unwrap();
        assert_eq!(p.svg(), "M0,0 L4,0 L4,4 Z");
        assert!(parse_path_impl("nope").is_err());
        assert!(radii_of(&[1.0, 2.0, 3.0]).is_err());
        let rounded = round_path_impl(&r.verbs, &r.points, &[2.0], 0.0).unwrap();
        assert!(rounded.verbs.contains(&3), "corners became curves");
        assert_eq!(round_path_impl(&r.verbs, &r.points, &[0.0, 0.0, 0.0, 0.0], 0.0).unwrap().verbs.iter().filter(|v| **v == 3).count(), 0);
        assert!(round_path_impl(&r.verbs, &r.points, &[f64::NAN], 0.0).is_err());
        assert_eq!(geometry_version(), GEOMETRY_VERSION);
    }

    #[test]
    fn outline_stroke_respects_alignment() {
        use kurbo::Shape;
        let r = shape_outline_impl(0, 10.0, 10.0, 0, 0.0, &[], 0.0).unwrap();
        let area = |p: &PathData| from_flat(&p.verbs, &p.points).unwrap().area().abs();
        let center = outline_stroke_impl(&r.verbs, &r.points, &[2.0, 0.0, 0.0, 0.0, 4.0]).unwrap();
        let inside = outline_stroke_impl(&r.verbs, &r.points, &[2.0, 1.0, 0.0, 0.0, 4.0]).unwrap();
        let outside = outline_stroke_impl(&r.verbs, &r.points, &[2.0, 2.0, 0.0, 0.0, 4.0]).unwrap();
        assert_eq!(path_bounds_impl(&center.verbs, &center.points, &[]).unwrap(), vec![-1.0, -1.0, 11.0, 11.0]);
        assert!((area(&inside) - (100.0 - 36.0)).abs() < 1e-6, "inside ring {}", area(&inside));
        assert!((area(&outside) - (196.0 - 100.0)).abs() < 1e-6, "outside ring {}", area(&outside));
        assert!(outline_stroke_impl(&r.verbs, &r.points, &[]).unwrap().verbs.is_empty());
    }
}
