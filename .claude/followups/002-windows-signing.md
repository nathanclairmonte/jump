# Choose and configure Windows signing

Status: investigated, service decision pending
Recorded: 2026-10-29
Priority: after macOS signing, or investigate independently

## Goal

Sign the Jump executable and NSIS installer with a trusted publisher identity.

## Current state

Jump v0.1.3 ships an unsigned x64 NSIS installer. Builds use `.github/workflows/release.yml` and the Windows bundle settings in `src-tauri/tauri.conf.json`. Apple signing credentials cannot sign Windows builds.

## Decision to make

Investigate SignPath Foundation first. It offers signing for approved open-source projects. Approval is not guaranteed. Its terms require a public signing policy and manual approval for each signing request. The certificate names SignPath Foundation as publisher.

Microsoft Artifact Signing is the paid alternative to assess if SignPath is unsuitable. Confirm current pricing, individual eligibility, region support, identity verification, and GitHub Actions integration before recommending a subscription. Do not infer eligibility from Nathan's timezone.

Signing establishes publisher identity. It does not guarantee that SmartScreen warnings disappear for a new build. Keep installation copy accurate about that limitation.

## Assessment on 2026-10-29

Start with SignPath Foundation if Nathan accepts its publisher identity and manual release approvals. Do not assume that Jump will qualify. Microsoft Artifact Signing Basic is the practical alternative if Nathan confirms eligibility, identity disclosure, and the recurring cost. No service has been selected or configured.

### SignPath Foundation

Jump is public, MIT-licensed, documented, maintained, and already has a Windows installer. Its public repository was created on 2026-10-29. At assessment it had one contributor, no stars, and no forks. The Foundation requires verifiable reputation for executable applications. It publishes no numerical threshold, so acceptance is uncertain.

The Foundation requires the following before signing:

1. Eligible open-source components without commercial dual licensing or prohibited proprietary code.
2. MFA and named author, reviewer, and signing approver responsibilities.
3. Manual approval of each signing request.
4. A public signing policy on the homepage and download or release pages, with attribution, member roles, and privacy information.
5. Verifiable builds, consistent product metadata, uninstall support, and appropriate system-change notices.

The certificate identifies SignPath Foundation as publisher. Its certificate can sign Jump's own binaries, but cannot sign upstream binaries. Tauri's NSIS signing hook also receives upstream plugin DLLs. A Foundation integration needs explicit exclusions and an approved way to sign the embedded Jump executable and final installer. Do not assume a synchronous drop-in hook.

Sources are the [Foundation terms](https://signpath.org/terms), [service description](https://signpath.org/), and [GitHub integration](https://docs.signpath.io/trusted-build-systems/github).

### Microsoft Artifact Signing

Basic costs US$9.99 per account each month and includes 5,000 signatures. Additional signatures cost US$0.005 each. Billing begins when the account is created and is not prorated. Confirm current prices before purchase. See [Microsoft pricing](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku) and [billing terms](https://azure.microsoft.com/en-us/pricing/details/artifact-signing/).

Public Trust individual applicants must be located in the US or Canada. Organization eligibility covers a wider country list. Nathan's actual location and applicant type remain unconfirmed. The Azure hosting region does not determine applicant eligibility.

Individual validation requires an Individual Azure billing account with legal name and address that match government identification. The process uses identity verification and Microsoft Authenticator. The certificate exposes validated legal identity and locality. Obtain approval before submitting any identity information. See [eligibility and identity validation](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart).

The [official GitHub action](https://github.com/Azure/artifact-signing-action) supports Windows runners, OIDC authentication, SHA-256, and RFC 3161 timestamps. Restrict the release identity to the Certificate Profile Signer role. A future Tauri signing hook must run at the correct bundling stages and verify both Jump's executable and the final NSIS installer.

### Decisions and verification still required

Nathan must approve a service, confirm applicant eligibility, and accept either the Foundation publisher and manual approvals or Microsoft's cost and public legal identity. No application, purchase, identity submission, credential setup, or Windows signing occurred in this task.

Test the downloaded executable and installer on Windows after integration. Verify signatures, timestamps, trust chain, packaged license notices, installation, and observed SmartScreen behavior. [Microsoft documents](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation) that new signed binaries can still show warnings. Keep the website and README warnings until the corresponding released installer passes those checks.

## Work

1. Check current SignPath eligibility and approval requirements against Jump's public repository and release process. Present the service choice and any manual release step to Nathan.
2. After the service choice is approved, configure signing for the application executable and final NSIS installer, including timestamping. Keep service credentials private and restrict signing access to the release workflow.
3. Prepare a new release version. Verify the downloaded executable and installer signatures, timestamp, trust chain, and packaged license notices. Test installation on Windows and record any remaining SmartScreen behavior.
4. Update the website and README only after the released artifact is verified. Remove the unsigned claim, but do not promise warning-free installation.

## Boundaries

Prepare a separate PR. This follow-up does not authorize an application to a third-party service, paid resources, identity submissions, release publication, replacement of existing assets, or merging. Ask Nathan for the service decision before those external steps. Leave development and PR checks usable without signing credentials.

## References

- [SignPath Foundation conditions](https://signpath.org/terms)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
- [Tauri Windows signing](https://v2.tauri.app/distribute/sign/windows/)

## Completion

The selected signing service is documented. A newly published Windows build has verified signatures and timestamps. Installation instructions reflect observed Windows behavior.
