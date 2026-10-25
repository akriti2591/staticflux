//! Element geometry for Instaflow (M1 B1; IF-7.8, IF-7.9, IF-20.x): kurbo paths, analytic shape outlines,
//! linesweeper booleans (derived, non-destructive), flatten and outline-stroke, exact bounds and ink bounds for the
//! spatial index, and precise hit tests for tools. Pure Rust; `exports.rs` is the Wasm ABI the TypeScript geometry
//! service (`apps/instaflow/src/elements/geometry.ts`) calls in the editor worker.

pub mod boolean;
pub mod bounds;
pub mod corners;
pub mod exports;
pub mod hit;
pub mod path;
pub mod shapes;

/// A geometry input error (the TypeScript side maps it to `IF-EL-005`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GeomError(pub String);

impl GeomError {
    pub fn new(message: impl Into<String>) -> Self {
        GeomError(message.into())
    }
}

impl std::fmt::Display for GeomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Version of the geometry exports (`geometry_version()`); the TypeScript loader checks it. Bump on breaking changes.
pub const GEOMETRY_VERSION: u32 = 1;
