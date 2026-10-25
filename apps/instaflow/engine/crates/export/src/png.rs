//! A small PNG encoder for the SVG writer's embedded images (8-bit straight RGBA, filter 0, zlib through flate2:
//! the deflate the PDF writer uses too, so the export Wasm carries one compressor).

use flate2::Compression;
use flate2::write::ZlibEncoder;
use std::io::Write;

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut crc = flate2::Crc::new();
    crc.update(kind);
    crc.update(data);
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc.sum().to_be_bytes());
}

/// PNG bytes of a `width × height` straight-alpha RGBA8 image.
pub fn encode(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(rgba.len() / 2 + 64);
    out.extend_from_slice(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &ihdr);
    let row = width as usize * 4;
    let mut z = ZlibEncoder::new(Vec::with_capacity(rgba.len() / 2), Compression::new(6));
    for y in 0..height as usize {
        // Writing into a Vec cannot fail.
        let _ = z.write_all(&[0]);
        let _ = z.write_all(&rgba[y * row..(y + 1) * row]);
    }
    let data = z.finish().unwrap_or_default();
    chunk(&mut out, b"IDAT", &data);
    chunk(&mut out, b"IEND", &[]);
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn round_trips_through_a_png_decoder() {
        let rgba: Vec<u8> = (0..3 * 2 * 4).map(|i| (i * 11) as u8).collect();
        let bytes = super::encode(&rgba, 3, 2);
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (3, 2));
        assert_eq!(&buf[..info.buffer_size()], &rgba[..]);
    }
}
