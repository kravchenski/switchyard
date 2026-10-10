import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

import { renderPkgbuild } from '../src/cli/pkgbuild.ts';

const template = readFileSync(new URL('../packaging/aur/PKGBUILD', import.meta.url), 'utf8');
const sum = 'a'.repeat(64);

describe('renderPkgbuild', () => {
  test('sets the version and the sums of the given architectures', () => {
    const text = renderPkgbuild(template, { version: '2.12.0', sha256: { x86_64: sum } });
    expect(text).toContain('pkgver=2.12.0\n');
    expect(text).toContain(`sha256sums_x86_64=('${sum}')`);
    expect(text).toContain("sha256sums_aarch64=('SKIP')");
    expect(text).toContain('/releases/download/v${pkgver}/switchyard-${pkgver}-linux-x64.tar.gz');
  });

  test('keeps the bundled Bun binaries unstripped', () => {
    expect(template).toMatch(/^options=\(.*'!strip'.*\)$/m);
  });

  test('rejects versions pacman cannot use and malformed sums', () => {
    expect(() => renderPkgbuild(template, { version: '2.12.0-beta', sha256: {} })).toThrow('Not a release version');
    expect(() => renderPkgbuild(template, { version: '2.12.0', sha256: { x86_64: 'abc' } })).toThrow('Not a SHA-256 sum');
  });
});
