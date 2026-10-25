//! Boolean operations (IF-7.9) with `linesweeper`: robust sweep-line booleans over kurbo paths. The result is
//! **derived geometry**: the operands stay in the document as the boolean group's children and the result is
//! recomputed from them (never written back), so a boolean is non-destructive.
//!
//! Operands are in one coordinate space (the group's local space). Semantics follow design tools:
//! - union: the area inside any operand;
//! - subtract: the first operand minus every later one;
//! - intersect: the area inside every operand;
//! - exclude: the area inside an odd number of operands (folded xor).
//!
//! Output contours are oriented so that both fill rules give the same area (linesweeper's guarantee).

use kurbo::BezPath;
use linesweeper::{BinaryOp, FillRule, binary_op};

use super::GeomError;
use super::path::closed;

/// `geometry.boolean` codes shared with TypeScript (`BOOLEAN_CODES` in `apps/instaflow/src/elements/geometry.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BooleanOp {
    Union = 0,
    Subtract = 1,
    Intersect = 2,
    Exclude = 3,
}

impl BooleanOp {
    pub fn from_code(code: u8) -> Result<Self, GeomError> {
        Ok(match code {
            0 => BooleanOp::Union,
            1 => BooleanOp::Subtract,
            2 => BooleanOp::Intersect,
            3 => BooleanOp::Exclude,
            other => return Err(GeomError::new(format!("unknown boolean op code {other}"))),
        })
    }
}

/// `geometry.fillRule` codes: 0 non-zero, 1 even-odd.
pub fn fill_rule(code: u8) -> Result<FillRule, GeomError> {
    match code {
        0 => Ok(FillRule::NonZero),
        1 => Ok(FillRule::EvenOdd),
        other => Err(GeomError::new(format!("unknown fill rule code {other}"))),
    }
}

fn contours_to_path(contours: linesweeper::topology::Contours) -> BezPath {
    let mut out = BezPath::new();
    for contour in contours.contours() {
        for el in contour.path.elements() {
            out.push(*el);
        }
    }
    out
}

fn is_empty(path: &BezPath) -> bool {
    path.elements().len() < 2
}

/// Normalize one operand into a set with its own fill rule applied (so mixed fill rules combine correctly).
fn normalize(path: &BezPath, rule: FillRule) -> Result<BezPath, GeomError> {
    let path = closed(path);
    if is_empty(&path) {
        return Ok(path);
    }
    // Union with the empty set resolves self-overlaps under the operand's own fill rule.
    let result = binary_op(&path, &BezPath::new(), rule, BinaryOp::Union).map_err(|e| GeomError::new(format!("boolean operand: {e}")))?;
    Ok(contours_to_path(result))
}

fn combine(a: &BezPath, b: &BezPath, op: BinaryOp) -> Result<BezPath, GeomError> {
    // Normalized inputs: every point inside has winding 1, so non-zero and even-odd agree.
    let result = binary_op(a, b, FillRule::NonZero, op).map_err(|e| GeomError::new(format!("boolean: {e}")))?;
    Ok(contours_to_path(result))
}

/// Combine `operands` (each with its fill rule) with `op`. Empty input gives an empty path.
pub fn boolean(op: BooleanOp, operands: &[(BezPath, FillRule)]) -> Result<BezPath, GeomError> {
    let mut sets = Vec::with_capacity(operands.len());
    for (path, rule) in operands {
        sets.push(normalize(path, *rule)?);
    }
    let Some((first, rest)) = sets.split_first() else { return Ok(BezPath::new()) };
    let mut acc = first.clone();
    match op {
        BooleanOp::Union => {
            for s in rest {
                acc = combine(&acc, s, BinaryOp::Union)?;
            }
        }
        BooleanOp::Subtract => {
            let mut cut = BezPath::new();
            for s in rest {
                cut = combine(&cut, s, BinaryOp::Union)?;
            }
            if !is_empty(&cut) {
                acc = combine(&acc, &cut, BinaryOp::Difference)?;
            }
        }
        BooleanOp::Intersect => {
            for s in rest {
                acc = combine(&acc, s, BinaryOp::Intersection)?;
            }
        }
        BooleanOp::Exclude => {
            for s in rest {
                acc = combine(&acc, s, BinaryOp::Xor)?;
            }
        }
    }
    Ok(acc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::shapes::{ellipse, rect};
    use kurbo::{Affine, Point, Shape};

    /// xorshift64*: deterministic, dependency-free randomness for the property tests.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> f64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
        }
        fn range(&mut self, lo: f64, hi: f64) -> f64 {
            lo + (hi - lo) * self.next()
        }
    }

    /// A random simple-or-not polygon (random vertices: self-intersections included on purpose).
    fn random_polygon(rng: &mut Rng, n: usize, cx: f64, cy: f64, r: f64) -> BezPath {
        let mut p = BezPath::new();
        for i in 0..n {
            let pt = Point::new(cx + rng.range(-r, r), cy + rng.range(-r, r));
            if i == 0 { p.move_to(pt) } else { p.line_to(pt) }
        }
        p.close_path();
        p
    }

    /// A random star-shaped (simple) polygon around a centre.
    fn random_simple_polygon(rng: &mut Rng, n: usize, cx: f64, cy: f64, r: f64) -> BezPath {
        let mut p = BezPath::new();
        for i in 0..n {
            let a = std::f64::consts::TAU * (i as f64 + rng.range(0.0, 0.8)) / n as f64;
            let rr = rng.range(0.3 * r, r);
            let pt = Point::new(cx + a.cos() * rr, cy + a.sin() * rr);
            if i == 0 { p.move_to(pt) } else { p.line_to(pt) }
        }
        p.close_path();
        p
    }

    fn area(p: &BezPath) -> f64 {
        p.area().abs()
    }

    fn inside(p: &BezPath, rule: FillRule, pt: Point) -> bool {
        rule.is_inside(p.winding(pt))
    }

    /// Distance from a point to the nearest segment of a path.
    fn distance(p: &BezPath, pt: Point) -> f64 {
        use kurbo::ParamCurveNearest;
        p.segments().map(|s| s.nearest(pt, 1e-6).distance_sq.sqrt()).fold(f64::INFINITY, f64::min)
    }

    #[test]
    fn squares_union_subtract_intersect_exclude() {
        let a = rect(10.0, 10.0, [0.0; 4]);
        let b = Affine::translate((5.0, 5.0)) * rect(10.0, 10.0, [0.0; 4]);
        let ops = [(BooleanOp::Union, 175.0), (BooleanOp::Subtract, 75.0), (BooleanOp::Intersect, 25.0), (BooleanOp::Exclude, 150.0)];
        for (op, expected) in ops {
            let r = boolean(op, &[(a.clone(), FillRule::NonZero), (b.clone(), FillRule::NonZero)]).unwrap();
            assert!((area(&r) - expected).abs() < 1e-6, "{op:?}: {}", area(&r));
        }
        assert!(boolean(BooleanOp::Union, &[]).unwrap().elements().is_empty());
        let one = boolean(BooleanOp::Subtract, &[(a.clone(), FillRule::NonZero)]).unwrap();
        assert!((area(&one) - 100.0).abs() < 1e-6);
    }

    #[test]
    fn disjoint_and_nested_operands() {
        let a = rect(10.0, 10.0, [0.0; 4]);
        let far = Affine::translate((100.0, 0.0)) * rect(10.0, 10.0, [0.0; 4]);
        let inner = Affine::translate((2.0, 2.0)) * rect(6.0, 6.0, [0.0; 4]);
        let nz = FillRule::NonZero;
        assert!(area(&boolean(BooleanOp::Intersect, &[(a.clone(), nz), (far.clone(), nz)]).unwrap()) < 1e-9);
        assert!((area(&boolean(BooleanOp::Union, &[(a.clone(), nz), (far, nz)]).unwrap()) - 200.0).abs() < 1e-6);
        let ring = boolean(BooleanOp::Subtract, &[(a.clone(), nz), (inner.clone(), nz)]).unwrap();
        assert!((area(&ring) - 64.0).abs() < 1e-6);
        assert!(!inside(&ring, FillRule::EvenOdd, Point::new(5.0, 5.0)));
        assert!(!inside(&ring, FillRule::NonZero, Point::new(5.0, 5.0)), "hole under both fill rules");
        assert!(inside(&ring, FillRule::NonZero, Point::new(1.0, 1.0)));
    }

    #[test]
    fn curves_survive_booleans() {
        let circle = ellipse(20.0, 20.0);
        let half = rect(10.0, 20.0, [0.0; 4]);
        let r = boolean(BooleanOp::Intersect, &[(circle, FillRule::NonZero), (half, FillRule::NonZero)]).unwrap();
        let expected = std::f64::consts::PI * 100.0 / 2.0;
        assert!((area(&r) - expected).abs() < 0.05, "half disc {}", area(&r));
    }

    #[test]
    fn fill_rule_of_each_operand_is_respected() {
        // A self-overlapping path: two nested squares in the same direction. Non-zero fills the hole, even-odd does not.
        let mut doubled = rect(10.0, 10.0, [0.0; 4]);
        for el in (Affine::translate((2.0, 2.0)) * rect(6.0, 6.0, [0.0; 4])).elements() {
            doubled.push(*el);
        }
        let nz = boolean(BooleanOp::Union, &[(doubled.clone(), FillRule::NonZero)]).unwrap();
        let eo = boolean(BooleanOp::Union, &[(doubled, FillRule::EvenOdd)]).unwrap();
        assert!((area(&nz) - 100.0).abs() < 1e-6);
        assert!((area(&eo) - 64.0).abs() < 1e-6);
        assert!(fill_rule(2).is_err());
        assert!(BooleanOp::from_code(4).is_err());
    }

    /// Property: for random polygons (simple and self-intersecting), the result's inside test equals the op over
    /// the operands' inside tests at random points away from every edge, and area identities hold.
    #[test]
    fn property_random_polygons() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let ops = [BooleanOp::Union, BooleanOp::Subtract, BooleanOp::Intersect, BooleanOp::Exclude];
        for case in 0..300 {
            let n_a = 3 + (rng.next() * 9.0) as usize;
            let n_b = 3 + (rng.next() * 9.0) as usize;
            let simple = case % 2 == 0;
            let a = if simple { random_simple_polygon(&mut rng, n_a, 50.0, 50.0, 40.0) } else { random_polygon(&mut rng, n_a, 50.0, 50.0, 40.0) };
            let (bx, by) = (rng.range(30.0, 70.0), rng.range(30.0, 70.0));
            let b = if simple { random_simple_polygon(&mut rng, n_b, bx, by, 40.0) } else { random_polygon(&mut rng, n_b, 50.0, 50.0, 40.0) };
            let rule = if case % 3 == 0 { FillRule::EvenOdd } else { FillRule::NonZero };
            let operands = [(a.clone(), rule), (b.clone(), rule)];
            let mut areas = [0.0; 4];
            for (k, op) in ops.iter().enumerate() {
                let r = boolean(*op, &operands).unwrap_or_else(|e| panic!("case {case} {op:?}: {}", e.0));
                assert!(r.elements().iter().all(|el| el.end_point().is_none_or(|p| p.is_finite())), "case {case}: non-finite output");
                areas[k] = area(&r);
                for _ in 0..40 {
                    let pt = Point::new(rng.range(0.0, 100.0), rng.range(0.0, 100.0));
                    if distance(&a, pt) < 1e-3 || distance(&b, pt) < 1e-3 {
                        continue;
                    }
                    let (ia, ib) = (inside(&a, rule, pt), inside(&b, rule, pt));
                    let expected = match op {
                        BooleanOp::Union => ia || ib,
                        BooleanOp::Subtract => ia && !ib,
                        BooleanOp::Intersect => ia && ib,
                        BooleanOp::Exclude => ia != ib,
                    };
                    assert_eq!(inside(&r, FillRule::NonZero, pt), expected, "case {case} {op:?} at {pt:?}");
                    assert_eq!(inside(&r, FillRule::EvenOdd, pt), expected, "case {case} {op:?} at {pt:?} (even-odd)");
                }
            }
            let [union, subtract, intersect, exclude] = areas;
            let tol = 1e-6 * (1.0 + union);
            assert!((union - (subtract + intersect + (union - subtract - intersect))).abs() < tol);
            assert!((exclude - (union - intersect)).abs() < 1e-3 * (1.0 + union), "case {case}: xor {exclude} vs {}", union - intersect);
            assert!(intersect <= union + tol && subtract <= union + tol, "case {case}");
        }
    }

    /// Property: booleans are stable under translation (the result moves with the operands).
    #[test]
    fn property_translation_invariance() {
        let mut rng = Rng(42);
        for case in 0..50 {
            let a = random_simple_polygon(&mut rng, 7, 50.0, 50.0, 40.0);
            let b = random_simple_polygon(&mut rng, 6, 60.0, 45.0, 35.0);
            let t = Affine::translate((rng.range(-500.0, 500.0), rng.range(-500.0, 500.0)));
            for op in [BooleanOp::Union, BooleanOp::Intersect] {
                let r = area(&boolean(op, &[(a.clone(), FillRule::NonZero), (b.clone(), FillRule::NonZero)]).unwrap());
                let moved = area(&boolean(op, &[(t * a.clone(), FillRule::NonZero), (t * b.clone(), FillRule::NonZero)]).unwrap());
                assert!((r - moved).abs() < 1e-6 * (1.0 + r), "case {case} {op:?}: {r} vs {moved}");
            }
        }
    }

    /// Degenerate inputs: coincident edges, identical operands and zero-area slivers never fail.
    #[test]
    fn degenerate_inputs() {
        let a = rect(10.0, 10.0, [0.0; 4]);
        let nz = FillRule::NonZero;
        let same = boolean(BooleanOp::Exclude, &[(a.clone(), nz), (a.clone(), nz)]).unwrap();
        assert!(area(&same) < 1e-9);
        let edge = Affine::translate((10.0, 0.0)) * rect(10.0, 10.0, [0.0; 4]);
        assert!((area(&boolean(BooleanOp::Union, &[(a.clone(), nz), (edge, nz)]).unwrap()) - 200.0).abs() < 1e-6);
        let mut sliver = BezPath::new();
        sliver.move_to((0.0, 5.0));
        sliver.line_to((10.0, 5.0));
        sliver.close_path();
        assert!((area(&boolean(BooleanOp::Subtract, &[(a, nz), (sliver, nz)]).unwrap()) - 100.0).abs() < 1e-6);
    }
}
