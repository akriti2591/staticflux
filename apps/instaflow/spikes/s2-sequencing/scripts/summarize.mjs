// One-line summaries of S2 result JSON files: node scripts/summarize.mjs results/*.json
import fs from 'fs';
for (const f of process.argv.slice(2)) {
  let r; try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.log(f, 'unreadable'); continue; }
  if (r.error) { console.log(f, 'ERROR', r.error.slice(0, 300)); continue; }
  const c = r.correctness, l = r.latency, a = l.inputToPresentEst;
  const p = (s) => s && s.n ? `${s.median}/${s.p95}` : '-';
  console.log(`${f.padEnd(40)} ${r.params.mode}/${r.params.gfx} pace=${r.params.pace} g=${r.params.gestures} rec=${r.records} | correct=${c.pass} bad=${c.framesNotEqualOracle} (snap ${c.snapBackFrames}, dbl ${c.doubleDrawFrames}) cam=${c.cameraMismatchFrames} mono=${c.generationNonMonotonic} torn=${c.render.tornAccepted} gaps=${c.render.gaps} final=${c.finalEditorEqualsOracle && c.finalRenderEqualsOracle} | frames=${c.framesDrawn} raf=${l.rafIntervalMs.median} budget=${l.budgetMs} present p50/p95 all=${p(a.all)} pan=${p(a.wheelPan)} zoom=${p(a.wheelZoom)} ptr=${p(a.pointer)} | submit=${p(l.inputToSubmit.all)} vf=${p(l.inputToViewFrameWritten)} draw=${p(l.drawCpuMs)} e4stale=${r.e4.displayedCameraStaleAtDown}/${r.e4.pointerdowns}`);
}
