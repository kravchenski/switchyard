#!/usr/bin/env bun

import { join } from 'node:path';

import { playwrightJsonPlugin } from '../src/cli/sidecar-build.ts';

const SIDECARS = [
  { name: 'freeapi-gateway', entry: 'src/unified/server.ts' },
  { name: 'freeapi-accounts', entry: 'scripts/accounts.ts' },
];

export async function compileSidecars(target: string, triple: string, outdir: string) {
  const ext = target.includes('windows') ? '.exe' : '';
  const root = join(import.meta.dir, '..');
  const outputs: string[] = [];
  for (const sidecar of SIDECARS) {
    const outfile = join(outdir, `${sidecar.name}-${triple}${ext}`);
    const result = await Bun.build({
      entrypoints: [join(root, sidecar.entry)],
      external: ['chromium-bidi/*'],
      compile: { target: target as Bun.Build.CompileTarget, outfile },
      plugins: [playwrightJsonPlugin],
    });
    if (!result.success) throw new AggregateError(result.logs, `Failed to compile ${sidecar.entry}`);
    console.log(`Sidecar: ${outfile}`);
    outputs.push(outfile);
  }
  return outputs;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const target = value('--target');
  const triple = value('--triple');
  const outdir = value('--outdir');
  try {
    if (!target || !triple || !outdir) throw new Error('Usage: bun run scripts/compile-sidecars.ts --target <bun-target> --triple <rust-triple> --outdir <dir>');
    await compileSidecars(target, triple, outdir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
