#!/usr/bin/env node
// 04-logo verifier.

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { loadEnv, PROJECT_ROOT } from '../_shared/env.mjs';

const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

const checks = [];
const fail = (n, d) => { checks.push({ name: n, ok: false, detail: d }); };
const pass = (n, d = '') => { checks.push({ name: n, ok: true, detail: d }); };

async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }
async function statSize(p) { try { return (await fs.stat(p)).size; } catch { return 0; } }

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}
async function probeUrl(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) }; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
async function killGroup(pid) {
  try { process.kill(-pid, 'SIGTERM'); } catch {}
  await new Promise((r) => setTimeout(r, 500));
  try { process.kill(-pid, 'SIGKILL'); } catch {}
}

async function main() {
  loadEnv();

  // File presence + minimum sizes
  const expectedFiles = [
    { name: 'logo.svg',             minBytes: 200 },
    { name: 'logo-mark.svg',        minBytes: 200 },
    { name: 'favicon.svg',          minBytes: 200 },
    { name: 'favicon.ico',          minBytes: 1000 },
    { name: 'apple-touch-icon.png', minBytes: 1000 },
    { name: 'og-image.png',         minBytes: 5000 },
  ];
  for (const f of expectedFiles) {
    const p = path.join(PUBLIC_DIR, f.name);
    if (!await exists(p)) { fail(`asset: ${f.name}`, 'missing'); continue; }
    const size = await statSize(p);
    size >= f.minBytes
      ? pass(`asset: ${f.name}`, `${size}B`)
      : fail(`asset: ${f.name}`, `${size}B < ${f.minBytes}B min`);
  }

  // Magic bytes
  const icoBuf = await fs.readFile(path.join(PUBLIC_DIR, 'favicon.ico'));
  (icoBuf[0] === 0x00 && icoBuf[1] === 0x00 && icoBuf[2] === 0x01 && icoBuf[3] === 0x00)
    ? pass('favicon.ico header (ICO magic)')
    : fail('favicon.ico header (ICO magic)', `got ${icoBuf.slice(0, 4).toString('hex')}`);

  const appleBuf = await fs.readFile(path.join(PUBLIC_DIR, 'apple-touch-icon.png'));
  (appleBuf[0] === 0x89 && appleBuf[1] === 0x50 && appleBuf[2] === 0x4E && appleBuf[3] === 0x47)
    ? pass('apple-touch-icon.png header (PNG magic)')
    : fail('apple-touch-icon.png header', `got ${appleBuf.slice(0, 4).toString('hex')}`);

  const ogBuf = await fs.readFile(path.join(PUBLIC_DIR, 'og-image.png'));
  (ogBuf[0] === 0x89 && ogBuf[1] === 0x50 && ogBuf[2] === 0x4E && ogBuf[3] === 0x47)
    ? pass('og-image.png header (PNG magic)')
    : fail('og-image.png header', `got ${ogBuf.slice(0, 4).toString('hex')}`);

  // Dimension checks — guard against the SVG/PNG silently drifting from the
  // documented design (file-size + magic bytes alone don't catch that).
  const svgDim = (svg) => {
    const wh = svg.match(/width="(\d+)"\s+height="(\d+)"/);
    if (wh) return { w: +wh[1], h: +wh[2] };
    const vb = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
    return vb ? { w: +vb[1], h: +vb[2] } : null;
  };
  // PNG width/height live in the IHDR chunk: big-endian uint32 at offsets 16 & 20.
  const pngDim = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

  const expectSvgDim = async (file, w, h) => {
    const d = svgDim(await fs.readFile(path.join(PUBLIC_DIR, file), 'utf-8'));
    d && d.w === w && d.h === h
      ? pass(`dims: ${file}`, `${w}×${h}`)
      : fail(`dims: ${file}`, `expected ${w}×${h}, got ${d ? `${d.w}×${d.h}` : 'unparseable'}`);
  };
  await expectSvgDim('logo.svg', 320, 96);
  await expectSvgDim('logo-mark.svg', 96, 96);
  await expectSvgDim('favicon.svg', 96, 96);

  const appleDim = pngDim(appleBuf);
  (appleDim.w === 180 && appleDim.h === 180)
    ? pass('dims: apple-touch-icon.png', '180×180')
    : fail('dims: apple-touch-icon.png', `expected 180×180, got ${appleDim.w}×${appleDim.h}`);
  const ogDim = pngDim(ogBuf);
  (ogDim.w === 1200 && ogDim.h === 630)
    ? pass('dims: og-image.png', '1200×630')
    : fail('dims: og-image.png', `expected 1200×630, got ${ogDim.w}×${ogDim.h}`);

  // PWA icons (managed by this skill so they stay in sync with the brand)
  for (const [file, dim] of [['logo192.png', 192], ['logo512.png', 512]]) {
    const p = path.join(PUBLIC_DIR, file);
    if (!await exists(p)) { fail(`pwa: ${file}`, 'missing'); continue; }
    const buf = await fs.readFile(p);
    if (!(buf[0] === 0x89 && buf[1] === 0x50)) { fail(`pwa: ${file}`, 'not a PNG'); continue; }
    const d = pngDim(buf);
    (d.w === dim && d.h === dim)
      ? pass(`pwa: ${file}`, `${dim}×${dim}`)
      : fail(`pwa: ${file}`, `expected ${dim}×${dim}, got ${d.w}×${d.h}`);
  }

  // manifest.json references our PWA icons
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(PUBLIC_DIR, 'manifest.json'), 'utf-8'));
    const srcs = (manifest.icons || []).map((i) => i.src);
    (srcs.includes('logo192.png') && srcs.includes('logo512.png'))
      ? pass('manifest.json icons', `${srcs.length} entries`)
      : fail('manifest.json icons', `missing logo192/logo512 — got ${JSON.stringify(srcs)}`);
    manifest.name && manifest.name !== 'Create TanStack App Sample'
      ? pass('manifest.json name de-scaffolded', manifest.name)
      : fail('manifest.json name de-scaffolded', `still generic: ${manifest.name}`);
  } catch (e) {
    fail('manifest.json', `unreadable: ${e.message}`);
  }

  // __root.tsx wiring
  const rootTsx = await fs.readFile(path.join(PROJECT_ROOT, 'src/routes/__root.tsx'), 'utf-8');
  /rel:\s*['"]icon['"]\s*,\s*href:\s*['"]\/favicon\.svg['"]/.test(rootTsx)
    ? pass('__root.tsx: rel="icon" /favicon.svg')
    : fail('__root.tsx: rel="icon" /favicon.svg', 'missing');
  /rel:\s*['"]alternate icon['"]/.test(rootTsx)
    ? pass('__root.tsx: rel="alternate icon"')
    : fail('__root.tsx: rel="alternate icon"', 'missing');
  /rel:\s*['"]apple-touch-icon['"]/.test(rootTsx)
    ? pass('__root.tsx: rel="apple-touch-icon"')
    : fail('__root.tsx: rel="apple-touch-icon"', 'missing');
  /property:\s*['"]og:image['"]/.test(rootTsx)
    ? pass('__root.tsx: og:image meta')
    : fail('__root.tsx: og:image meta', 'missing');
  /twitter:card/.test(rootTsx)
    ? pass('__root.tsx: twitter:card meta')
    : fail('__root.tsx: twitter:card meta', 'missing');

  // npm run build + tsc
  const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  build.status === 0
    ? pass('npm run build')
    : fail('npm run build', (build.stderr || build.stdout || '').slice(-1500));
  const tsc = spawnSync('npx', ['tsc', '--noEmit'], { cwd: PROJECT_ROOT, encoding: 'utf-8' });
  tsc.status === 0
    ? pass('tsc --noEmit')
    : fail('tsc --noEmit', (tsc.stderr || tsc.stdout || '').slice(-1500));

  // vite dev serves the assets
  const port = await pickFreePort();
  const viteBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'vite');
  const vite = spawn(viteBin, ['dev', '--port', String(port), '--host', '127.0.0.1'], {
    cwd: PROJECT_ROOT, detached: true, stdio: 'ignore',
  });
  try {
    for (const asset of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'og-image.png']) {
      const res = await probeUrl(`http://127.0.0.1:${port}/${asset}`, 60000);
      res
        ? pass(`served: /${asset}`, `HTTP ${res.status} ${res.buf.length}B`)
        : fail(`served: /${asset}`, 'no 2xx within 60s');
    }
  } finally {
    if (vite.pid) await killGroup(vite.pid);
  }

  let okCount = 0;
  for (const c of checks) {
    const mark = c.ok ? 'OK ' : 'FAIL';
    const tail = c.detail ? ' — ' + c.detail.split('\n').slice(0, 2).join(' / ') : '';
    console.log(`[${mark}] ${c.name}${tail}`);
    if (c.ok) okCount++;
  }
  console.log(`\n${okCount}/${checks.length} checks passed`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(2); });
