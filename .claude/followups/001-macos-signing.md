# Sign and notarize macOS releases

Status: implemented and locally verified, CI provisioning and released-installation checks pending
Recorded: 2026-10-29
Priority: first

## Goal

Let people install Jump on macOS without running the quarantine-clearing Terminal command.

## Current release

Jump v0.1.3 remains unsigned and unnotarized. Its published assets were not replaced. The website and README retain the existing Mac and Windows installation warnings. The implementation prepares v0.1.4 but does not publish it.

## Implementation on 2026-10-29

Main was clean and synced before creating `feat/release-signing`. No history was imported from jump-private. Jot's `.github/workflows/public-release.yml`, `scripts/prepare-signing.sh`, and `scripts/package-release.sh` informed the CI keychain import and explicit Apple notarization flow.

The existing Developer ID Application identity is valid until 2031-09-17. Its team is `M59NWWY4WZ`. Local signing reused the identity in Keychain. Nathan privately created and validated the `jump-notary` profile. No private key was exported, and no repository signing secrets were provisioned.

Tauri signs the app with hardened runtime and release entitlements. `scripts/release_macos.py` then notarizes and staples the app, creates and timestamp-signs the DMG, and notarizes and staples the final DMG. Its reusable verifier mounts the DMG read-only and checks the contained app. The resource map in `src-tauri/tauri.conf.json` remains the source for required license checks.

The release workflow requires manual dispatch on main and an exact version confirmation. Verification is the default. Optional draft staging requires both platform builds and the exact artifact set. Automatic publication and `--clobber` were removed. Published releases, existing assets, conflicting tags, duplicate drafts, incorrect source commits, and unconfirmed API failures stop staging. Read-only preflight checks published releases and tags. Full draft discovery runs with the staging job's write token. There is no publish job.

Normal development needs no signing credentials. The base Tauri configuration, all packaged license notices, and updater behavior remain unchanged. Release tooling has dedicated PR checks.

## Native verification results

The first credential-free app build passed. A Tauri-built local v0.1.3 DMG established the initial signing baseline. It was never uploaded and was correctly rejected as unnotarized.

The new explicit packaging path then built a local v0.1.4 DMG. Apple accepted both submissions on 2026-10-29:

- App submission `c054f1dc-b00e-428c-94b8-f5ce76debb24` returned `Accepted`.
- DMG submission `a19dfaf0-69f8-49d0-b133-262f7559c3c9` returned `Accepted`.

The final verifier passed twice, including after the cleanup fix. It checked the actual DMG and its contained app:

1. Strict signatures, Developer ID authority and team, secure timestamps, app hardened runtime, release entitlements, and arm64 architecture.
2. Valid app and DMG staples, enabled Gatekeeper, and `Notarized Developer ID` acceptance for both.
3. Bundle identifier `com.nathanclairmonte.jump`, version `0.1.4`, minimum macOS 13.0, and the `/Applications` symlink.
4. All five packaged license files matched their sources byte for byte.

The local artifact is `/tmp/jump-0.1.4-notarized-20261029/Jump_0.1.4_aarch64.dmg`. Its SHA-256 is `6277480f0e6314116f486aea7c51fb811fd38eb511544d543bb1eefb7939c5d8`. It is a pre-release verification build from the working tree, not a published release candidate. Its recorded source SHA names the base commit from before the implementation commits. Do not stage these local bytes as a release; rebuild from the final reviewed commit.

The frontend suite passed 97 tests, the native core suite passed 117 tests, and Biome passed. All 35 release safety tests, actionlint, and ShellCheck passed. The PR CI follow-up replaced a cleanup guard that triggered ShellCheck SC2015 with an explicit conditional. The fixed scripts pass ShellCheck 0.9.0 and 0.11.0, and a symlink test confirms that outside files remain protected. Early standalone signing attempts returned `errSecInternalComponent`; local signing succeeded after Keychain access approval. No signing bypass was added.

## Remaining steps

1. Obtain approval before exporting the existing Developer ID private key for CI. An already exported valid archive can be reused through an approved private method.
2. Provision the six Apple secrets listed in [the release guide](../../docs/releasing.md) through private GitHub secret entry. GitHub cannot return Jot's stored secrets. Do not paste credentials into chat.
3. Run the reviewed workflow from main to verify both platform builds with CI credentials. Review accepted receipts, signatures, staples, Gatekeeper checks, checksums, and license resources before optional draft staging.
4. Obtain approval before publishing a new version. Do not replace any v0.1.3 asset.
5. Download the published installer through a browser with quarantine intact. Verify installation and notices before removing the Mac workaround. Keep the Windows warning until its separate released-installer checks pass.

## Boundaries

Do not merge, publish, export keys, or deploy website changes without the required approval. Do not add an updater. Do not remove installation warnings based only on local verification. Windows signing remains a separate service decision.

## References

- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/)
- [Apple Developer ID distribution](https://developer.apple.com/developer-id/)
- [Release guide](../../docs/releasing.md)

## Completion

A newly published Mac build passes signature, notarization, stapling, Gatekeeper, license-resource, and downloaded-installation checks. Installation instructions match that verified released artifact.
