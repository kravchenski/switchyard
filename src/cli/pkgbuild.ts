export type PkgbuildArch = 'x86_64' | 'aarch64';

export interface PkgbuildValues {
  version: string;
  sha256: Partial<Record<PkgbuildArch, string>>;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;

export function renderPkgbuild(template: string, values: PkgbuildValues) {
  if (!VERSION.test(values.version)) throw new Error(`Not a release version: ${values.version}`);
  let text = template.replace(/^pkgver=.*$/m, `pkgver=${values.version}`);
  for (const [arch, sum] of Object.entries(values.sha256) as Array<[PkgbuildArch, string | undefined]>) {
    if (!sum) continue;
    if (!SHA256.test(sum)) throw new Error(`Not a SHA-256 sum for ${arch}: ${sum}`);
    const line = new RegExp(`^sha256sums_${arch}=\\(.*\\)$`, 'm');
    if (!line.test(text)) throw new Error(`The PKGBUILD has no sha256sums_${arch} line`);
    text = text.replace(line, `sha256sums_${arch}=('${sum}')`);
  }
  return text;
}
