//! Native S7 parity tool: vello_cpu (native, SIMD auto) vs resvg (our SVG writer's output) vs
//! krilla PDF rasterized by poppler (pdftoppm), plus a real-text PDF check (pdftotext).
//!   cargo run --profile native -p native -- <out_dir>
use ir::Grid;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;

fn resvg_render(svg: &str, w: u32, h: u32) -> Vec<u8> {
    let mut opt = resvg::usvg::Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = resvg::usvg::Tree::from_str(svg, &opt).expect("svg parse");
    let mut pm = resvg::tiny_skia::Pixmap::new(w, h).unwrap();
    resvg::render(&tree, resvg::tiny_skia::Transform::identity(), &mut pm.as_mut());
    pm.data().to_vec()
}

fn read_png(p: &Path) -> (Vec<u8>, u32, u32) {
    let dec = png::Decoder::new(std::io::BufReader::new(std::fs::File::open(p).unwrap()));
    let mut r = dec.read_info().unwrap();
    let mut buf = vec![0; r.output_buffer_size().unwrap()];
    let info = r.next_frame(&mut buf).unwrap();
    let rgba = match info.color_type {
        png::ColorType::Rgb => buf[..info.buffer_size()].chunks_exact(3).flat_map(|c| [c[0], c[1], c[2], 255]).collect(),
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        t => panic!("unexpected png {t:?}"),
    };
    (rgba, info.width, info.height)
}

fn pdf_raster(pdf: &[u8], dir: &Path, name: &str) -> Option<(Vec<u8>, u32, u32)> {
    let f = dir.join(format!("{name}.pdf"));
    std::fs::write(&f, pdf).unwrap();
    let out = dir.join(name);
    let ok = Command::new("pdftoppm").args(["-r", "72", "-png", "-singlefile"]).arg(&f).arg(&out).status().ok()?.success();
    if !ok {
        return None;
    }
    Some(read_png(&out.with_extension("png")))
}

fn stats(v: &mut Vec<f64>) -> String {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let q = |p: f64| v[((v.len() - 1) as f64 * p).round() as usize];
    format!(
        "{{\"n\":{},\"min\":{:.5},\"p05\":{:.5},\"median\":{:.5},\"mean\":{:.5},\"below_0_99\":{}}}",
        v.len(),
        v[0],
        q(0.05),
        q(0.5),
        v.iter().sum::<f64>() / v.len() as f64,
        v.iter().filter(|&&x| x < 0.99).count()
    )
}

fn main() {
    let out = PathBuf::from(std::env::args().nth(1).unwrap_or("../results/native".into()));
    std::fs::create_dir_all(out.join("pdf")).unwrap();
    let pdfdir = out.join("pdf");
    let imgs: Vec<Vec<u8>> = ir::make_images().iter().map(|p| p.data_as_u8_slice().to_vec()).collect();
    let mut json = Vec::<String>::new();

    // corpus
    let (mut s_resvg, mut s_pdf, mut s_resvg_pdf) = (vec![], vec![], vec![]);
    let mut worst = vec![];
    let mut pdf_bytes = 0usize;
    for i in 0..200u32 {
        let d = ir::corpus_doc(i);
        let g = Grid::build(&d, 64.0);
        let cam = cpu::corpus_camera();
        let c = cpu::render_frame(&d, &g, &cam, &[], (0.0, 0.0), false);
        let svg = cpu::svg_frame(&d, &g, &cam);
        let r = resvg_render(&svg, 256, 256);
        let a = ir::ssim(&r, &c, 256, 256);
        s_resvg.push(a);
        let mut ids = vec![];
        g.query(&d, cam.world_rect(), &mut ids);
        let pdf = pdf::to_pdf(&d, &ids, cam.view(), 256.0, 256.0, &imgs, None);
        pdf_bytes += pdf.len();
        if let Some((p, w, h)) = pdf_raster(&pdf, &pdfdir, &format!("corpus_{i}")) {
            assert_eq!((w, h), (256, 256));
            let b = ir::ssim(&p, &c, 256, 256);
            s_pdf.push(b);
            s_resvg_pdf.push(ir::ssim(&p, &r, 256, 256));
            worst.push((b, i));
            if i % 25 != 0 {
                let _ = std::fs::remove_file(pdfdir.join(format!("corpus_{i}.png")));
                let _ = std::fs::remove_file(pdfdir.join(format!("corpus_{i}.pdf")));
            }
        }
        if i % 25 == 0 || a < 0.985 {
            std::fs::write(out.join(format!("corpus_{i}_resvg.png")), cpu::rgba_to_png(&r, 256, 256)).unwrap();
            std::fs::write(out.join(format!("corpus_{i}_cpu.png")), cpu::rgba_to_png(&c, 256, 256)).unwrap();
        }
    }
    worst.sort_by(|a, b| a.partial_cmp(b).unwrap());
    json.push(format!("\"corpus_resvg_vs_cpu_ssim\":{}", stats(&mut s_resvg)));
    json.push(format!("\"corpus_pdf_poppler_vs_cpu_ssim\":{}", stats(&mut s_pdf)));
    json.push(format!("\"corpus_pdf_poppler_vs_resvg_ssim\":{}", stats(&mut s_resvg_pdf)));
    json.push(format!("\"corpus_pdf_worst\":{:?}", &worst[..5.min(worst.len())]));
    json.push(format!("\"corpus_pdf_mean_bytes\":{}", pdf_bytes / 200));

    // big page frame A (same camera as the browser run)
    let doc = ir::big_doc(10_000);
    let grid = Grid::build(&doc, 256.0);
    for (name, cam) in [("A", cpu::big_camera(2400.0, 2600.0, 1.0, 1280, 720)), ("Z", cpu::big_camera(0.0, 0.0, 0.25, 1280, 720))] {
        let mut times = vec![];
        let mut c = vec![];
        for _ in 0..5 {
            let t = Instant::now();
            c = cpu::render_frame(&doc, &grid, &cam, &[], (0.0, 0.0), false);
            times.push(t.elapsed().as_secs_f64() * 1000.0);
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        json.push(format!("\"{name}_vello_cpu_native_ms\":{{\"median\":{:.2},\"min\":{:.2}}}", times[2], times[0]));
        let t = Instant::now();
        let svg = cpu::svg_frame(&doc, &grid, &cam);
        let svg_ms = t.elapsed().as_secs_f64() * 1000.0;
        let t = Instant::now();
        let r = resvg_render(&svg, 1280, 720);
        let resvg_ms = t.elapsed().as_secs_f64() * 1000.0;
        json.push(format!("\"{name}_svg\":{{\"bytes\":{},\"write_ms\":{svg_ms:.2},\"resvg_ms\":{resvg_ms:.1},\"resvg_vs_cpu_ssim\":{:.5}}}", svg.len(), ir::ssim(&r, &c, 1280, 720)));
        let mut ids = vec![];
        grid.query(&doc, cam.world_rect(), &mut ids);
        let t = Instant::now();
        let pdf = pdf::to_pdf(&doc, &ids, cam.view(), 1280.0, 720.0, &imgs, None);
        let pdf_ms = t.elapsed().as_secs_f64() * 1000.0;
        if let Some((p, _, _)) = pdf_raster(&pdf, &pdfdir, &format!("{name}_frame")) {
            json.push(format!("\"{name}_pdf\":{{\"bytes\":{},\"write_ms\":{pdf_ms:.1},\"poppler_vs_cpu_ssim\":{:.5},\"poppler_vs_resvg_ssim\":{:.5}}}", pdf.len(), ir::ssim(&p, &c, 1280, 720), ir::ssim(&p, &r, 1280, 720)));
        }
        std::fs::write(out.join(format!("{name}_resvg.png")), cpu::rgba_to_png(&r, 1280, 720)).unwrap();
        std::fs::write(out.join(format!("{name}_cpu_native.png")), cpu::rgba_to_png(&c, 1280, 720)).unwrap();
        std::fs::write(out.join(format!("{name}.svg")), svg).unwrap();
    }

    // real text in PDF (krilla simple-text, subset-embedded font) → pdftotext must recover it
    let font = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/opentype/inter/Inter-Regular.otf"]
        .iter()
        .find_map(|p| std::fs::read(p).ok());
    if let Some(font) = font {
        let phrase = "Instaflow export parity: real text ✓ ünïcödé";
        let cam = cpu::big_camera(2400.0, 2600.0, 1.0, 1280, 720);
        let mut ids = vec![];
        grid.query(&doc, cam.world_rect(), &mut ids);
        let font_len = font.len();
        let pdf = pdf::to_pdf(&doc, &ids, cam.view(), 1280.0, 720.0, &imgs, Some((font, phrase)));
        let f = pdfdir.join("A_frame_text.pdf");
        std::fs::write(&f, &pdf).unwrap();
        let txt = Command::new("pdftotext").arg(&f).arg("-").output().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        json.push(format!(
            "\"pdf_text\":{{\"font_file_bytes\":{font_len},\"pdf_bytes\":{},\"extracted_matches\":{},\"extracted\":{:?}}}",
            pdf.len(),
            txt.contains(phrase),
            txt.trim()
        ));
    }
    let s = format!("{{{}}}", json.join(","));
    std::fs::write(out.join("native.json"), &s).unwrap();
    println!("{s}");
}
