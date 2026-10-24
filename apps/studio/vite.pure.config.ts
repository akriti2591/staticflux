import { defineConfig, mergeConfig } from 'vite';
import an from './vite.analyze.config.js';
const RE = /(^|[=(,\[]\s*|\bexport default\s+)(defineError|token|unit|contribution|defineMachine|metric\.\w+|defineSubsystem|defineFlag|defineFeature|defineRoute|defineDialog|chunk|defineMeter|definePolicy|defineCapability)\s*(<[^>()]*>)?\(/gm;
export default mergeConfig(an, defineConfig({
  plugins: [{ name: 'pure', enforce: 'pre', transform(code, id) {
    if (!/packages\/[^/]+\/src\/|apps\/studio\/src\//.test(id) || id.includes('node_modules')) return null;
    if (process.env.PURE_SCOPE === 'pkgs' && !id.includes('/packages/')) return null;
    return { code: code.split('\n').map((l) => /^\s*(\*|\/\*|\/\/)/.test(l) ? l : l.replace(RE, (m, pre, fn, ta) => `${pre}/* @__PURE__ */ ${fn}${ta ?? ''}(`)).join('\n'), map: null };
  } }],
}));
