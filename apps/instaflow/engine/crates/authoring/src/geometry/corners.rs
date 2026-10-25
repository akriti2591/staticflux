//! Rounded vertices for polygons, stars and vector paths (IF-20.x corner radius): each vertex between two straight
//! segments is replaced by a corner curve of its radius, optionally **smooth** (squircle-like: the curve starts
//! further out with longer handles, `smoothing` 0…1). A radius never exceeds what the adjacent segments allow (the
//! curve starts at most halfway along each), so neighbouring corners never overlap. Vertices next to curves stay sharp.

use kurbo::{BezPath, PathEl, Vec2};

/// Handle length of a corner curve as a fraction of its tangent length, for a turn of `phi` radians, plus smoothing.
fn handle_fraction(phi: f64, tangent: f64, radius: f64, smoothing: f64) -> f64 {
    let arc = if tangent > 0.0 { 4.0 / 3.0 * (phi / 4.0).tan() * radius / tangent } else { 0.0 };
    (arc + 0.35 * smoothing).clamp(0.0, 1.0)
}

/// Round every vertex of the straight-line closed subpaths of `path`. `radius(i)` is the radius of vertex `i`,
/// counting vertices across subpaths in order (the first point of each subpath is its vertex 0).
pub fn round_vertices(path: &BezPath, radius: &dyn Fn(usize) -> f64, smoothing: f64) -> BezPath {
    let s = if smoothing.is_finite() { smoothing.clamp(0.0, 1.0) } else { 0.0 };
    let mut out = BezPath::new();
    let mut vertex_base = 0usize;
    let elements = path.elements();
    let mut i = 0;
    while i < elements.len() {
        // Collect one subpath.
        let PathEl::MoveTo(start) = elements[i] else {
            out.push(elements[i]);
            i += 1;
            continue;
        };
        let mut j = i + 1;
        let mut points = vec![start];
        let mut straight = true;
        let mut closed = false;
        while j < elements.len() {
            match elements[j] {
                PathEl::LineTo(p) => points.push(p),
                PathEl::ClosePath => {
                    closed = true;
                    j += 1;
                    break;
                }
                PathEl::MoveTo(_) => break,
                _ => straight = false,
            }
            j += 1;
        }
        if points.len() > 1 && points.first() == points.last() {
            points.pop();
        }
        let n = points.len();
        let any = (0..n).any(|k| radius(vertex_base + k) > 0.0);
        if !straight || !closed || n < 3 || !any {
            for el in &elements[i..j] {
                out.push(*el);
            }
        } else {
            let mut corners = Vec::with_capacity(n);
            for k in 0..n {
                let v = points[k];
                let prev = points[(k + n - 1) % n];
                let next = points[(k + 1) % n];
                let (a, b): (Vec2, Vec2) = (prev - v, next - v);
                let (la, lb) = (a.hypot(), b.hypot());
                let r = radius(vertex_base + k);
                if !(r > 0.0) || la == 0.0 || lb == 0.0 {
                    corners.push((v, v, v, v));
                    continue;
                }
                let (ua, ub) = (a / la, b / lb);
                let theta = ua.dot(ub).clamp(-1.0, 1.0).acos(); // interior angle
                if theta < 1e-6 || (std::f64::consts::PI - theta) < 1e-6 {
                    corners.push((v, v, v, v));
                    continue;
                }
                let limit = 0.5 * la.min(lb);
                let mut t = r / (theta / 2.0).tan();
                let mut rr = r;
                if t > limit {
                    rr *= limit / t;
                    t = limit;
                }
                let t_smooth = (t * (1.0 + s)).min(limit);
                let k_frac = handle_fraction(std::f64::consts::PI - theta, t, rr, s);
                let p1 = v + ua * t_smooth;
                let p2 = v + ub * t_smooth;
                let c1 = p1 + (v - p1) * k_frac;
                let c2 = p2 + (v - p2) * k_frac;
                corners.push((p1, c1, c2, p2));
            }
            let (first_in, ..) = corners[0];
            out.move_to(first_in);
            for k in 0..n {
                let (p1, c1, c2, p2) = corners[k];
                if p1 != p2 {
                    out.curve_to(c1, c2, p2);
                }
                let (next_in, ..) = corners[(k + 1) % n];
                if k + 1 < n {
                    out.line_to(next_in);
                }
            }
            out.close_path();
        }
        vertex_base += n;
        i = j;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::shapes::{polygon, rect, star};
    use kurbo::{Rect, Shape};

    #[test]
    fn rounds_a_square_like_a_rounded_rect() {
        let square = rect(100.0, 100.0, [0.0; 4]);
        let rounded = round_vertices(&square, &|_| 20.0, 0.0);
        let expected = rect(100.0, 100.0, [20.0; 4]).area().abs();
        assert!((rounded.area().abs() - expected).abs() < 1.0, "{} vs {expected}", rounded.area().abs());
        assert_eq!(rounded.bounding_box(), Rect::new(0.0, 0.0, 100.0, 100.0));
    }

    #[test]
    fn clamps_to_half_the_shorter_segment_and_keeps_curves_sharp() {
        let tri = polygon(100.0, 100.0, 3).unwrap();
        let huge = round_vertices(&tri, &|_| 1e6, 0.0);
        assert!(huge.area().abs() > 0.0 && huge.area().abs() < tri.area().abs());
        assert!(huge.elements().iter().all(|e| e.end_point().is_none_or(|p| p.is_finite())));
        let mut curved = BezPath::new();
        curved.move_to((0.0, 0.0));
        curved.quad_to((5.0, 5.0), (10.0, 0.0));
        curved.line_to((10.0, 10.0));
        curved.close_path();
        assert_eq!(round_vertices(&curved, &|_| 3.0, 0.0), curved);
    }

    #[test]
    fn star_inner_and_outer_vertices_round_separately() {
        let s = star(100.0, 100.0, 5, 0.5).unwrap();
        let outer_only = round_vertices(&s, &|i| if i % 2 == 0 { 10.0 } else { 0.0 }, 0.0);
        let both = round_vertices(&s, &|i| if i % 2 == 0 { 10.0 } else { 6.0 }, 0.0);
        assert_ne!(outer_only, both);
        assert!(outer_only.area().abs() < s.area().abs());
        let smooth = round_vertices(&s, &|_| 10.0, 1.0);
        assert!((smooth.area().abs() - both.area().abs()).abs() > 1e-6);
    }
}
