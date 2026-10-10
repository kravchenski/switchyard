import type { BunPlugin } from 'bun';

const PACKAGE_ROOT_JSON = /require\(([\w$]+)\.default\.join\(packageRoot, "([\w.-]+\.json)"\)\)/g;

export function inlinePackageRootJson(source: string) {
  return source.replace(PACKAGE_ROOT_JSON, (_match, _path, file: string) => `require("../${file}")`);
}

export const playwrightJsonPlugin: BunPlugin = {
  name: 'playwright-package-root-json',
  setup(build) {
    build.onLoad({ filter: /[\\/]node_modules[\\/]playwright-core[\\/]lib[\\/][^\\/]+\.js$/ }, async ({ path }) => ({
      contents: inlinePackageRootJson(await Bun.file(path).text()),
      loader: 'js',
    }));
  },
};
