// Print a compact markdown table from results/<name>.json files.  node scripts/summarize.cjs results/cloud.json ...
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const r = JSON.parse(fs.readFileSync(f, 'utf8'));
  console.log(`\n### ${f} — ${r.env.ua.match(/Chrome\/[\d.]+/)?.[0]} adapter=${r.env.adapter?.architecture ?? r.env.adapter?.vendor} f16=${r.env.adapter?.f16} maxStorageBufferMB=${r.env.adapter?.maxStorageBufferMB}`);
  if (r.processMemory?.peakTotalMB) console.log(`process peak RSS ${r.processMemory.peakTotalMB} MB ${JSON.stringify(r.processMemory.peakByProcessTypeMB)}`);
  console.log('| model | EP | in | MB | create ms | 1st run ms | fps e2e (static) | infer ms med/p95 | smooth ms | flicker edge raw→GF+EMA / EMA (static) | flicker edge raw→sm (bg-motion) | IoU static | IoU moving raw→sm | edge MAE moving raw→GF+EMA / EMA | ghost moving GF+EMA / EMA | error |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const x of r.results) {
    const s = x.seqs?.static ?? {}, b = x.seqs?.bgmotion ?? {}, m = x.seqs?.moving ?? {};
    console.log(`| ${x.model} | ${x.ep} | ${x.input} | ${x.sizeMB ?? ''} | ${x.sessionCreateMs ?? ''} | ${x.firstRunMs ?? ''} | ${s.fpsEndToEndMedian ?? ''} | ${s.inferMsMedian ?? ''}/${s.inferMsP95 ?? ''} | ${s.smoothMsMedian ?? ''} | ${s.flickerRawEdge ?? ''}→${s.flickerSmoothedEdge ?? ''} / ${s.flickerEmaOnlyEdge ?? ''} | ${b.flickerRawEdge ?? ''}→${b.flickerSmoothedEdge ?? ''} | ${s.iouRaw ?? ''} | ${m.iouRaw ?? ''}→${m.iouSmoothed ?? ''} | ${m.maeRawEdge ?? ''}→${m.maeSmoothedEdge ?? ''} / ${m.maeEmaOnlyEdge ?? ''} | ${m.ghostSmoothed ?? ''} / ${m.ghostEmaOnly ?? ''} | ${x.error ? x.error.slice(0, 60) : ''} |`);
  }
}
