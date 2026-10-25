// What `complex-scripts` buys: dictionary line breaking for Thai (no spaces between words) and CJ word segmentation.
import fs from 'node:fs';
import { createEngine } from '../web/engine.mjs';
const thai = 'ภาษาไทยเป็นภาษาที่ไม่มีการเว้นวรรคระหว่างคำในประโยคทำให้การตัดบรรทัดต้องใช้พจนานุกรม';
const thaiFont = '/usr/share/fonts/opentype/tlwg/Loma.otf'; // system font (GPL + font exception), not bundled
const out = {};
for (const v of ['base', 'complex']) {
  const e = await createEngine(fs.readFileSync(new URL(`../web/wasm/s3_text.${v}.wasm`, import.meta.url)));
  const fam = e.addFont(fs.readFileSync(thaiFont)).families[0];
  e.setFamily(`"${fam}"`);
  const L = e.layout(thai, { fontSize: 16, width: 200 });
  out[v] = { lines: L.lines.length, maxLineAdvance: Math.max(...L.lines.map((l) => +l.advance.toFixed(1))), lineTexts: L.lines.map((l) => thai.slice(l.start, l.end)) };
}
console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(new URL('../results/thai-breaks.json', import.meta.url), JSON.stringify(out, null, 2));
