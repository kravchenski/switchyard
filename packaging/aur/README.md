# AUR package

`PKGBUILD` here builds the `switchyard-bin` package from the latest release. After every release, CI fills in the version and the SHA-256 sums for x86_64 and aarch64, attaches the file to the release as `PKGBUILD` and commits it here.

## Install with paru

paru reads PKGBUILDs straight from this repository, no AUR account needed. Add to `~/.config/paru/paru.conf`:

```ini
[switchyard]
Url = https://github.com/kravchenski/switchyard
Path = packaging/aur
GenerateSrcinfo
```

Then:

```bash
paru -Sy --pkgbuilds
paru -S switchyard-bin
```

`paru -Syu` picks up new releases.

## Publish to the AUR

To publish a release to the AUR:

```bash
git clone ssh://aur@aur.archlinux.org/switchyard-bin.git
cd switchyard-bin
curl -LO https://github.com/kravchenski/switchyard/releases/latest/download/PKGBUILD
makepkg --printsrcinfo > .SRCINFO
makepkg -si
git add PKGBUILD .SRCINFO
git commit -m "Update to <version>"
git push
```

`bun run scripts/pkgbuild.ts --version <x.y.z> --x86_64 <tarball> --out PKGBUILD` fills the template locally.
