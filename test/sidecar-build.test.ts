import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

import { inlinePackageRootJson } from '../src/cli/sidecar-build.ts';

const PLAYWRIGHT_LIB = join(import.meta.dir, '..', 'node_modules', 'playwright-core', 'lib');
const RUNTIME_JSON = /require\([\w$]+\.default\.join\(packageRoot, "[^"]+\.json"\)\)/;

describe('inlinePackageRootJson', () => {
  test('turns package-root JSON reads into static requires the compiler can embed', () => {
    const source = 'packageJSON = require(import_path9.default.join(packageRoot, "package.json"));\n'
      + 'const browsers = require(import_path20.default.join(packageRoot, "browsers.json"));';
    expect(inlinePackageRootJson(source)).toBe('packageJSON = require("../package.json");\nconst browsers = require("../browsers.json");');
  });

  test('leaves no package-root JSON read in the installed playwright-core', () => {
    const files = readdirSync(PLAYWRIGHT_LIB).filter(name => name.endsWith('.js'));
    const patched = files.filter(name => RUNTIME_JSON.test(readFileSync(join(PLAYWRIGHT_LIB, name), 'utf8')));
    expect(patched.length).toBeGreaterThan(0);
    for (const name of patched) {
      expect(inlinePackageRootJson(readFileSync(join(PLAYWRIGHT_LIB, name), 'utf8'))).not.toMatch(RUNTIME_JSON);
    }
  });
});
