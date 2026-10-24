// Sends every evals/prompts/*.md to a local OpenAI-compatible server (omlx, LM Studio, Ollama, llama.cpp…)
// and writes the raw replies to evals/responses-<label>/<same name>.txt for `harness.mjs score`.
//   node evals/run-local.mjs --url=http://localhost:8000/v1 [--model=<id>] [--label=local] [--only=markup.rel,json.ops] [--think]
// Set OPENAI_API_KEY if the server needs a bearer token (it is sent as Authorization, never written to disk).
// Each prompt is sent as-is as one user message (same as the Sonnet run), temperature 0.
// Thinking is switched off by default (chat_template_kwargs.enable_thinking=false, honoured by Qwen3-style
// templates); --think turns it on. Reasoning blocks (<think>…</think>) are stripped before saving. Existing replies are skipped, so it resumes.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const url = arg('url', 'http://localhost:8000/v1').replace(/\/$/, '');
const label = arg('label', 'local');
const only = arg('only', '').split(',').filter(Boolean);
const think = process.argv.includes('--think');
const maxTokens = Number(arg('max-tokens', 8192));
const headers = { 'content-type': 'application/json', ...(process.env.OPENAI_API_KEY ? { authorization: `Bearer ${process.env.OPENAI_API_KEY}` } : {}) };

async function pickModel() {
  const given = arg('model', '');
  if (given) return given;
  const res = await fetch(`${url}/models`, { headers });
  if (!res.ok) throw new Error(`GET ${url}/models → ${res.status}. Pass --model=<id>.`);
  const ids = (await res.json()).data?.map((m) => m.id) ?? [];
  if (ids.length === 0) throw new Error('server lists no models; pass --model=<id>');
  console.log(`models on server: ${ids.join(', ')} → using ${ids[0]}`);
  return ids[0];
}

const model = await pickModel();
const outDir = join(HERE, `responses-${label}`);
mkdirSync(outDir, { recursive: true });
const prompts = readdirSync(join(HERE, 'prompts')).filter((f) => f.endsWith('.md') && f !== 'index.md' && (only.length === 0 || only.some((o) => f.startsWith(o)))).sort();
console.log(`${prompts.length} prompts → ${outDir}`);

let done = 0;
for (const file of prompts) {
  const out = join(outDir, file.replace(/\.md$/, '.txt'));
  done += 1;
  if (existsSync(out)) continue;
  const t0 = Date.now();
  const res = await fetch(`${url}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'user', content: readFileSync(join(HERE, 'prompts', file), 'utf8') }],
      ...(think ? {} : { chat_template_kwargs: { enable_thinking: false } }) }),
  });
  if (!res.ok) { console.error(`${file}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); continue; }
  const text = (await res.json()).choices?.[0]?.message?.content ?? '';
  writeFileSync(out, text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() + '\n');
  console.log(`[${done}/${prompts.length}] ${file} ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
console.log(`done. Score with: node evals/harness.mjs score --dir=evals/responses-${label}`);
