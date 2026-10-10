#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const desktop = join(root, 'desktop');
const args = process.argv.slice(2);
const packageInstaller = args.includes('--package');
const skipSidecars = args.includes('--skip-sidecars');
const windows = process.platform === 'win32';
const exe = windows ? '.exe' : '';

const BUN_TARGETS: Record<string, string> = {
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'darwin-arm64': 'bun-darwin-arm64',
  'win32-x64': 'bun-windows-x64',
};

const FORMATS: Record<string, { format: string; pattern: RegExp }> = {
  linux: { format: 'deb', pattern: /\.deb$/ },
  darwin: { format: 'dmg', pattern: /\.dmg$/ },
  win32: { format: 'nsis', pattern: /-setup\.exe$/ },
};

async function run(command: string[], cwd = root) {
  console.log(`\n$ ${command.join(' ')}`);
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit' });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command[0]} exited with code ${code}`);
}

async function output(command: string[]) {
  const child = Bun.spawn(command, { cwd: root, stdout: 'pipe', stderr: 'pipe' });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 ? text : undefined;
}

async function hostTriple() {
  const info = await output(['rustc', '-vV']);
  const triple = info?.match(/^host: (.+)$/m)?.[1]?.trim();
  if (!triple) throw new Error('Rust is not installed: get it from https://rustup.rs');
  return triple;
}

async function main() {
  const platform = `${process.platform}-${process.arch}`;
  const bunTarget = BUN_TARGETS[platform];
  if (!bunTarget) throw new Error(`Unsupported platform: ${platform}`);
  const triple = await hostTriple();
  const sidecars = join(desktop, 'target', 'sidecars');

  if (!skipSidecars) {
    mkdirSync(sidecars, { recursive: true });
    await run(['bun', 'build', '--compile', `--target=${bunTarget}`, 'src/unified/server.ts', '--external', 'chromium-bidi/*', '--outfile', join(sidecars, `freeapi-gateway-${triple}${exe}`)]);
    await run(['bun', 'build', '--compile', `--target=${bunTarget}`, 'scripts/accounts.ts', '--external', 'chromium-bidi/*', '--outfile', join(sidecars, `freeapi-accounts-${triple}${exe}`)]);
  }

  await run(['cargo', 'build', '--manifest-path', join(desktop, 'Cargo.toml'), '--release', '--locked']);

  const dist = join(root, 'dist');
  mkdirSync(dist, { recursive: true });
  const app = join(dist, `switchyard${exe}`);
  copyFileSync(join(desktop, 'target', 'release', `freeapi-desktop${exe}`), app);
  console.log(`\nDesktop app: ${app}`);

  if (!packageInstaller) return;
  const target = FORMATS[process.platform];
  if (!target) throw new Error(`No installer format for ${process.platform}`);
  if (!await output(['cargo', 'packager', '--version'])) throw new Error('cargo-packager is missing: cargo install cargo-packager --locked');
  if (!existsSync(join(sidecars, `freeapi-gateway-${triple}${exe}`))) throw new Error('The installer needs the sidecars: run without --skip-sidecars');
  await run(['cargo', 'packager', '--release', '--formats', target.format], desktop);
  const packages = join(desktop, 'target', 'packages');
  const installer = readdirSync(packages).find(name => target.pattern.test(name));
  if (!installer) throw new Error(`No ${target.format} installer in ${packages}`);
  const copied = join(dist, installer);
  copyFileSync(join(packages, installer), copied);
  console.log(`Installer: ${copied}`);
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
