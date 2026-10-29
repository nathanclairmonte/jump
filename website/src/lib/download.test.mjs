import assert from "node:assert/strict";
import { test } from "node:test";
import {
  downloadResponse,
  resolveDownload,
  UNAVAILABLE_PAGE,
} from "./download.mjs";
const prefix =
  "https://github.com/nathanclairmonte/jump/releases/download/v0.1.2/";
const asset = (name) => ({
  name,
  state: "uploaded",
  size: 1024,
  browser_download_url: prefix + name,
});
const mac = asset("Jump_0.1.2_aarch64.dmg");
const windows = asset("Jump_0.1.2_x64-setup.exe");
const release = (assets = [mac, windows]) => ({
  draft: false,
  prerelease: false,
  tag_name: "v0.1.2",
  assets,
});
const fetcher =
  (data, publicStatus = 200) =>
  async (_url, options) =>
    options.method === "HEAD"
      ? new Response(null, { status: publicStatus })
      : Response.json(data);

for (const [platform, expected] of [
  ["mac", mac],
  ["windows", windows],
]) {
  test(`redirects ${platform} to its verified public installer`, async () => {
    const response = await downloadResponse(platform, fetcher(release()));
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("Location"),
      expected.browser_download_url,
    );
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(
      response.headers.get("Vercel-CDN-Cache-Control"),
      "max-age=300",
    );
  });
}
test("a partial release cannot download the wrong platform", async () => {
  assert.equal(
    await resolveDownload("mac", fetcher(release([windows]))),
    UNAVAILABLE_PAGE,
  );
  assert.equal(
    await resolveDownload("windows", fetcher(release([windows]))),
    windows.browser_download_url,
  );
});
for (const [name, data] of Object.entries({
  draft: { ...release(), draft: true },
  prerelease: { ...release(), prerelease: true },
  missingAssets: {},
  duplicate: release([mac, mac]),
  nullAsset: release([null]),
  wrongHost: release([
    { ...mac, browser_download_url: "https://example.com/" + mac.name },
  ]),
  releaseMirror: release([
    {
      ...mac,
      browser_download_url: mac.browser_download_url.replace(
        "jump",
        "jump-releases",
      ),
    },
  ]),
  unrelatedRepository: release([
    {
      ...mac,
      browser_download_url: mac.browser_download_url.replace(
        "/jump/",
        "/other/",
      ),
    },
  ]),
  unrelatedOwner: release([
    {
      ...mac,
      browser_download_url: mac.browser_download_url.replace(
        "/nathanclairmonte/",
        "/other/",
      ),
    },
  ]),
  assetQuery: release([
    {
      ...mac,
      browser_download_url: mac.browser_download_url + "?token=secret",
    },
  ]),
  assetFragment: release([
    { ...mac, browser_download_url: mac.browser_download_url + "#installer" },
  ]),
  wrongTag: { ...release(), tag_name: "v0.1.3" },
  empty: release([{ ...mac, size: 0 }]),
  notUploaded: release([{ ...mac, state: "new" }]),
  malformedName: release([asset("Jump_universal.dmg")]),
}))
  test(`falls back for ${name}`, async () => {
    assert.equal(await resolveDownload("mac", fetcher(data)), UNAVAILABLE_PAGE);
  });
for (const status of [403, 404, 429, 500])
  test(`falls back for API status ${status} without caching`, async () => {
    const response = await downloadResponse(
      "mac",
      async () => new Response(null, { status }),
    );
    assert.equal(response.headers.get("Location"), UNAVAILABLE_PAGE);
    assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), null);
  });
for (const status of [401, 403, 404, 429, 500])
  test(`authenticated metadata cannot expose an asset with anonymous status ${status}`, async () => {
    const calls = [];
    const response = await downloadResponse(
      "mac",
      async (url, options) => {
        calls.push({ url, options });
        return options.method === "HEAD"
          ? new Response(null, { status })
          : Response.json(release());
      },
      "private-read-token",
    );
    assert.equal(response.headers.get("Location"), UNAVAILABLE_PAGE);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), null);
    assert.equal(await response.text(), "");
    assert.ok(
      !JSON.stringify([...response.headers]).includes("private-read-token"),
    );
    assert.equal(
      calls[0].url,
      "https://api.github.com/repos/nathanclairmonte/jump/releases/latest",
    );
    assert.equal(
      calls[0].options.headers.Authorization,
      "Bearer private-read-token",
    );
    assert.equal(calls[1].url, mac.browser_download_url);
    assert.equal(calls[1].options.method, "HEAD");
    assert.equal(calls[1].options.headers, undefined);
    assert.equal(calls[1].options.redirect, "follow");
    assert.ok(calls[1].options.signal instanceof AbortSignal);
  });
test("checks anonymous availability again before each asset redirect", async () => {
  let checks = 0;
  const request = async (_url, options) => {
    if (options.method !== "HEAD") return Response.json(release());
    assert.equal(options.headers, undefined);
    checks += 1;
    return new Response(null, { status: checks === 1 ? 200 : 404 });
  };
  assert.equal(
    await resolveDownload("mac", request, "token"),
    mac.browser_download_url,
  );
  assert.equal(
    await resolveDownload("mac", request, "token"),
    UNAVAILABLE_PAGE,
  );
  assert.equal(checks, 2);
});
test("falls back when the anonymous asset check fails after authenticated metadata", async () => {
  const response = await downloadResponse(
    "mac",
    async (_url, options) => {
      if (options.method === "HEAD") throw new Error("timeout");
      return Response.json(release());
    },
    "token",
  );
  assert.equal(response.headers.get("Location"), UNAVAILABLE_PAGE);
  assert.equal(response.headers.get("Vercel-CDN-Cache-Control"), null);
});
for (const rejectedStatus of [401, 403, 404, 429])
  test(`retries metadata status ${rejectedStatus} without exposing the token`, async () => {
    const calls = [];
    const result = await resolveDownload(
      "mac",
      async (url, options) => {
        calls.push({ url, options });
        if (calls.length === 1)
          return new Response(null, { status: rejectedStatus });
        return options.method === "HEAD"
          ? new Response(null)
          : Response.json(release());
      },
      "test-token",
    );
    assert.equal(result, mac.browser_download_url);
    assert.equal(calls[0].options.headers.Authorization, "Bearer test-token");
    assert.equal(calls[1].options.headers.Authorization, undefined);
    assert.equal(calls[2].options.headers, undefined);
    assert.ok(
      calls.every((call) => call.options.signal instanceof AbortSignal),
    );
  });
test("network failures and invalid JSON fall back", async () => {
  assert.equal(
    await resolveDownload("mac", async () => {
      throw new Error("timeout");
    }),
    UNAVAILABLE_PAGE,
  );
  assert.equal(
    await resolveDownload("mac", async () => new Response("invalid json")),
    UNAVAILABLE_PAGE,
  );
});
