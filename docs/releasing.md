# Verify and stage a release

The release workflow runs only by manual dispatch on `main`. Enter the exact `package.json` version in `confirm_version`. Leave `stage_draft` disabled to build and verify without creating a GitHub release.

## Set up signing privately

Initial CI setup requires secret provisioning. Private-key export requires Nathan's explicit approval. Record completed native verification and remaining checks in the [macOS signing followup](../.claude/followups/001-macos-signing.md).

After approval, enter these existing credentials privately in the repository's GitHub Actions secrets settings. Do not paste credentials into issues, pull requests, logs, or chat.

- `APPLE_DEVELOPER_ID_P12_BASE64` contains the existing Developer ID Application certificate and private key archive.
- `APPLE_DEVELOPER_ID_P12_PASSWORD` unlocks that archive.
- `APPLE_DEVELOPER_ID` names the existing Developer ID Application identity for team `M59NWWY4WZ`.
- `APPLE_ID` and `APPLE_APP_SPECIFIC_PASSWORD` authenticate notarization.
- `APPLE_TEAM_ID` must equal `M59NWWY4WZ`.

CI imports the certificate into a temporary job-specific keychain. Its cleanup step runs even after failure. Missing credentials stop the signing path before the app build. Normal development requires no credentials.

## Build and verify locally

Use macOS with Xcode command-line tools, Bun, Rust, and the existing signing identity already installed. Set `APPLE_SIGNING_IDENTITY` and `APPLE_TEAM_ID`. Set `NOTARY_KEYCHAIN_PROFILE` to an existing notarytool profile. Alternatively, set the Apple account and app-specific password variables listed above.

Run these commands from the repository root. Use a new output directory for each candidate.

```sh
python3 scripts/release_macos.py build --sha "$(git rev-parse HEAD)" --output /tmp/jump-0.1.4-macos
python3 scripts/release_macos.py verify --sha "$(git rev-parse HEAD)" --dmg /tmp/jump-0.1.4-macos/Jump_0.1.4_aarch64.dmg
```

The build command submits the app and final DMG to Apple for notarization. It saves both Accepted receipts, package verification evidence, and a SHA-256 checksum beside the DMG. It uses one explicit notarization path and staples the app before packaging. Release entitlements disable debugger access. The DMG contains `Jump.app` and an `/Applications` symlink.

Verification mounts the DMG read-only and always attempts detach. It checks both signatures, the expected Developer ID team, secure timestamps, notarization staples, and Gatekeeper assessments. It checks app identity, version, minimum macOS version, arm64 architecture, hardened runtime, absence of debug entitlements, and exact packaged license bytes. Source license files, including the generated `dist/THIRD_PARTY_LICENSES.md`, must exist. Run `bun run build` first when verifying an existing DMG from a clean checkout.

Native verification requires macOS with Gatekeeper enabled. Unit tests cannot prove Apple's acceptance, trust policy on another Mac, or browser-download installation behavior. Complete a real notarized candidate and a clean-Mac download/install check before publishing. Windows remains an unsigned NSIS installer. Its filename, non-empty PE payload, and checksum checks do not establish Windows signature trust or installation behavior.

## Stage without publishing

After reviewing verification evidence, dispatch with `stage_draft` enabled. Both platform builds and the exact artifact-set check must pass before staging.

Before building, `preflight` uses `contents:read` to check for a published release and an existing tag. The standalone `guard` command makes the same limited checks. Both commands reject any existing tag. Neither command can confirm the absence of drafts. GitHub's [release API](https://docs.github.com/en/rest/releases/releases#list-releases) exposes draft listings only to users with push access.

The staging job uses `contents:write` to inspect every page of releases, including drafts. It rejects multiple releases with the candidate tag. It rechecks the selected draft by release ID immediately before uploading installers, including after creating a new draft.

Only a missing release or an empty draft targeting the exact source SHA is eligible for staging. Published releases, orphan tags, mismatched targets, and drafts with any assets stop staging. A draft with an existing tag must also have that tag resolve to the exact source SHA. The workflow's earlier preflight conservatively rejects existing tags because it cannot verify their draft state. Assets are never replaced. A partial upload leaves a non-empty draft that requires a separate manual decision. The workflow does not delete or repair it.

Download receipts, verification evidence, and checksums from the workflow artifacts. Review the draft and publish separately through GitHub after native installation checks. There is no publish job. Existing `v0.1.3` assets remain untouched.

## Check release tooling

```sh
python3 -m unittest discover -s scripts/tests -v
actionlint .github/workflows/release.yml .github/workflows/pr-release.yml
```
