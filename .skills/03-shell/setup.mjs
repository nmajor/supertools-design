#!/usr/bin/env node
// 03-shell setup.
// Apply the application shell from design/product-plan/shell/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { requireExport, EXPORT_DIR, SHELL_DIR, shellComponentFiles } from '../_shared/design-os.mjs';

const STATE_SUB    = path.join(PROJECT_ROOT, '.supertools-state', '03-shell');
const SHELL_SRC    = SHELL_DIR;
const SHELL_DEST   = path.join(PROJECT_ROOT, 'src', 'components', 'shell');
const ROOT_TSX     = path.join(PROJECT_ROOT, 'src', 'routes', '__root.tsx');
const STYLES_PATH  = path.join(PROJECT_ROOT, 'src', 'styles.css');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');

// Demo chrome the scaffold ships that the export's shell replaces. Header.tsx
// and ThemeToggle.tsx were in this list historically and no longer exist in
// supertools-stack@80dd8792 — deletion tolerates ENOENT, so stale names are
// harmless, but do not treat this list as a description of the current
// scaffold. MarketingNav is deliberately NOT deleted: it is the marketing-page
// nav, not app chrome, and 11-legal-pages still renders it.
const SCAFFOLD_DEMOS = ['Header.tsx', 'Footer.tsx', 'ThemeToggle.tsx'];

const BEGIN_MARKER = '/* === supertools 02-design-tokens BEGIN === */';
const END_MARKER   = '/* === supertools 02-design-tokens END === */';

// Which props AppShell takes is the EXPORT's call, not this skill's. An
// earlier version hardcoded `user={null} navigationItems={[]} onNavigate={...}`,
// which are the props of the shell the skill was written against — against any
// other export that is a type error, and it produced a project that would not
// typecheck or build. Read the interface and pass only what it declares.
function shellWrapperFor(appShellSource) {
  const m = appShellSource.match(/export interface AppShellProps\s*\{([\s\S]*?)\n\}/);
  if (!m) {
    // No parseable interface — pass children only. Always valid.
    return {
      body: '  return <AppShell>{children}</AppShell>',
      passed: [],
      needsNavigate: false,
    };
  }
  const declared = new Set(
    [...m[1].matchAll(/^\s*(\w+)\??\s*:/gm)].map((x) => x[1]),
  );

  // Only wire callbacks whose meaning is unambiguous at this stage. Data props
  // (the selected item, its status, the user) are deliberately left unset:
  // there is no app yet, and inventing values here would be this skill holding
  // a design opinion. Auth and real navigation land in the ralph-build skill.
  const lines = [];
  let needsNavigate = false;
  if (declared.has('onNavigate')) {
    lines.push('      onNavigate={(href: string) => navigate({ to: href as never })}');
    needsNavigate = true;
  }
  if (declared.has('onSignIn')) {
    lines.push("      onSignIn={() => navigate({ to: '/login' as never })}");
    needsNavigate = true;
  }
  // A stage-based shell navigates by stage id rather than by href. The route
  // for each stage may not exist until the app is built; wiring it now is
  // still correct, because the shell's job is to say WHERE it wants to go.
  if (declared.has('onNavigateStage')) {
    lines.push('      onNavigateStage={(stage: string) => navigate({ to: `/${stage}` as never })}');
    needsNavigate = true;
  }
  if (declared.has('onSelectShort')) {
    lines.push('      onSelectShort={(id: string) => navigate({ to: `/shorts/${id}` as never })}');
    needsNavigate = true;
  }
  const stubs = ['onLogout', 'onOpenSettings', 'onOpenShortcuts', 'onOpenShorts'];
  for (const s of stubs) {
    if (declared.has(s)) lines.push(`      ${s}={() => { /* wired when the app lands */ }}`);
  }

  const body = lines.length
    ? `${needsNavigate ? '  const navigate = useNavigate()\n' : ''}  return (\n    <AppShell\n${lines.join('\n')}\n    >\n      {children}\n    </AppShell>\n  )`
    : '  return <AppShell>{children}</AppShell>';

  return { body, passed: lines.length, needsNavigate };
}

const NEW_ROOT_TSX = (brandName, shellWrapperBody, needsNavigate) => `import { HeadContent, Scripts, createRootRoute${needsNavigate ? ', useNavigate' : ''} } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { AppShell } from '../components/shell'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: ${JSON.stringify(brandName)} },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <AppShellWrapper>{children}</AppShellWrapper>
        <TanStackDevtools
          config={{ position: 'bottom-right' }}
          plugins={[
            { name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}

function AppShellWrapper({ children }: { children: React.ReactNode }) {
${shellWrapperBody}
}
`;

// This skill holds NO design opinions. It rewrites styles.css only to drop the
// scaffold's demo CSS, and everything it keeps is transcribed from what is
// already in the file — the @import/@plugin directives 01 and 02 established,
// and skill 02's @theme block. It declares nothing of its own.
//
// There used to be a "minimal reset" here (box-sizing, body margin,
// -webkit-font-smoothing: antialiased). That was a design opinion: font
// smoothing changes how text looks, and the rest was already handled twice
// over — Tailwind 4's preflight does box-sizing and body margin, and the
// exported AppShell manages its own viewport height. Deleted rather than
// made configurable.
function stylesPrefix({ directives, theme }) {
  return `${directives.join('\n')}\n\n${theme}\n`;
}

const log = (...a) => console.log(...a);
const die = (m) => { console.error(m); process.exit(1); };

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || PROJECT_ROOT,
    stdio: opts.stdio || ['ignore', 'inherit', 'inherit'],
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
  return r;
}

// Which third-party packages the shell needs is the EXPORT's call, not this
// skill's. An earlier version installed one hardcoded package; a later one
// scanned with a regex that missed dynamic import(), require() and TypeScript
// import-equals. Both shipped projects that could not build.
//
// Module specifiers are extracted with TypeScript's own preProcessFile, which
// is the API designed for exactly this and understands every import form the
// language has. TypeScript is a scaffold devDependency, so it resolves from
// PROJECT_ROOT. If it cannot be loaded we HALT rather than fall back to a
// regex — a silent under-detection here is what breaks the build.
let _ts = null;
async function typescriptModule() {
  if (_ts) return _ts;
  const req = createRequire(path.join(PROJECT_ROOT, 'noop.js'));
  try { _ts = req('typescript'); }
  catch (e) {
    die('Could not load "typescript" from the project — it is required to detect the export imports safely. ' +
        'Install it (the scaffold normally has it as a devDependency) and re-run. Original error: ' + e.message);
  }
  return _ts;
}

async function moduleSpecifiersOf(source, fileName) {
  const ts = await typescriptModule();
  // detectJavaScriptImports=true so require() and dynamic import() are included.
  const pre = ts.preProcessFile(source, /*readImportFiles*/ true, /*detectJavaScriptImports*/ true);
  const specs = new Set((pre.importedFiles || []).map((f) => f.fileName));

  // preProcessFile does not report `require.resolve('x')` — it is a path lookup
  // rather than an import, but it is still a real reference, and deleting the
  // file it names breaks the caller. A regex supplement was wrong too: it
  // required the string literal immediately after "(", so
  // `require.resolve(/* keep */ './x')` slipped through. Walk the AST instead.
  const sf = ts.createSourceFile(fileName || 'f.tsx', source, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (ts.isCallExpression(node) &&
        // Both `require.resolve(x)` and `require["resolve"](x)` are valid.
        (ts.isPropertyAccessExpression(node.expression) ||
         ts.isElementAccessExpression(node.expression)) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'require' &&
        (ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text === 'resolve'
          : ts.isStringLiteralLike(node.expression.argumentExpression) &&
            node.expression.argumentExpression.text === 'resolve') &&
        node.arguments.length &&
        ts.isStringLiteralLike(node.arguments[0])) {
      specs.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...specs];
}

async function externalImportsOf(source, fileName) {
  const found = new Set();
  for (const spec of await moduleSpecifiersOf(source, fileName)) {
    // Skip relative paths, the project's own aliases, and protocol specifiers.
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') ||
        spec.startsWith('#/') || spec.includes(':')) continue;
    const parts = spec.split('/');
    found.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
  return found;
}

async function ensureExportDeps(files) {
  const pkg = JSON.parse(await fs.readFile(PACKAGE_JSON, 'utf-8'));
  const have = new Set([
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ]);

  const needed = new Set();
  for (const abs of files) {
    for (const spec of await externalImportsOf(await fs.readFile(abs, 'utf-8'), abs)) needed.add(spec);
  }

  const missing = [...needed].filter((p) => !have.has(p)).sort();
  if (!missing.length) {
    log(`  all ${needed.size} external import(s) already satisfied: ${[...needed].sort().join(', ')}`);
    return [];
  }
  log(`  export needs ${missing.length} package(s) not in package.json: ${missing.join(', ')}`);
  run('npm', ['install', '--no-fund', '--no-audit', ...missing]);
  return missing;
}

// The export's shell components import a shared design kit that lives OUTSIDE
// shell/components/ — `../../design-system/kit/tokens` and `.../primitives`.
// Copying only shell/components/ leaves those imports dangling, so the kit is
// copied too and the imports are rewritten to the `@/` alias the scaffold's
// tsconfig already maps to ./src/*. Without this, 03 produces a project that
// does not typecheck.
const KIT_SRC = path.join(EXPORT_DIR, 'design-system', 'kit');
const KIT_DEST = path.join(PROJECT_ROOT, 'src', 'kit');
const KIT_IMPORT_RE = /(['"])(?:\.\.\/)+design-system\/kit\/([A-Za-z0-9_-]+)\1/g;

async function copyDesignKit() {
  let entries;
  try { entries = await fs.readdir(KIT_SRC); }
  catch { log('  (export ships no design-system/kit; nothing to copy)'); return []; }

  const files = entries.filter((f) => /\.(ts|tsx)$/.test(f));
  if (!files.length) { log('  (design-system/kit has no .ts/.tsx files)'); return []; }

  await fs.mkdir(KIT_DEST, { recursive: true });
  for (const f of files) {
    // Kit files may reference each other by relative path; those stay valid
    // because the whole directory moves together.
    await fs.copyFile(path.join(KIT_SRC, f), path.join(KIT_DEST, f));
    log(`  copied src/kit/${f}`);
  }
  return files;
}

async function copyShellComponents(shellFiles) {
  await fs.mkdir(SHELL_DEST, { recursive: true });
  let rewritten = 0;
  for (const f of shellFiles) {
    const content = await fs.readFile(path.join(SHELL_SRC, f), 'utf-8');
    const next = content.replace(KIT_IMPORT_RE, (_m, q, mod) => `${q}@/kit/${mod}${q}`);
    if (next !== content) rewritten++;
    await fs.writeFile(path.join(SHELL_DEST, f), next);
    log(`  copied src/components/shell/${f}${next !== content ? ' (kit imports -> @/kit/*)' : ''}`);
  }
  // Fail loudly rather than shipping a component with an unresolvable import.
  for (const f of shellFiles) {
    const written = await fs.readFile(path.join(SHELL_DEST, f), 'utf-8');
    if (/design-system\/kit/.test(written)) {
      throw new Error(`${f} still imports design-system/kit after rewrite — refusing to continue.`);
    }
  }
  return rewritten;
}

// Walk src/ collecting every file that could import a component.
// Scan the whole project, not just src/ — a route, a script or a config file
// outside src/ can import a component just as well, and deleting something
// they use breaks the build all the same.
const SCAN_SKIP = new Set(['node_modules', '.git', '.wrangler', '.output', '.tanstack', 'dist', 'design', '.skills', '.supertools-state']);
async function sourceFilesUnder(dir, acc = []) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SCAN_SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await sourceFilesUnder(p, acc);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

// Does anything still reference this component?
//
// Deletion is irreversible within a run, so this must not miss a reference.
// Two regex generations already did: the first matched only `from ".../Name"`,
// the second still missed `import(/* @vite-ignore */ './x')` and
// require.resolve(). Specifiers now come from TypeScript's preProcessFile, so
// every import form the language supports is covered, and each one is resolved
// against the real path on disk rather than string-matched.
// Resolve a non-relative specifier through tsconfig `compilerOptions.paths`.
// Parsed with TypeScript's own config reader so JSONC comments are handled by
// the same tool that will interpret them at build time.
let _aliasMap = null;
async function aliasMap() {
  if (_aliasMap) return _aliasMap;
  const ts = await typescriptModule();
  const cfgPath = path.join(PROJECT_ROOT, 'tsconfig.json');
  // parseJsonConfigFileContent follows `extends`, so aliases declared in a base
  // tsconfig are visible. readConfigFile alone does not, and a base-config alias
  // being invisible means a referenced file can be deleted.
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    read.config || {}, ts.sys, PROJECT_ROOT, undefined, cfgPath);
  const opts = parsed.options || {};
  const baseUrl = opts.baseUrl ? path.resolve(opts.baseUrl) : PROJECT_ROOT;
  _aliasMap = { baseUrl, paths: opts.paths || {} };
  return _aliasMap;
}

async function aliasTargets(spec) {
  const { baseUrl, paths } = await aliasMap();
  const out = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    if (star < 0) {
      if (pattern === spec) for (const t of targets) out.push(path.resolve(baseUrl, t));
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
    const middle = spec.slice(prefix.length, spec.length - suffix.length);
    for (const t of targets) out.push(path.resolve(baseUrl, t.replace('*', middle)));
  }
  return out;
}

async function referrersOf(fileName, ownPath, files) {
  const ownResolved = path.resolve(ownPath);
  const ownNoExt = ownResolved.replace(/\.(tsx?|jsx?)$/, '');
  const hits = [];
  for (const sf of files) {
    if (path.resolve(sf) === ownResolved) continue;
    const text = await fs.readFile(sf, 'utf-8');
    let specs;
    try { specs = await moduleSpecifiersOf(text, sf); }
    catch { specs = []; }
    for (const spec of specs) {
      // Relative specifiers resolve against the importing file; ALIASED ones
      // (`@/components/Footer`) resolve through tsconfig paths. Discarding
      // non-relative specifiers meant a valid alias import was invisible and
      // the file it referenced could be unlinked underneath it.
      const bare = spec.replace(/\?.*$/, '');            // drop ?query
      const candidates = bare.startsWith('.')
        ? [path.resolve(path.dirname(sf), bare)]
        : await aliasTargets(bare);
      if (!candidates.length) continue;
      const abs = candidates[0];
      const matched = candidates.some((c) => {
        const cNoExt = c.replace(/\.(tsx?|jsx?)$/, '');
        return cNoExt === ownNoExt || c === ownResolved;
      });
      if (matched) {
        hits.push(path.relative(PROJECT_ROOT, sf));
        break;
      }
    }
  }
  return hits;
}

async function deleteScaffoldDemos() {
  const deleted = [];
  const kept = [];
  const removedBackups = new Map();
  const srcFiles = await sourceFilesUnder(PROJECT_ROOT);

  for (const f of SCAFFOLD_DEMOS) {
    const p = path.join(PROJECT_ROOT, 'src', 'components', f);
    try { await fs.access(p); }
    catch { log(`  src/components/${f} already gone`); continue; }

    // Deleting a component the rest of the scaffold still imports breaks the
    // build. Footer.tsx is the real case: it is app chrome the export's shell
    // replaces, but it is ALSO imported by the scaffold's marketing layout,
    // which 11-legal-pages renders. A demo component is only safe to remove
    // once nothing references it.
    const referrers = await referrersOf(f, p, srcFiles);

    if (referrers.length) {
      kept.push({ file: f, referrers });
      log(`  KEPT src/components/${f} — still imported by ${referrers.join(', ')}`);
      continue;
    }
    // Keep the bytes so an incorrect deletion can be undone.
    removedBackups.set(f, await fs.readFile(p, 'utf-8'));
    await fs.unlink(p);
    deleted.push(f);
    log(`  deleted src/components/${f}`);
  }

  // Safety net: reference detection can only ever be as good as its parser, and
  // deletion is destructive. Let the real compiler have the last word — if
  // removing these files broke the typecheck, something referenced them that we
  // did not see, so put them back and say so rather than leaving a broken tree.
  if (deleted.length) {
    log('  typechecking to confirm nothing referenced the deleted files...');
    const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    if (tsc.status !== 0) {
      for (const [f, body] of removedBackups) {
        await fs.writeFile(path.join(PROJECT_ROOT, 'src', 'components', f), body);
        log(`  RESTORED src/components/${f} — the typecheck failed without it`);
      }
      const restored = [...removedBackups.keys()];
      return { deleted: [], kept: [...kept, ...restored.map((f) => ({ file: f, referrers: ['restored: typecheck failed without it'] }))] };
    }
    log('  typecheck clean — deletions confirmed');
  }
  return { deleted, kept };
}

async function patchRootTsx() {
  const before = await fs.readFile(ROOT_TSX, 'utf-8');
  await fs.writeFile(path.join(STATE_SUB, '__root.tsx.before.txt'), before);
  const appShellSrc = await fs.readFile(path.join(SHELL_DEST, 'AppShell.tsx'), 'utf-8');
  const wrapper = shellWrapperFor(appShellSrc);
  log(`  wrapper passes ${wrapper.passed || 0} callback prop(s) declared by the export`);
  await fs.writeFile(ROOT_TSX, NEW_ROOT_TSX(readProject().brandName, wrapper.body, wrapper.needsNavigate));
  log('  rewrote src/routes/__root.tsx');
}

// Collect top-level @import / @plugin at-rules, in source order.
//
// This uses postcss rather than a hand-written scanner. Three scanner
// generations were each wrong in a different way: `[^;]+;` truncated the
// webfont sheet at a semicolon inside its own quoted URL; a quote-aware
// version mishandled escaped quotes and comments containing semicolons; and a
// full hand-rolled scanner activated @import text inside an outer block
// comment, dropped imports preceded by a same-line comment, and truncated
// block-form @plugin at its first declaration semicolon.
//
// postcss is a real CSS parser and already present (Tailwind depends on it),
// so it resolves from PROJECT_ROOT. If it cannot be loaded we HALT — silently
// falling back to a regex is how styles.css got corrupted before, and this
// function's output is written over the file.
let _postcss = null;
function postcssModule() {
  if (_postcss) return _postcss;
  const req = createRequire(path.join(PROJECT_ROOT, 'noop.js'));
  try { _postcss = req('postcss'); }
  catch (e) {
    die('Could not load "postcss" from the project — it is required to rewrite src/styles.css safely. ' +
        'Original error: ' + e.message);
  }
  return _postcss;
}

function collectAtDirectives(css) {
  const postcss = postcssModule();
  let root;
  try { root = postcss.parse(css); }
  catch (e) { die('src/styles.css is not parseable CSS (' + e.message + '); refusing to rewrite it.'); }

  const out = [];
  root.each((node) => {
    // Top level only, and only the two at-rules this pipeline owns. A
    // block-form at-rule (one with { }) is NOT a directive — emitting it as
    // `@plugin foo;` would silently drop its body.
    if (node.type !== 'atrule') return;
    if (node.name !== 'import' && node.name !== 'plugin') return;
    // Block-form at-rules are valid and meaningful — Tailwind v4 configures a
    // plugin with `@plugin "x" { className: wysiwyg; }`. Skipping any node with
    // `.nodes` silently DELETED the plugin and its configuration. Emit the
    // node's own serialization so both forms survive verbatim.
    out.push(node.nodes ? node.toString() : `@${node.name} ${node.params};`);
  });
  return out;
}

async function rewriteStylesCss() {
  const before = await fs.readFile(STYLES_PATH, 'utf-8');
  await fs.writeFile(path.join(STATE_SUB, 'styles.css.before.txt'), before);

  // Extract skill 02's token block by locating its BEGIN/END COMMENT NODES
  // with postcss, not by regex. A non-greedy match between the marker strings
  // ended early when a declaration VALUE contained the end-marker text, e.g.
  //   --a: "/* === supertools 02-design-tokens END === */";
  // which wrote an unclosed string into styles.css.
  const tokensBlock = (() => {
    const postcss = postcssModule();
    let root;
    try { root = postcss.parse(before); }
    catch (e) { die('src/styles.css is not parseable CSS (' + e.message + '); refusing to rewrite it.'); }
    const kids = root.nodes || [];
    const isMarker = (n, text) => n.type === 'comment' && `/*${n.raws?.left ?? ' '}${n.text}${n.raws?.right ?? ' '}*/` === text;
    const beginIdx = kids.findIndex((n) => isMarker(n, BEGIN_MARKER));
    const endIdx = kids.findIndex((n, i) => i > beginIdx && isMarker(n, END_MARKER));
    if (beginIdx < 0 || endIdx < 0) {
      die('Could not find skill 02 BEGIN/END marker comments in src/styles.css — run skill 02 first.');
    }
    return kids.slice(beginIdx, endIdx + 1).map((n) => n.toString()).join('\n');
  })();

  // Carry skill 02's typography across verbatim. A missing @theme block means
  // 02 did not run (or was undone) — halt rather than substitute a default,
  // which is how this file used to end up with another project's fonts.
  // Extract @theme with postcss, not a regex. `/@theme\s*\{[\s\S]*?\}/` is
  // non-greedy, so a declaration whose VALUE contains a brace — e.g.
  // `--font-test: "a}b";` — truncated the block at the brace inside the string
  // and wrote an unclosed string into styles.css. postcss parses the original
  // fine; only the generated output was broken.
  const themeBlock = (() => {
    const postcss = postcssModule();
    let root;
    try { root = postcss.parse(before); }
    catch (e) { die('src/styles.css is not parseable CSS (' + e.message + '); refusing to rewrite it.'); }
    let found = null;
    root.each((n) => { if (n.type === 'atrule' && n.name === 'theme' && n.nodes) found = n; });
    return found ? found.toString() : null;
  })();
  const themeMatch = themeBlock ? [themeBlock] : null;
  if (!themeMatch) {
    die('No @theme block in src/styles.css — skill 02-design-tokens owns typography; run it first.');
  }

  // Transcribe every @import / @plugin directive already in the file, in
  // order, rather than asserting a list. Whatever 01 scaffolded and 02 wrote
  // (the webfont sheet, "tailwindcss", the typography plugin) is preserved
  // exactly; this skill does not decide which plugins a project has.
  const directives = collectAtDirectives(before);
  if (!directives.some((d) => /@import\s+"tailwindcss"/.test(d))) {
    die('No `@import "tailwindcss";` in src/styles.css — the scaffold is not in the expected state; run skill 01 first.');
  }
  log(`  carrying ${directives.length} @import/@plugin directive(s) + skill 02's @theme across`);

  const next = stylesPrefix({ directives, theme: themeMatch[0] }) + '\n' + tokensBlock + '\n';

  // Safety net: whatever the extraction logic did, the RESULT must be valid CSS
  // that still carries the theme and the token block. Any future edge case in
  // extraction therefore aborts safely with the original file intact, instead
  // of writing something broken. styles.css.before.txt is the restore point.
  {
    const postcss = postcssModule();
    try { postcss.parse(next); }
    catch (e) {
      die('The rewritten src/styles.css does not parse (' + e.message + '). ' +
          'The original file is untouched; its snapshot is at ' +
          path.join(STATE_SUB, 'styles.css.before.txt') + '.');
    }
    if (!/@theme\s*\{/.test(next) || !next.includes(BEGIN_MARKER) || !next.includes(END_MARKER)) {
      die('The rewritten src/styles.css lost the @theme block or the skill 02 token markers. ' +
          'Refusing to write; the original file is untouched.');
    }
  }
  await fs.writeFile(STYLES_PATH, next);
  log(`  rewrote src/styles.css (${before.length} → ${next.length} bytes)`);
  return { directives, theme: themeMatch[0] };
}

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  const prior = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '02-design-tokens.json'), 'utf-8')
  );
  if (prior.status !== 'ok') die('02-design-tokens not ok; halting.');

  try { requireExport(); } catch (e) { die(e.message); }

  // Which components exist is the export's call, not this skill's.
  let shellFiles;
  try { shellFiles = shellComponentFiles(); } catch (e) { die(e.message); }
  log(`▶ Export ships ${shellFiles.length} shell components: ${shellFiles.join(', ')}`);

  log('▶ Copying the export design kit the shell components depend on...');
  const kitFiles = await copyDesignKit();

  log('▶ Copying shell components...');
  const kitImportsRewritten = await copyShellComponents(shellFiles);

  // Must run AFTER the copy — the dependency list is derived from what the
  // copied files actually import, not from a list held by this skill.
  log('▶ Installing the packages the export imports...');
  const installedDeps = await ensureExportDeps([
    ...shellFiles.map((f) => path.join(SHELL_DEST, f)),
    ...kitFiles.map((f) => path.join(KIT_DEST, f)),
  ]);

  log('▶ Deleting scaffold demo components...');
  const demoResult = await deleteScaffoldDemos();

  log('▶ Patching src/routes/__root.tsx...');
  await patchRootTsx();

  log('▶ Rewriting src/styles.css (drop scaffold demo CSS, preserve skill 02 typography + tokens)...');
  const styles = await rewriteStylesCss();

  const summary = {
    shellComponentsFrom: SHELL_SRC,
    shellComponents: shellFiles.map((f) => path.join(SHELL_DEST, f)),
    designKitFrom: KIT_SRC,
    designKit: kitFiles.map((f) => path.join(KIT_DEST, f)),
    kitImportsRewritten,
    installedDeps,
    deletedScaffoldDemos: demoResult.deleted,
    keptScaffoldDemos: demoResult.kept,
    rootTsxRewritten: ROOT_TSX,
    stylesCssRewritten: STYLES_PATH,
    // Recorded so the receipt shows the typography came from skill 02, not here.
    typographyCarriedFromSkill02: styles,
    radixDropdownMenu: 'installed',
    completedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(STATE_SUB, 'patch-summary.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );

  console.log('---SETUP_DONE---');
  console.log(JSON.stringify(summary, null, 2));
}

// Entry-point guard (authoring-checklist rule 15). Without it a bare
// `import()` of this module — by a test, a tool, or anything introspecting the
// skill — silently re-runs the whole scaffold merge. 01-project-init already
// carries this guard; 03 did not, and importing it to check that it parsed
// executed a full setup as a side effect.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
