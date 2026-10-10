#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

const FORMATS: Record<string, Array<{ format: string; pattern: RegExp }>> = {
  linux: [
    { format: 'deb', pattern: /\.deb$/ },
    { format: 'appimage', pattern: /\.AppImage$/ },
    { format: 'pacman', pattern: /\.tar\.gz$/ },
  ],
  darwin: [{ format: 'dmg', pattern: /\.dmg$/ }],
  win32: [{ format: 'nsis', pattern: /-setup\.exe$/ }],
};

const LINUX_ASSETS: Record<string, string> = { x64: 'linux-x64', arm64: 'linux-arm64' };

async function run(command: string[], cwd = root, env: Record<string, string> = {}) {
  console.log(`\n$ ${command.join(' ')}`);
  const child = Bun.spawn(command, { cwd, stdout: 'inherit', stderr: 'inherit', stdin: 'inherit', env: { ...process.env, ...env } });
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
  const targets = FORMATS[process.platform];
  if (!targets) throw new Error(`No installer format for ${process.platform}`);
  if (!await output(['cargo', 'packager', '--version'])) throw new Error('cargo-packager is missing: cargo install cargo-packager --locked');
  if (!existsSync(join(sidecars, `freeapi-gateway-${triple}${exe}`))) throw new Error('The installer needs the sidecars: run without --skip-sidecars');
  await run(['cargo', 'packager', '--release', '--formats', targets.map(target => target.format).join(',')], desktop, { NO_STRIP: '1' });
  const packages = join(desktop, 'target', 'packages');
  const built = readdirSync(packages);
  const copied: string[] = [];
  for (const target of targets) {
    const installer = built.find(name => target.pattern.test(name));
    if (!installer) throw new Error(`No ${target.format} installer in ${packages}`);
    copyFileSync(join(packages, installer), join(dist, installer));
    copied.push(join(dist, installer));
    console.log(`Installer: ${join(dist, installer)}`);
  }
  if (process.platform === 'linux') await archPackage(copied.find(file => file.endsWith('.tar.gz'))!, dist);
}

async function archPackage(tarball: string, dist: string) {
  if (!await output(['makepkg', '--version'])) {
    console.log('makepkg not found: skipping the Arch package');
    return;
  }
  const version = (await Bun.file(join(root, 'package.json')).json() as { version: string }).version;
  const asset = LINUX_ASSETS[process.arch];
  if (!asset) throw new Error(`No Linux asset name for ${process.arch}`);
  const arch = join(dist, 'arch');
  rmSync(arch, { recursive: true, force: true });
  mkdirSync(arch, { recursive: true });
  const source = join(arch, `switchyard-${version}-${asset}.tar.gz`);
  copyFileSync(tarball, source);
  await run(['bun', 'run', 'scripts/pkgbuild.ts', '--version', version, `--${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`, source, '--out', join(arch, 'PKGBUILD')]);
  await run(['makepkg', '--force', '--noconfirm'], arch);
  const pkg = readdirSync(arch).find(name => name.endsWith('.pkg.tar.zst'));
  if (!pkg) throw new Error(`makepkg did not produce a package in ${arch}`);
  copyFileSync(join(arch, pkg), join(dist, pkg));
  console.log(`Arch package: ${join(dist, pkg)} (install: sudo pacman -U ${join(dist, pkg)})`);
}

try {
  await main();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
