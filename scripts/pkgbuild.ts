#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderPkgbuild, type PkgbuildArch } from '../src/cli/pkgbuild.ts';

const USAGE = 'Usage: bun run scripts/pkgbuild.ts --version <x.y.z> [--x86_64 <tarball>] [--aarch64 <tarball>] --out <file>';

function sha256(file: string) {
  return new Bun.CryptoHasher('sha256').update(readFileSync(file)).digest('hex');
}

try {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const version = value('--version');
  const out = value('--out');
  if (!version || !out) throw new Error(USAGE);
  const sums: Partial<Record<PkgbuildArch, string>> = {};
  for (const arch of ['x86_64', 'aarch64'] as const) {
    const tarball = value(`--${arch}`);
    if (tarball) sums[arch] = sha256(tarball);
  }
  const template = readFileSync(join(import.meta.dir, '..', 'packaging', 'aur', 'PKGBUILD'), 'utf8');
  writeFileSync(out, renderPkgbuild(template, { version, sha256: sums }));
  console.log(`PKGBUILD: ${out}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
