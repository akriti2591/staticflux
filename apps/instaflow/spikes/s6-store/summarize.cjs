// Pools results/bench-run*.json into one summary (medians/p95 over all samples of all runs).
const fs = require('fs'); const path = require('path');
const dir = path.join(__dirname, 'results');
const runs = fs.readdirSync(dir).filter((f) => /^bench-run\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f))));
const q = (xs, p) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] * 10) / 10 : null; };
const mp = (xs) => ({ medianOfMedians: q(xs.map((x) => x?.median), 0.5), worstP95: q(xs.map((x) => x?.p95), 1) });
const out = { runs: runs.length, errors: runs.filter((r) => r.error).map((r) => r.error) };
for (const kind of ['sync', 'async']) {
  const R = runs.map((r) => r[kind]).filter(Boolean); if (!R.length) continue;
  const o = (out[kind] = {});
  o.casPass = R.every((r) => r.cas?.pass); o.faultPass = R.every((r) => r.fault?.pass);
  o.casWithoutLockWinners = R.map((r) => r.cas?.race16_withoutLock);
  o.milestoneFirstMs = R.map((r) => Math.round(r.milestone.first.ms.total));
  o.milestone = {};
  for (const k of ['k0', 'k1', 'k5', 'k20', 'k200']) {
    const c = R.map((r) => r.milestone.changed[k]);
    o.milestone[k] = { totalMs: mp(c.map((x) => x.totalMs)), canonicalizeMs: mp(c.map((x) => x.canonicalizeMs)), hashMs: mp(c.map((x) => x.hashMs)), blobsMs: mp(c.map((x) => x.blobsMs)), recordHeadMs: mp(c.map((x) => x.recordHeadMs)), newBlobs: mp(c.map((x) => x.newBlobs)), bytesWritten: mp(c.map((x) => x.bytesWritten)) };
  }
  o.writesOnlyChangedParts = R.every((r) => r.milestone.writesOnlyChangedParts);
  o.docCanonicalBytes = R[0].milestone.doc.canonicalBytes;
  if (R[0].zip) o.zip = { bundleBytes: R[0].zip.bundleBytes, exportMs: mp(R.map((r) => r.zip.exportMs)), importMs: mp(R.map((r) => r.zip.importMs)), pass: R.every((r) => r.zip.pass), reimportWritten: R.map((r) => r.zip.reimportSameTarget.blobsWritten) };
  o.gc = { pass: R.every((r) => r.gc.pass), setupMs: R.map((r) => Math.round(r.gc.setupMs)), sequentialTotalMs: R.map((r) => Math.round(r.gc.sequentialRun.total)),
    parallelTotalMs: mp(R.map((r) => r.gc.parallel16.totalMs)), parallelListMs: mp(R.map((r) => r.gc.parallel16.listMs)), parallelDeleteMs: mp(R.map((r) => r.gc.parallel16.deleteMs)), markMs: mp(R.map((r) => r.gc.parallel16.markMs)),
    inventoryTotalMs: mp(R.map((r) => r.gc.inventoryVariant.totalMs)), graceRunMs: R.map((r) => Math.round(r.gc.graceRun.ms.total)) };
}
out.probe = runs[0]?.probe; out.externalZipCheck = runs.map((r) => r.externalZipCheck);
const s = JSON.stringify(out, null, 2); fs.writeFileSync(path.join(dir, 'summary.json'), s); console.log(s);
