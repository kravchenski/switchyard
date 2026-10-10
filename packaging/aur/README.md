# AUR package

`PKGBUILD` here is the template for the `switchyard-bin` AUR package. Every release attaches a filled copy (version and SHA-256 sums for x86_64 and aarch64) as the `PKGBUILD` asset.

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
