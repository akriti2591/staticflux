/**
 * Build helper (Vite 8 / Rolldown): merge the boot closure into ONE chunk.
 *
 * `main.ts` runs the inline mode detector, then `import()`s `boot-browser.ts`. Rolldown sees
 * the feature / deferred chunks (emitted as entries by `@staticflux/vite-plugin`) as
 * independently loadable, so every module they share with boot becomes its own small common
 * chunk — ~18 files at boot, each gzipped on its own. Everything the boot module statically
 * uses is fetched at boot anyway, so this helper computes that set and puts it into a single
 * `codeSplitting` group: fewer requests, better compression, same code.
 *
 * The set is computed per *binding*, not per module (`importedIds` would follow package
 * barrels and aggregate arrays such as `runtimeUnits` into code only lazy chunks use): from the
 * boot entry's exports, follow each used top-level declaration's identifiers to the imports and
 * declarations they reference (re-exports and `export *` resolved through the barrel).
 * Under-approximation is safe (a module left out keeps Rolldown's default placement);
 * modules of the initial entry (`main.ts` closure) are never captured, so the detector chunk
 * keeps no static dependency on the boot chunk.
 */
import type { Plugin } from 'vite';

interface Ref {
  readonly target: string;
  readonly imported: string; // export name, 'default', or '*' (namespace)
}
interface ModuleFacts {
  readonly imports: Map<string, Ref>; // local binding → import
  readonly decls: Map<string, unknown[]>; // local binding → declaration node(s)
  readonly exports: Map<string, string>; // exported name → local binding
  readonly reexports: Map<string, Ref>; // exported name → re-export
  readonly stars: string[]; // `export * from` targets
  readonly effects: unknown[]; // top-level statements that always run
}

type Node = { readonly type: string; readonly [key: string]: unknown };

function identifiers(node: unknown, out: Set<string>): Set<string> {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) identifiers(child, out);
    return out;
  }
  const n = node as Node;
  if (n.type === 'Identifier' && typeof n['name'] === 'string') out.add(n['name']);
  for (const [key, value] of Object.entries(n)) if (key !== 'type' && typeof value === 'object') identifiers(value, out);
  return out;
}

function nameOf(node: unknown): string {
  const n = node as Node;
  return n.type === 'Literal' ? String(n['value']) : String(n['name']);
}

export interface BootChunkOptions {
  /** The module `import()`ed at boot (its static closure is boot code). */
  readonly bootEntry: (id: string) => boolean;
  /** Initial entry modules (inline detector) — never captured. */
  readonly initialEntry: (id: string) => boolean;
  /** Chunk name (default `boot`). */
  readonly name?: string;
}

export function bootChunk(options: BootChunkOptions): { readonly plugin: Plugin; readonly group: { readonly name: (id: string) => string | null } } {
  const name = options.name ?? 'boot';
  let captured = new Set<string>();

  const plugin: Plugin = {
    name: 'studio:boot-chunk',
    apply: 'build',
    async buildEnd() {
      const facts = new Map<string, ModuleFacts>();
      const ids = [...this.getModuleIds()];
      for (const id of ids) {
        const info = this.getModuleInfo(id);
        if (info?.code == null || !/\.[cm]?[jt]sx?$/.test(id.split('?')[0] ?? '')) continue;
        let program: { body: Node[] };
        try {
          program = this.parse(info.code) as unknown as { body: Node[] };
        } catch {
          continue;
        }
        const f: ModuleFacts = { imports: new Map(), decls: new Map(), exports: new Map(), reexports: new Map(), stars: [], effects: [] };
        const resolve = async (source: unknown): Promise<string | undefined> => {
          const resolved = await this.resolve(String((source as Node)['value']), id);
          return resolved === null || resolved.external === true ? undefined : resolved.id;
        };
        const declare = (decl: Node, exported: boolean): void => {
          const add = (local: string, node: unknown): void => {
            f.decls.set(local, [...(f.decls.get(local) ?? []), node]);
            if (exported) f.exports.set(local, local);
          };
          if (decl.type === 'VariableDeclaration') {
            for (const d of decl['declarations'] as Node[]) for (const local of identifiers(d['id'], new Set())) add(local, d);
          } else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl['id'] != null) {
            add(nameOf(decl['id']), decl);
          } else if (decl.type !== 'TSTypeAliasDeclaration' && decl.type !== 'TSInterfaceDeclaration') {
            f.effects.push(decl);
          }
        };
        for (const statement of program.body) {
          switch (statement.type) {
            case 'ImportDeclaration': {
              const target = await resolve(statement['source']);
              if (target === undefined) break;
              const specifiers = statement['specifiers'] as Node[];
              if (specifiers.length === 0) f.effects.push({ type: 'SideEffectImport', target });
              for (const s of specifiers) {
                const local = nameOf(s['local']);
                const imported = s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : nameOf(s['imported']);
                f.imports.set(local, { target, imported });
              }
              break;
            }
            case 'ExportAllDeclaration': {
              const target = await resolve(statement['source']);
              if (target === undefined) break;
              if (statement['exported'] == null) f.stars.push(target);
              else f.reexports.set(nameOf(statement['exported']), { target, imported: '*' });
              break;
            }
            case 'ExportNamedDeclaration': {
              if (statement['declaration'] != null) {
                declare(statement['declaration'] as Node, true);
                break;
              }
              const target = statement['source'] == null ? undefined : await resolve(statement['source']);
              for (const s of statement['specifiers'] as Node[]) {
                const exported = nameOf(s['exported']);
                const local = nameOf(s['local']);
                if (statement['source'] != null) {
                  if (target !== undefined) f.reexports.set(exported, { target, imported: local });
                } else f.exports.set(exported, local);
              }
              break;
            }
            case 'ExportDefaultDeclaration': {
              const declaration = statement['declaration'] as Node;
              const local = declaration['id'] != null ? nameOf(declaration['id']) : '\0default';
              f.decls.set(local, [declaration]);
              f.exports.set('default', local);
              break;
            }
            case 'VariableDeclaration':
            case 'FunctionDeclaration':
            case 'ClassDeclaration':
              declare(statement, false);
              break;
            default:
              if (!statement.type.startsWith('TS')) f.effects.push(statement);
          }
        }
        facts.set(id, f);
      }

      /**
       * Modules (and their local bindings) used from `roots`. With `expand`, a module that is
       * included brings every binding used by anyone (`expand`): a chunk holds whole modules,
       * so the boot chunk statically imports whatever those bindings need.
       */
      const walk = (roots: readonly string[], expand?: ReadonlyMap<string, ReadonlySet<string>>): { used: Set<string>; locals: Map<string, Set<string>> } => {
        const used = new Set<string>();
        const locals = new Map<string, Set<string>>();
        const seen = new Set<string>();
        const queue: [string, string][] = roots.map((id) => [id, '\0all']);
        const include = (id: string, f: ModuleFacts, why: string): void => {
          if (used.has(id)) return;
          used.add(id);
          if (process.env['BOOT_CHUNK_DEBUG'] !== undefined) console.log('[boot-chunk]', id.replace(/.*staticflux\//, ''), '<=', why);
          for (const effect of f.effects) {
            const target = (effect as { target?: string }).target;
            if (target !== undefined) queue.push([target, '\0none']);
            else for (const n of identifiers(effect, new Set())) queue.push([id, `\0local:${n}`]);
          }
          for (const local of expand?.get(id) ?? []) queue.push([id, `\0local:${local}`]);
        };
        const useLocal = (id: string, f: ModuleFacts, local: string): void => {
          const ref = f.imports.get(local);
          if (ref !== undefined) {
            queue.push([ref.target, ref.imported === '*' ? '\0all' : ref.imported]);
            return;
          }
          const decls = f.decls.get(local);
          if (decls === undefined) return;
          include(id, f, local);
          let set = locals.get(id);
          if (set === undefined) locals.set(id, (set = new Set()));
          set.add(local);
          for (const decl of decls) for (const name of identifiers(decl, new Set())) if (name !== local) queue.push([id, `\0local:${name}`]);
        };
        while (queue.length > 0) {
          const [id, want] = queue.pop() as [string, string];
          const key = `${id}\0${want}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const f = facts.get(id);
          if (f === undefined) continue;
          // Whole-module uses, and pure barrels (no code of their own) on the way.
          if (want === '\0none' || want === '\0all' || f.decls.size === 0) include(id, f, want);
          if (want === '\0none') continue;
          if (want.startsWith('\0local:')) {
            useLocal(id, f, want.slice(7));
            continue;
          }
          const names = want === '\0all' ? [...f.exports.keys(), ...f.reexports.keys()] : [want];
          for (const exported of names) {
            const local = f.exports.get(exported);
            if (local !== undefined) {
              useLocal(id, f, local);
              continue;
            }
            const re = f.reexports.get(exported);
            if (re !== undefined) {
              queue.push([re.target, re.imported === '*' ? '\0all' : re.imported]);
              continue;
            }
            for (const star of f.stars) if (this.getModuleInfo(star)?.exports.includes(exported) === true) queue.push([star, exported]);
          }
          if (want === '\0all') for (const star of f.stars) queue.push([star, '\0all']);
        }
        return { used, locals };
      };

      // Every binding any chunk uses (entries, emitted chunks, dynamic-import targets).
      const roots = ids.filter((id) => {
        const info = this.getModuleInfo(id);
        return info !== null && (info.isEntry || info.dynamicImporters.length > 0);
      });
      const global = walk(roots).locals;
      const initial = walk(ids.filter(options.initialEntry), global).used;
      const bootEntries = ids.filter(options.bootEntry);
      const boot = walk(bootEntries, global).used;
      for (const id of initial) boot.delete(id);
      // The boot entry keeps its own (tiny) chunk, so its facade — what build reports and
      // boot plans key on (`bootEntries`) — stays stable; it statically imports the group.
      for (const id of bootEntries) boot.delete(id);
      captured = boot;
    },
  };

  return { plugin, group: { name: (id: string) => (captured.has(id) ? name : null) } };
}
