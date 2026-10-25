// Reads the harness JSON (stdin or file), writes results/<name>/result.json (without images)
// and results/<name>/img/* (PNG/SVG decoded from base64).
import fs from 'node:fs';
import path from 'node:path';
const [file, outDir] = process.argv.slice(2);
const text = fs.readFileSync(file, 'utf8');
const json = JSON.parse(text.slice(text.indexOf('{')));
fs.mkdirSync(path.join(outDir, 'img'), { recursive: true });
for (const [k, v] of Object.entries(json.images ?? {})) fs.writeFileSync(path.join(outDir, 'img', k), Buffer.from(v, 'base64'));
delete json.images;
fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(json, null, 2));
console.log(`wrote ${outDir}/result.json and ${Object.keys(JSON.parse(text.slice(text.indexOf('{'))).images ?? {}).length} images`);
