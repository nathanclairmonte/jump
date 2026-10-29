export const RELEASE_PAGE =
  "https://github.com/nathanclairmonte/jump/releases/latest";
const RELEASE_API =
  "https://api.github.com/repos/nathanclairmonte/jump/releases/latest";
const ASSET_PREFIX =
  "https://github.com/nathanclairmonte/jump/releases/download/";
export const UNAVAILABLE_PAGE = "/#availability";

export const PLATFORMS = {
  mac: {
    label: "macOS",
    requirement: "Apple Silicon · macOS 13+",
    href: "/download/mac",
    asset: /^Jump_[0-9][\w.-]*_aarch64\.dmg$/,
  },
  windows: {
    label: "Windows",
    requirement: "x64 · WSL2 supported",
    href: "/download/windows",
    asset: /^Jump_[0-9][\w.-]*_x64-setup\.exe$/,
  },
};

export async function resolveDownload(platform, fetcher = fetch, token) {
  try {
    const request = (authorization) =>
      fetcher(RELEASE_API, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "jump-website",
          ...authorization,
        },
        signal: AbortSignal.timeout(5000),
      });
    let response = await request(
      token ? { Authorization: `Bearer ${token}` } : {},
    );
    if (token && [401, 403, 404, 429].includes(response.status))
      response = await request({});
    if (!response.ok) return UNAVAILABLE_PAGE;
    const release = await response.json();
    if (
      release.draft !== false ||
      release.prerelease !== false ||
      typeof release.tag_name !== "string" ||
      !Array.isArray(release.assets)
    )
      return UNAVAILABLE_PAGE;
    const assets = release.assets.filter(
      (asset) =>
        asset !== null &&
        typeof asset === "object" &&
        typeof asset.name === "string" &&
        PLATFORMS[platform].asset.test(asset.name) &&
        asset.state === "uploaded" &&
        Number.isFinite(asset.size) &&
        asset.size > 0 &&
        asset.browser_download_url ===
          `${ASSET_PREFIX}${encodeURIComponent(release.tag_name)}/${encodeURIComponent(asset.name)}`,
    );
    if (assets.length !== 1) return UNAVAILABLE_PAGE;
    const location = assets[0].browser_download_url;
    const publicResponse = await fetcher(location, {
      method: "HEAD",
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
    return publicResponse.ok ? location : UNAVAILABLE_PAGE;
  } catch {
    return UNAVAILABLE_PAGE;
  }
}

export async function downloadResponse(platform, fetcher = fetch, token) {
  const location = await resolveDownload(platform, fetcher, token);
  const headers = { Location: location, "Cache-Control": "no-store" };
  if (location !== UNAVAILABLE_PAGE)
    headers["Vercel-CDN-Cache-Control"] = "max-age=300";
  return new Response(null, { status: 302, headers });
}
