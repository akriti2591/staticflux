//! Flat path data shared with TypeScript and the scene IR: `verbs` (move 0, line 1, quad 2, cubic 3,
//! close 4) and `points` (`x, y` pairs: move/line 1 point, quad 2, cubic 3, close 0). The same encoding
//! as `PATH_VERBS` in `apps/instaflow/src/render/scene-ir.ts`, so outlines go to the renderer unchanged.

use kurbo::{Affine, BezPath, PathEl, Point};

use super::GeomError;

pub const MOVE: u8 = 0;
pub const LINE: u8 = 1;
pub const QUAD: u8 = 2;
pub const CUBIC: u8 = 3;
pub const CLOSE: u8 = 4;

/// Points used by one verb.
pub fn arity(verb: u8) -> Option<usize> {
    match verb {
        MOVE | LINE => Some(1),
        QUAD => Some(2),
        CUBIC => Some(3),
        CLOSE => Some(0),
        _ => None,
    }
}

/// Decode flat path data into a kurbo path. Every point must be finite and used exactly once.
pub fn from_flat(verbs: &[u8], points: &[f64]) -> Result<BezPath, GeomError> {
    if points.len() % 2 != 0 {
        return Err(GeomError::new("path points come in x, y pairs"));
    }
    if points.iter().any(|v| !v.is_finite()) {
        return Err(GeomError::new("path points must be finite"));
    }
    let pt = |i: usize| Point::new(points[2 * i], points[2 * i + 1]);
    let total = points.len() / 2;
    let mut path = BezPath::new();
    let mut at = 0usize;
    let mut open = false;
    for &verb in verbs {
        let n = arity(verb).ok_or_else(|| GeomError::new(format!("unknown path verb {verb}")))?;
        if at + n > total {
            return Err(GeomError::new("path verbs use more points than given"));
        }
        if verb != MOVE && verb != CLOSE && !open {
            return Err(GeomError::new("path segment before its move"));
        }
        match verb {
            MOVE => {
                path.move_to(pt(at));
                open = true;
            }
            LINE => path.line_to(pt(at)),
            QUAD => path.quad_to(pt(at), pt(at + 1)),
            CUBIC => path.curve_to(pt(at), pt(at + 1), pt(at + 2)),
            _ => {
                if open {
                    path.close_path();
                }
                open = false;
            }
        }
        at += n;
    }
    if at != total {
        return Err(GeomError::new("path has unused points"));
    }
    Ok(path)
}

/// Encode a kurbo path as flat data.
pub fn to_flat(path: &BezPath) -> (Vec<u8>, Vec<f64>) {
    let mut verbs = Vec::with_capacity(path.elements().len());
    let mut points = Vec::with_capacity(path.elements().len() * 2);
    let push = |p: Point, points: &mut Vec<f64>| {
        points.push(p.x);
        points.push(p.y);
    };
    for el in path.elements() {
        match *el {
            PathEl::MoveTo(a) => {
                verbs.push(MOVE);
                push(a, &mut points);
            }
            PathEl::LineTo(a) => {
                verbs.push(LINE);
                push(a, &mut points);
            }
            PathEl::QuadTo(a, b) => {
                verbs.push(QUAD);
                push(a, &mut points);
                push(b, &mut points);
            }
            PathEl::CurveTo(a, b, c) => {
                verbs.push(CUBIC);
                push(a, &mut points);
                push(b, &mut points);
                push(c, &mut points);
            }
            PathEl::ClosePath => verbs.push(CLOSE),
        }
    }
    (verbs, points)
}

/// Parse SVG path data (`geometry.path`). Arcs become cubics.
pub fn parse_svg(d: &str) -> Result<BezPath, GeomError> {
    let path = BezPath::from_svg(d).map_err(|e| GeomError::new(format!("invalid SVG path data: {e}")))?;
    if path.elements().iter().any(|el| el.end_point().is_some_and(|p| !p.is_finite())) {
        return Err(GeomError::new("SVG path data has non-finite coordinates"));
    }
    Ok(path)
}

/// A six-coefficient affine (kurbo order `[a, b, c, d, e, f]`).
pub fn affine(coeffs: &[f64]) -> Result<Affine, GeomError> {
    match coeffs {
        [] => Ok(Affine::IDENTITY),
        [a, b, c, d, e, f] if coeffs.iter().all(|v| v.is_finite()) => Ok(Affine::new([*a, *b, *c, *d, *e, *f])),
        _ => Err(GeomError::new("a transform is six finite numbers [a, b, c, d, e, f]")),
    }
}

/// Every subpath closed (booleans need closed curves; an open subpath closes back to its start, like a fill).
pub fn closed(path: &BezPath) -> BezPath {
    let mut out = BezPath::new();
    let mut open = false;
    for el in path.elements() {
        match el {
            PathEl::MoveTo(_) => {
                if open {
                    out.close_path();
                }
                out.push(*el);
                open = true;
            }
            PathEl::ClosePath => {
                if open {
                    out.close_path();
                }
                open = false;
            }
            other => out.push(*other),
        }
    }
    if open {
        out.close_path();
    }
    out
}

/// Split concatenated flat paths (`verb_counts[i]` verbs each) into kurbo paths.
pub fn split_flat(verbs: &[u8], points: &[f64], verb_counts: &[u32]) -> Result<Vec<BezPath>, GeomError> {
    let mut paths = Vec::with_capacity(verb_counts.len());
    let mut v = 0usize;
    let mut p = 0usize;
    for &count in verb_counts {
        let count = count as usize;
        if v + count > verbs.len() {
            return Err(GeomError::new("verb counts exceed the verbs given"));
        }
        let own = &verbs[v..v + count];
        let mut n = 0usize;
        for &verb in own {
            n += arity(verb).ok_or_else(|| GeomError::new(format!("unknown path verb {verb}")))?;
        }
        if p + 2 * n > points.len() {
            return Err(GeomError::new("path verbs use more points than given"));
        }
        paths.push(from_flat(own, &points[p..p + 2 * n])?);
        v += count;
        p += 2 * n;
    }
    if v != verbs.len() || p != points.len() {
        return Err(GeomError::new("verb counts do not cover every verb and point"));
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flat_round_trip_and_validation() {
        let mut path = BezPath::new();
        path.move_to((0.0, 0.0));
        path.line_to((10.0, 0.0));
        path.quad_to((12.0, 5.0), (10.0, 10.0));
        path.curve_to((8.0, 12.0), (2.0, 12.0), (0.0, 10.0));
        path.close_path();
        let (verbs, points) = to_flat(&path);
        assert_eq!(verbs, vec![MOVE, LINE, QUAD, CUBIC, CLOSE]);
        assert_eq!(points.len(), 14);
        assert_eq!(from_flat(&verbs, &points).unwrap(), path);
        assert!(from_flat(&[MOVE], &[0.0]).is_err());
        assert!(from_flat(&[MOVE, LINE], &[0.0, 0.0]).is_err());
        assert!(from_flat(&[MOVE], &[0.0, 0.0, 1.0, 1.0]).is_err());
        assert!(from_flat(&[9], &[]).is_err());
        assert!(from_flat(&[LINE], &[1.0, 1.0]).is_err());
        assert!(from_flat(&[MOVE], &[f64::NAN, 0.0]).is_err());
    }

    #[test]
    fn parses_svg_and_closes_subpaths() {
        let p = parse_svg("M0 0 L10 0 L10 10 M20 20 L30 20 L30 30 Z").unwrap();
        let c = closed(&p);
        assert_eq!(c.elements().iter().filter(|e| matches!(e, PathEl::ClosePath)).count(), 2);
        assert!(parse_svg("M0 0 Q").is_err());
        let arc = parse_svg("M0 0 A5 5 0 0 1 10 0").unwrap();
        assert!(arc.elements().iter().any(|e| matches!(e, PathEl::CurveTo(..))));
    }

    #[test]
    fn splits_concatenated_paths_and_reads_transforms() {
        let (v1, p1) = to_flat(&parse_svg("M0 0 L1 0 L1 1 Z").unwrap());
        let (v2, p2) = to_flat(&parse_svg("M5 5 L6 5 L6 6 Z").unwrap());
        let verbs: Vec<u8> = [v1.clone(), v2.clone()].concat();
        let points: Vec<f64> = [p1, p2].concat();
        let paths = split_flat(&verbs, &points, &[v1.len() as u32, v2.len() as u32]).unwrap();
        assert_eq!(paths.len(), 2);
        assert!(split_flat(&verbs, &points, &[v1.len() as u32]).is_err());
        assert_eq!(affine(&[]).unwrap(), Affine::IDENTITY);
        assert!(affine(&[1.0, 0.0]).is_err());
        assert_eq!(affine(&[1.0, 0.0, 0.0, 1.0, 5.0, 6.0]).unwrap(), Affine::translate((5.0, 6.0)));
    }
}
