//! Pixel patterns (D21 `Fallback::PixelPattern`): paints a vector format has no primitive for, computed as an image
//! over the shape's local box. Conic (sweep) gradients only: neither SVG 1.1 nor PDF has one (PDF's PostScript
//! function shadings would do it, but readers render them unevenly and slowly).

use vello_common::color::Srgb;
use vello_common::kurbo::{Affine, Point, Rect};
use vello_common::peniko::{Extend, Gradient, GradientKind};

/// One gradient's stops as straight sRGB (`black`: colours forced to black, alpha kept: inverted masks).
pub fn stops(g: &Gradient, black: bool) -> Vec<(f32, [f32; 4])> {
    g.stops
        .iter()
        .map(|s| {
            let mut c = s.color.to_alpha_color::<Srgb>().components;
            if black {
                c = [0.0, 0.0, 0.0, c[3]];
            }
            (s.offset, c)
        })
        .collect()
}

/// The colour of a stop list at `t` (straight-alpha interpolation; `t` already extended into 0…1).
pub fn sample(stops: &[(f32, [f32; 4])], t: f32) -> [f32; 4] {
    let Some(first) = stops.first() else { return [0.0; 4] };
    if t <= first.0 {
        return first.1;
    }
    for w in stops.windows(2) {
        let (a, b) = (w[0], w[1]);
        if t <= b.0 {
            let k = (t - a.0) / (b.0 - a.0).max(1e-6);
            let mut out = [0.0; 4];
            for (i, o) in out.iter_mut().enumerate() {
                *o = a.1[i] + (b.1[i] - a.1[i]) * k;
            }
            return out;
        }
    }
    stops.last().map(|s| s.1).unwrap_or([0.0; 4])
}

pub fn extend(e: Extend, t: f32) -> f32 {
    match e {
        Extend::Pad => t.clamp(0.0, 1.0),
        Extend::Repeat => t.rem_euclid(1.0),
        Extend::Reflect => {
            let r = t.rem_euclid(2.0);
            if r > 1.0 { 2.0 - r } else { r }
        }
    }
}

/// A computed paint image: straight RGBA covering `local` (the shape's box in its local space).
pub struct PixelPattern {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub local: Rect,
}

/// Longest edge of a pixel pattern.
pub const MAX_EDGE: u32 = 1024;

/// A sweep gradient over `local`, at about two pixels per output px of `transform` (local → output). None for
/// other gradient kinds.
pub fn sweep(g: &Gradient, paint_transform: Affine, transform: Affine, local: Rect, black: bool) -> Option<PixelPattern> {
    let GradientKind::Sweep(p) = &g.kind else { return None };
    let stops = stops(g, black);
    let density = transform.determinant().abs().sqrt().max(0.01) * 2.0;
    let (bw, bh) = (local.width().max(1.0), local.height().max(1.0));
    let k = density.min(MAX_EDGE as f64 / bw.max(bh));
    let (w, h) = (((bw * k).ceil() as u32).clamp(1, MAX_EDGE), ((bh * k).ceil() as u32).clamp(1, MAX_EDGE));
    let inv = paint_transform.inverse();
    let (a0, a1) = (p.start_angle as f64, p.end_angle as f64);
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let pt = inv * Point::new(local.x0 + (x as f64 + 0.5) * bw / w as f64, local.y0 + (y as f64 + 0.5) * bh / h as f64);
            // Clockwise from +x in a y-down space, like peniko.
            let mut angle = (pt.y - p.center.y).atan2(pt.x - p.center.x);
            if angle < 0.0 {
                angle += std::f64::consts::TAU;
            }
            let t = if (a1 - a0).abs() < 1e-9 { 0.0 } else { ((angle - a0) / (a1 - a0)) as f32 };
            let c = sample(&stops, extend(g.extend, t));
            let i = ((y * w + x) * 4) as usize;
            for j in 0..4 {
                rgba[i + j] = (c[j].clamp(0.0, 1.0) * 255.0).round() as u8;
            }
        }
    }
    Some(PixelPattern { rgba, width: w, height: h, local: Rect::new(local.x0, local.y0, local.x0 + bw, local.y0 + bh) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use vello_common::color::AlphaColor;
    use vello_common::peniko::{ColorStop, ColorStops};

    #[test]
    fn samples_extends_and_sweeps() {
        assert_eq!(sample(&[(0.0, [0.0; 4]), (1.0, [1.0; 4])], 0.5), [0.5; 4]);
        assert_eq!(extend(Extend::Pad, 1.5), 1.0);
        assert!((extend(Extend::Repeat, 1.25) - 0.25).abs() < 1e-6);
        assert!((extend(Extend::Reflect, 1.25) - 0.75).abs() < 1e-6);
        let stops = [ColorStop::from((0.0, AlphaColor::<Srgb>::from_rgba8(255, 0, 0, 255))), ColorStop::from((1.0, AlphaColor::<Srgb>::from_rgba8(0, 0, 255, 255)))];
        let g = Gradient::new_sweep((10.0, 10.0), 0.0, std::f32::consts::TAU).with_stops(ColorStops::from(&stops[..]));
        let p = sweep(&g, Affine::IDENTITY, Affine::IDENTITY, Rect::new(0.0, 0.0, 20.0, 20.0), false).unwrap();
        assert_eq!((p.width, p.height), (40, 40));
        // just below the centre, a quarter turn clockwise: a quarter of the way from red to blue
        let i = ((30 * 40 + 20) * 4) as usize;
        assert!(p.rgba[i] > 150 && p.rgba[i + 2] < 110, "{:?}", &p.rgba[i..i + 4]);
        assert!(sweep(&Gradient::new_linear((0.0, 0.0), (1.0, 0.0)), Affine::IDENTITY, Affine::IDENTITY, Rect::new(0.0, 0.0, 1.0, 1.0), false).is_none());
    }
}
