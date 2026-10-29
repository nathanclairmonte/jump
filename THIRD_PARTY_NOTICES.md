# Third-party notices

Jump's MIT license covers its original source code. Third-party code and assets
retain their own licenses.

## Packaged app notices

Native app builds copy these files into `licenses/` in the app's Tauri resources.
Source paths below are relative to the repository root.

| Source | Packaged resource path |
| --- | --- |
| `LICENSE` | `licenses/LICENSE` |
| `THIRD_PARTY_NOTICES.md` | `licenses/THIRD_PARTY_NOTICES.md` |
| `dist/THIRD_PARTY_LICENSES.md` | `licenses/THIRD_PARTY_LICENSES.md` |
| `website/public/licenses/geist-OFL.txt` | `licenses/geist-OFL.txt` |
| `website/public/licenses/geist-mono-OFL.txt` | `licenses/geist-mono-OFL.txt` |

`bun run build` uses Vite to regenerate `dist/THIRD_PARTY_LICENSES.md` with license
texts for bundled frontend dependencies. Normal native app builds run this command
before Tauri copies the notices into the package.

The generated file covers bundled frontend dependencies. These notices do not
represent a complete license compliance review of native or transitive dependencies.

## shadcn/ui

Components under `src/components/ui/` and the `cn` helper in `src/lib/utils.ts` are based on
[shadcn/ui](https://github.com/shadcn-ui/ui), with local changes.
The upstream MIT notice is reproduced below.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Geist fonts

Jump and its website use Geist and Geist Mono from the Fontsource packages.
The font files are licensed under the SIL Open Font License 1.1.

- [Geist copyright and license](website/public/licenses/geist-OFL.txt)
- [Geist Mono copyright and license](website/public/licenses/geist-mono-OFL.txt)

The website serves these notices under `/licenses/` alongside its font assets.
Dependency packages retain their own copyright and license notices.

## Bootstrap Icons

The website uses the Apple, Windows, and GitHub SVG marks from
[Bootstrap Icons](https://icons.getbootstrap.com/). These website-only assets use
the MIT license. The website serves the original notice at
[`/licenses/bootstrap-icons-MIT.txt`](website/public/licenses/bootstrap-icons-MIT.txt).
These icons are not part of the native app's installer resources.
