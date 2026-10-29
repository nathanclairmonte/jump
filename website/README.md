# Jump website

A static Astro landing page with two on-demand download routes for Vercel. The website owns its npm dependencies and does not import the desktop app.

## Develop

Use Node 22.12 or later. From the repository root:

```sh
npm ci --prefix website
task dev-web
```

Open http://localhost:4321. Astro updates the page as you edit it.

If Astro reports an existing server URL and PID, use that server. To stop it before restarting, run this command from `website/`:

```sh
npm run dev -- stop
```

Then run `task dev-web` from the repository root. Do not use `--force` to replace an existing server without checking its URL and PID.

## Check the production build

From the repository root:

```sh
task check-web
task preview-web
```

The preview runs at http://127.0.0.1:4322. It serves `dist/client` and runs the same download resolver as the production routes. It is a local review server.

For browser verification, use an existing Playwright installation. Set `PLAYWRIGHT_MODULE` to its absolute module path if it is outside this package. Alternatively, install it locally with `npm install --no-save --package-lock=false --prefix website playwright` and run `npx --prefix website playwright install chromium`. Playwright is optional and is not part of the production dependency tree.

```sh
npm run verify-ui --prefix website
```

The script checks five viewport widths, keyboard access, native disclosures, images, internal anchors, no-JavaScript behavior, and live download redirects. It saves screenshots under `/tmp/jump-website-review`. Override the target with `WEBSITE_URL` and output with `SCREENSHOT_DIR`.

## Downloads

The platform buttons use `/download/mac` and `/download/windows` directly. Both routes read releases from [nathanclairmonte/jump](https://github.com/nathanclairmonte/jump/releases/latest), the same repository that contains the MIT-licensed source. There is no separate release mirror or download feature flag.

Until the repository and its installers are public, requests return visitors to the on-site availability notice. Credentials cannot make a private installer downloadable.

`/download/mac` and `/download/windows` resolve the latest stable public release independently. Each accepts exactly one uploaded, nonempty asset with the expected name and exact release URL:

- `Jump_<version>_aarch64.dmg` for Apple Silicon macOS.
- `Jump_<version>_x64-setup.exe` for Windows x64.

The resolver accepts only exact asset URLs under `https://github.com/nathanclairmonte/jump/releases/download/`. It makes an anonymous HEAD request to the asset before each asset redirect. Missing or ambiguous assets, drafts, prereleases, failed anonymous checks, network failures, and API limits return visitors to `/#availability`. Every request has a five-second timeout. A partial release serves only its available platform.

Set the `GITHUB_TOKEN` server secret in production to avoid GitHub API limits on shared Vercel addresses. It is optional for local review. Use a token with public-repository read access only. The token is sent only to the release metadata API. Authentication, access, or rate-limit failures retry anonymously. Asset checks never receive it.

Browsers receive `Cache-Control: no-store`. Successful redirects also receive a five-minute Vercel CDN cache. Availability fallbacks are never cached. New releases need no website rebuild.

## Publish a release

1. Bump the app version with `task bump` and merge the reviewed change into `main`.
2. Wait for the release workflow to build both native installers. Inspect the macOS and Windows packages for the five files listed in `THIRD_PARTY_NOTICES.md`.
3. Verify anonymous access to the latest release metadata and both installers.
4. Check both download routes.

## Configure Vercel

Create a Vercel project with `website/` as its root directory. Astro supplies the build settings. Set `SITE_URL` to the production origin if it differs from the proposed `https://jump.n4than.com`. That origin supplies canonical and social-image URLs. The domain is a configuration default, not a registered domain or completed deployment.

The Vercel ignore command skips builds when a push does not change `website/`. It builds when commit comparison is unavailable.

No analytics scripts are included. Add Jump's own analytics configuration when a service and account are chosen. Do not reuse Jot's analytics identifier.

## Refresh the images

Start the desktop browser demo with `bun dev`, then run:

```sh
npm run capture --prefix website -- launcher
npm run capture --prefix website -- social
```

Use the same optional Playwright setup as browser verification. The launcher capture uses the app's real UI with its seeded demo data. The demo source uses neutral project names and paths. The script hides development controls and captures the panel at twice its display resolution. It does not change app source or user data. `APP_URL` overrides the default launcher URL.

`src/assets/launcher.png` is the captured panel. Astro creates responsive AVIF and WebP images. `scripts/social.html` is the reproducible source for `public/images/social.png`. `public/images/icon.png` comes from the app's existing icon. The site uses local Geist and Geist Mono font files.

## Dependency overrides

The `path-to-regexp` override retains Jot's compatible patched routing dependency. The scoped `@vercel/cli-config` Zod override replaces its pinned vulnerable version with a compatible patched 4.x release. Review both overrides when updating the Vercel adapter.
