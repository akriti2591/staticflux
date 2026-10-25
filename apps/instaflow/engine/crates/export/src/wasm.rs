//! The export Wasm's exports (ABI 1). One `Exporter` per export job, in the export worker:
//!
//! ```text
//! apply(batch)                         the job's scene (scene IR v4; a full batch starting with CLEAR)
//! isolate(nodes) -> batch              a selection as its own scene (apply it, or send it to the render module)
//! bounds() -> [x0, y0, x1, y1]         world bounds of the scene (empty: nothing)
//! plan(format, x0, y0, x1, y1, scale)  the raster patches `format` needs (`plan::encode`)
//! patch(node, w, h, rgba)              the pixels of one planned patch (rendered by the render module)
//! svg(x0, y0, x1, y1, w, h, bg, title) the region as an SVG document (bg: RGBA, empty = transparent)
//! pdf_page(x0, y0, x1, y1, w, h, bg)   one PDF page from the region
//! pdf_finish(title) -> bytes           the PDF (the exporter can start a new one after)
//! ```

use crate::pdf::PdfWriter;
use crate::plan::{Format, Patch, isolate_ir, members_bounds, plan, sites};
use crate::record::{PatchSite, record};
use crate::svg::{PatchImage, SvgOptions};
use render::ir::Scene;
use std::collections::{HashMap, HashSet};
use vello_common::kurbo::{Affine, Rect};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn abi_version() -> u32 {
    crate::ABI_VERSION
}

/// Scene IR wire version this module reads.
#[wasm_bindgen]
pub fn ir_version() -> u32 {
    render::ir::VERSION as u32
}

fn background(bg: &[u8]) -> Option<[u8; 4]> {
    (bg.len() == 4).then(|| [bg[0], bg[1], bg[2], bg[3]])
}

/// The view of an export: world `region` → `width × height` output px.
pub fn view_of(region: Rect, width: f64, height: f64) -> Affine {
    Affine::scale_non_uniform(width / region.width().max(1e-9), height / region.height().max(1e-9)) * Affine::translate((-region.x0, -region.y0))
}

#[wasm_bindgen]
#[derive(Default)]
pub struct Exporter {
    scene: Scene,
    planned: Vec<Patch>,
    sites: HashMap<u32, PatchSite>,
    patches: HashMap<u32, PatchImage>,
    pdf: Option<PdfWriter>,
}

impl Exporter {
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    pub fn planned(&self) -> &[Patch] {
        &self.planned
    }

    pub fn svg_string(&self, region: Rect, width: f64, height: f64, bg: Option<[u8; 4]>, title: &str) -> Result<String, String> {
        let view = view_of(region, width, height);
        let items = record(&self.scene, view, Rect::new(-2.0, -2.0, width + 2.0, height + 2.0), None, &self.sites);
        crate::svg::write(&self.scene, &items, &self.patches, &SvgOptions { width, height, background: bg, title: title.to_string() }).map_err(|e| e.0)
    }

    pub fn pdf_add(&mut self, region: Rect, width: f64, height: f64, bg: Option<[u8; 4]>) -> Result<(), String> {
        let view = view_of(region, width, height);
        let items = record(&self.scene, view, Rect::new(-2.0, -2.0, width + 2.0, height + 2.0), None, &self.sites);
        let writer = self.pdf.get_or_insert_with(PdfWriter::new);
        writer.page(&self.scene, &items, &self.patches, width, height, bg).map_err(|e| e.0)
    }

    pub fn pdf_bytes(&mut self, title: &str) -> Result<Vec<u8>, String> {
        self.pdf.take().ok_or_else(|| "no PDF page was added".to_string())?.finish(title).map_err(|e| e.0)
    }

    pub fn plan_for(&mut self, format: Format, region: Rect, scale: f64) -> &[Patch] {
        self.planned = plan(&self.scene, format, region, None, scale);
        self.sites = sites(&self.planned);
        self.patches.clear();
        &self.planned
    }

    pub fn set_patch(&mut self, node: u32, width: u32, height: u32, rgba: Vec<u8>) -> Result<(), String> {
        if !self.sites.contains_key(&node) {
            return Err(format!("node {node} is not in the patch plan"));
        }
        if width == 0 || height == 0 || rgba.len() != (width * height * 4) as usize {
            return Err(format!("patch {node}: {} bytes for {width}×{height}", rgba.len()));
        }
        self.patches.insert(node, PatchImage { width, height, rgba });
        Ok(())
    }
}

fn rect(x0: f64, y0: f64, x1: f64, y1: f64) -> Result<Rect, JsValue> {
    if !(x1 > x0 && y1 > y0) || ![x0, y0, x1, y1].iter().all(|v| v.is_finite()) {
        return Err(JsValue::from_str(&format!("invalid export region {x0},{y0},{x1},{y1}")));
    }
    Ok(Rect::new(x0, y0, x1, y1))
}

fn js(e: String) -> JsValue {
    JsValue::from_str(&e)
}

#[wasm_bindgen]
impl Exporter {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Exporter {
        Exporter::default()
    }

    /// Apply one scene IR batch (a new scene starts with CLEAR); the patch plan is dropped.
    pub fn apply(&mut self, batch: &[u8]) -> Result<(), JsValue> {
        self.scene.apply(batch).map_err(|e| JsValue::from_str(&e.0))?;
        self.planned.clear();
        self.sites.clear();
        self.patches.clear();
        Ok(())
    }

    /// These scene nodes (and what holds and masks them) as a full batch of their own.
    pub fn isolate(&self, nodes: &[u32]) -> Vec<u8> {
        let members: HashSet<u32> = nodes.iter().copied().collect();
        isolate_ir(&self.scene, &members)
    }

    /// World bounds of the scene, or of `nodes` when given (empty: nothing to draw).
    pub fn bounds(&self, nodes: &[u32]) -> Vec<f64> {
        let b = if nodes.is_empty() { self.scene.bounds() } else { members_bounds(&self.scene, &nodes.iter().copied().collect()) };
        b.map_or(Vec::new(), |r| vec![r.x0, r.y0, r.x1, r.y1])
    }

    /// The raster patches `format` (0 SVG, 1 PDF) needs for the region at `scale` patch px per world px
    /// (`plan::encode`; each patch's pixel size is its world rect × `scale`, exactly).
    #[allow(clippy::too_many_arguments)]
    pub fn plan(&mut self, format: u8, x0: f64, y0: f64, x1: f64, y1: f64, scale: f64) -> Result<Vec<u8>, JsValue> {
        let format = Format::from_u8(format).ok_or_else(|| JsValue::from_str(&format!("unknown export format {format}")))?;
        let region = rect(x0, y0, x1, y1)?;
        Ok(crate::plan::encode(self.plan_for(format, region, scale)))
    }

    pub fn patch(&mut self, node: u32, width: u32, height: u32, rgba: Vec<u8>) -> Result<(), JsValue> {
        self.set_patch(node, width, height, rgba).map_err(js)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn svg(&self, x0: f64, y0: f64, x1: f64, y1: f64, width: f64, height: f64, background: &[u8], title: &str) -> Result<String, JsValue> {
        self.svg_string(rect(x0, y0, x1, y1)?, width, height, self::background(background), title).map_err(js)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn pdf_page(&mut self, x0: f64, y0: f64, x1: f64, y1: f64, width: f64, height: f64, background: &[u8]) -> Result<(), JsValue> {
        self.pdf_add(rect(x0, y0, x1, y1)?, width, height, self::background(background)).map_err(js)
    }

    pub fn pdf_finish(&mut self, title: &str) -> Result<Vec<u8>, JsValue> {
        self.pdf_bytes(title).map_err(js)
    }
}
