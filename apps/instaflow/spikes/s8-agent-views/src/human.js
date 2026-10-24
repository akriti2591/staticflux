// Human-side edits applied straight to the Latest replica (what the person's tab does), one commit per gesture.
// Records every write so the scorer can check that nothing the human did was clobbered.
import { Stage } from './stage.js';
import { TREE } from './store.js';
import { secToTicks } from './units.js';

export function humanEdit(human, fn) {
  const st = new Stage(human);
  const log = { fields: new Map(), inserts: [], deletes: [] };
  const node = (nid) => { const pid = st.partOf(nid); return { pid, rec: st.part(pid).get(nid), tree: human.part(pid).getTree(TREE) }; };
  const pids = new Set();
  const ctx = {
    set(nid, path, v) { const { pid, rec, tree } = node(nid); const n = tree.getNodeByID(rec.tid); const d = n.data; d.set(path, v); d.free?.(); n.free?.(); pids.add(pid); log.fields.set(nid + '|' + path, v); },
    setSec(nid, path, s) { ctx.set(nid, path, secToTicks(s)); },
    insertText(nid, at, s) { const { pid, rec, tree } = node(nid); const n = tree.getNodeByID(rec.tid); const d = n.data; const t = d.get('text.content'); t.insert(at < 0 ? t.length : at, s); t.free?.(); d.free?.(); n.free?.(); pids.add(pid); log.inserts.push({ nid, s }); },
    del(nid) { const { pid, rec, tree } = node(nid); tree.delete(rec.tid); pids.add(pid); log.deletes.push(nid); },
  };
  fn(ctx);
  for (const pid of pids) human.part(pid).commit({ message: '{"actor":"human:guest"}' });
  return log;
}

/** Count human writes that did not survive (the clobber metric). */
export function clobbers(human, log) {
  const st = new Stage(human); let n = 0; const detail = [];
  for (const [key, v] of log.fields) {
    const [nid, path] = key.split('|'); const rec = st.node(nid);
    if (rec && JSON.stringify(rec.props[path]) !== JSON.stringify(v)) { n++; detail.push({ nid, path, want: v, got: rec.props[path] }); }
  }
  for (const { nid, s } of log.inserts) { const rec = st.node(nid); if (rec && !String(rec.text).includes(s)) { n++; detail.push({ nid, text: s }); } }
  return { n, detail };
}
