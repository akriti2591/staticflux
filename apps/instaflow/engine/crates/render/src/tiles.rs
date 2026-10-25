//! Tile and region geometry shared by every backend. Mirrors `@staticflux/surface/raster`
//! (raster-tiling.ts): level `k` renders at `2^(k/2)` device px per world unit, tiles are `TILE` px.

use vello_common::kurbo::{Affine, Rect};

/// Tile edge in device pixels (S1: no seams, ≈ 6.7 ms CPU each).
pub const TILE: u32 = 512;

/// Anti-aliasing reaches this far (device px) past geometry; tile culling is inflated by it.
pub const AA_PAD: f64 = 2.0;

pub fn level_scale(level: i32) -> f64 {
    2f64.powf(level as f64 / 2.0)
}

/// World → tile pixels for tile (`level`, `tx`, `ty`).
pub fn tile_view(level: i32, tx: i32, ty: i32) -> Affine {
    let t = TILE as f64;
    Affine::translate((-(tx as f64) * t, -(ty as f64) * t)) * Affine::scale(level_scale(level))
}

/// World rect of a tile.
pub fn tile_world(level: i32, tx: i32, ty: i32) -> Rect {
    let span = TILE as f64 / level_scale(level);
    Rect::new(tx as f64 * span, ty as f64 * span, (tx + 1) as f64 * span, (ty + 1) as f64 * span)
}

/// World → output pixels mapping `world` onto a `width × height` image.
pub fn region_view(world: Rect, width: u32, height: u32) -> Affine {
    Affine::scale_non_uniform(width as f64 / world.width(), height as f64 / world.height()) * Affine::translate((-world.x0, -world.y0))
}

/// Device-pixel placement of a lifted layer texture: `(x, y, w, h)` at `zoom`, 1 px margin, clamped to `max`.
pub fn layer_placement(bounds: Rect, zoom: f64, max: u32) -> (f64, f64, u32, u32) {
    let x = (bounds.x0 * zoom).floor() - 1.0;
    let y = (bounds.y0 * zoom).floor() - 1.0;
    let w = (((bounds.x1 * zoom).ceil() + 1.0 - x).max(1.0) as u32).min(max);
    let h = (((bounds.y1 * zoom).ceil() + 1.0 - y).max(1.0) as u32).min(max);
    (x, y, w, h)
}

/// Straight-alpha RGBA8 from premultiplied RGBA8 (what the port carries).
pub fn unpremultiply(data: &mut [u8]) {
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 0 || a == 255 {
            if a == 0 {
                px[0] = 0;
                px[1] = 0;
                px[2] = 0;
            }
            continue;
        }
        for c in &mut px[..3] {
            *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
        }
    }
}

/// Premultiplied RGBA8 from straight RGBA8.
pub fn premultiply(data: &mut [u8]) {
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a == 255 {
            continue;
        }
        for c in &mut px[..3] {
            *c = ((*c as u32 * a + 127) / 255) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use vello_common::kurbo::Point;

    #[test]
    fn tile_math_matches_the_typescript_planner() {
        assert_eq!(tile_world(0, 1, 2), Rect::new(512.0, 1024.0, 1024.0, 1536.0));
        assert_eq!(tile_world(2, 1, 0), Rect::new(256.0, 0.0, 512.0, 256.0));
        assert!((level_scale(1) - std::f64::consts::SQRT_2).abs() < 1e-12);
        let v = tile_view(2, 1, 0);
        assert_eq!(v * Point::new(256.0, 0.0), Point::new(0.0, 0.0));
        assert_eq!(v * Point::new(512.0, 256.0), Point::new(512.0, 512.0));
        let r = region_view(Rect::new(10.0, 20.0, 30.0, 60.0), 40, 80);
        assert_eq!(r * Point::new(30.0, 60.0), Point::new(40.0, 80.0));
    }

    #[test]
    fn layer_placement_has_a_margin_and_a_cap() {
        assert_eq!(layer_placement(Rect::new(10.0, 10.0, 20.0, 15.0), 2.0, 4096), (19.0, 19.0, 22, 12));
        assert_eq!(layer_placement(Rect::new(0.0, 0.0, 1e6, 1.0), 1.0, 4096).2, 4096);
    }

    #[test]
    fn premultiply_round_trips_within_one_step() {
        let mut px = vec![200, 100, 50, 128, 10, 20, 30, 255, 99, 99, 99, 0];
        premultiply(&mut px);
        assert_eq!(&px[..4], &[100, 50, 25, 128]);
        unpremultiply(&mut px);
        assert!(px[..4].iter().zip([200u8, 100, 50, 128]).all(|(a, b)| (*a as i32 - b as i32).abs() <= 2));
        assert_eq!(&px[4..8], &[10, 20, 30, 255]);
        assert_eq!(&px[8..], &[0, 0, 0, 0]);
    }
}
