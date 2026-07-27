#!/usr/bin/env node
// 03-shell setup.
// Apply the application shell from design/product-plan/shell/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';
import { requireExport, SHELL_DIR, shellComponentFiles } from '../_shared/design-os.mjs';

const STATE_SUB    = path.join(PROJECT_ROOT, '.supertools-state', '03-shell');
const SHELL_SRC    = SHELL_DIR;
const SHELL_DEST   = path.join(PROJECT_ROOT, 'src', 'components', 'shell');
const ROOT_TSX     = path.join(PROJECT_ROOT, 'src', 'routes', '__root.tsx');
const STYLES_PATH  = path.join(PROJECT_ROOT, 'src', 'styles.css');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');

const SCAFFOLD_DEMOS = ['Header.tsx', 'Footer.tsx', 'ThemeToggle.tsx'];

const BEGIN_MARKER = '/* === supertools 02-design-tokens BEGIN === */';
const END_MARKER   = '/* === supertools 02-design-tokens END === */';

const NEW_ROOT_TSX = (brandName) => `import { HeadContent, Scripts, createRootRoute, useNavigate } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { AppShell } from '../components/shell'

import appCss from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: '${brandName}' },
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
  const navigate = useNavigate()
  return (
    <AppShell
      user={null}
      navigationItems={[]}
      onNavigate={(href) => navigate({ to: href as never })}
      onSignIn={() => navigate({ to: '/login' as never })}
      onLogout={() => { /* wired in skill 15 (ralph-build) when auth lands */ }}
    >
      {children}
    </AppShell>
  )
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

async function ensureRadixDep() {
  const pkg = JSON.parse(await fs.readFile(PACKAGE_JSON, 'utf-8'));
  if (pkg.dependencies?.['@radix-ui/react-dropdown-menu']) {
    log('  @radix-ui/react-dropdown-menu already in dependencies');
    return;
  }
  run('npm', ['install', '--no-fund', '--no-audit', '@radix-ui/react-dropdown-menu']);
}

async function copyShellComponents(shellFiles) {
  await fs.mkdir(SHELL_DEST, { recursive: true });
  for (const f of shellFiles) {
    const content = await fs.readFile(path.join(SHELL_SRC, f), 'utf-8');
    await fs.writeFile(path.join(SHELL_DEST, f), content);
    log(`  copied src/components/shell/${f}`);
  }
}

async function deleteScaffoldDemos() {
  for (const f of SCAFFOLD_DEMOS) {
    const p = path.join(PROJECT_ROOT, 'src', 'components', f);
    try {
      await fs.unlink(p);
      log(`  deleted src/components/${f}`);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      log(`  src/components/${f} already gone`);
    }
  }
}

async function patchRootTsx() {
  const before = await fs.readFile(ROOT_TSX, 'utf-8');
  await fs.writeFile(path.join(STATE_SUB, '__root.tsx.before.txt'), before);
  await fs.writeFile(ROOT_TSX, NEW_ROOT_TSX(readProject().brandName));
  log('  rewrote src/routes/__root.tsx');
}

async function rewriteStylesCss() {
  const before = await fs.readFile(STYLES_PATH, 'utf-8');
  await fs.writeFile(path.join(STATE_SUB, 'styles.css.before.txt'), before);

  const markerRe = new RegExp(
    `${escapeRegex(BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(END_MARKER)}`
  );
  const m = before.match(markerRe);
  if (!m) die('Could not find skill 02 BEGIN/END markers in src/styles.css — run skill 02 first.');
  const tokensBlock = m[0];

  // Carry skill 02's typography across verbatim. A missing @theme block means
  // 02 did not run (or was undone) — halt rather than substitute a default,
  // which is how this file used to end up with another project's fonts.
  const themeMatch = before.match(/@theme\s*\{[\s\S]*?\}/);
  if (!themeMatch) {
    die('No @theme block in src/styles.css — skill 02-design-tokens owns typography; run it first.');
  }

  // Transcribe every @import / @plugin directive already in the file, in
  // order, rather than asserting a list. Whatever 01 scaffolded and 02 wrote
  // (the webfont sheet, "tailwindcss", the typography plugin) is preserved
  // exactly; this skill does not decide which plugins a project has.
  const directives = [...before.matchAll(/^\s*@(?:import|plugin)\s+[^;]+;/gm)].map((m) => m[0].trim());
  if (!directives.some((d) => /@import\s+"tailwindcss"/.test(d))) {
    die('No `@import "tailwindcss";` in src/styles.css — the scaffold is not in the expected state; run skill 01 first.');
  }
  log(`  carrying ${directives.length} @import/@plugin directive(s) + skill 02's @theme across`);

  const next = stylesPrefix({ directives, theme: themeMatch[0] }) + '\n' + tokensBlock + '\n';
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

  log('▶ Ensuring @radix-ui/react-dropdown-menu installed...');
  await ensureRadixDep();

  log('▶ Copying shell components...');
  await copyShellComponents(shellFiles);

  log('▶ Deleting scaffold demo components...');
  await deleteScaffoldDemos();

  log('▶ Patching src/routes/__root.tsx...');
  await patchRootTsx();

  log('▶ Rewriting src/styles.css (drop scaffold demo CSS, preserve skill 02 typography + tokens)...');
  const styles = await rewriteStylesCss();

  const summary = {
    shellComponentsFrom: SHELL_SRC,
    shellComponents: shellFiles.map((f) => path.join(SHELL_DEST, f)),
    deletedScaffoldDemos: SCAFFOLD_DEMOS.map((f) => path.join(PROJECT_ROOT, 'src', 'components', f)),
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

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
