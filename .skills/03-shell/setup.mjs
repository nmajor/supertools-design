#!/usr/bin/env node
// 03-shell setup.
// Apply the application shell from design/product-plan/shell/.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';
import { readProject } from '../_shared/project.mjs';

const STATE_SUB    = path.join(PROJECT_ROOT, '.supertools-state', '03-shell');
const SHELL_SRC    = path.join(PROJECT_ROOT, 'design', 'product-plan', 'shell', 'components');
const SHELL_DEST   = path.join(PROJECT_ROOT, 'src', 'components', 'shell');
const ROOT_TSX     = path.join(PROJECT_ROOT, 'src', 'routes', '__root.tsx');
const STYLES_PATH  = path.join(PROJECT_ROOT, 'src', 'styles.css');
const PACKAGE_JSON = path.join(PROJECT_ROOT, 'package.json');

const SHELL_FILES = ['AppShell.tsx', 'MainNav.tsx', 'Footer.tsx', 'UserMenu.tsx', 'index.ts'];
const SCAFFOLD_DEMOS = ['Header.tsx', 'Footer.tsx', 'ThemeToggle.tsx'];

const DEFAULT_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@' +
  '0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;' +
  '1,9..144,500;1,9..144,600;1,9..144,700' +
  '&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600;9..40,700' +
  '&family=IBM+Plex+Mono:wght@400;500&display=swap';

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

const NEW_STYLES_PREFIX = `@import url("${DEFAULT_FONTS_URL}");
@import "tailwindcss";
@plugin "@tailwindcss/typography";

@theme {
  --font-sans:  "DM Sans", ui-sans-serif, system-ui, sans-serif;
  --font-serif: "Fraunces", Georgia, serif;
  --font-mono:  "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* minimal reset */
* { box-sizing: border-box; }
html, body, #app { min-height: 100%; }
body {
  margin: 0;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

`;

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

async function copyShellComponents() {
  await fs.mkdir(SHELL_DEST, { recursive: true });
  for (const f of SHELL_FILES) {
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
  const next = NEW_STYLES_PREFIX + tokensBlock + '\n';
  await fs.writeFile(STYLES_PATH, next);
  log(`  rewrote src/styles.css (${before.length} → ${next.length} bytes)`);
}

async function main() {
  loadEnv();
  await fs.mkdir(STATE_SUB, { recursive: true });

  const prior = JSON.parse(
    await fs.readFile(path.join(PROJECT_ROOT, '.supertools-state', '02-design-tokens.json'), 'utf-8')
  );
  if (prior.status !== 'ok') die('02-design-tokens not ok; halting.');

  log('▶ Ensuring @radix-ui/react-dropdown-menu installed...');
  await ensureRadixDep();

  log('▶ Copying shell components...');
  await copyShellComponents();

  log('▶ Deleting scaffold demo components...');
  await deleteScaffoldDemos();

  log('▶ Patching src/routes/__root.tsx...');
  await patchRootTsx();

  log('▶ Rewriting src/styles.css (drop lagoon/sea demo, preserve skill 02 tokens)...');
  await rewriteStylesCss();

  const summary = {
    shellComponents: SHELL_FILES.map((f) => path.join(SHELL_DEST, f)),
    deletedScaffoldDemos: SCAFFOLD_DEMOS.map((f) => path.join(PROJECT_ROOT, 'src', 'components', f)),
    rootTsxRewritten: ROOT_TSX,
    stylesCssRewritten: STYLES_PATH,
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
