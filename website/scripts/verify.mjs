import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const origin = process.env.WEBSITE_URL || "http://127.0.0.1:4322";
const output = process.env.SCREENSHOT_DIR || "/tmp/jump-website-review";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const errors = [];
  for (const width of [1440, 1024, 768, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      reducedMotion: "reduce",
    });
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(origin);
    assert.equal(response.status(), 200);
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator(".launcher-stage img")
      .evaluate((image) => image.decode());
    assert.equal(await page.locator("h1").count(), 1);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `horizontal overflow at ${width}px`,
    );
    const brokenImages = await page
      .locator("img")
      .evaluateAll((images) =>
        images
          .filter((image) => !image.complete || !image.naturalWidth)
          .map((image) => image.src),
      );
    assert.deepEqual(brokenImages, []);
    const missingAnchors = await page
      .locator('a[href^="#"]')
      .evaluateAll((links) =>
        links
          .filter((link) => !document.getElementById(link.hash.slice(1)))
          .map((link) => link.hash),
      );
    assert.deepEqual(missingAnchors, []);
    await page.screenshot({ path: `${output}/${width}.png`, fullPage: true });
    await page.screenshot({ path: `${output}/hero-${width}.png` });
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(":focus").innerText(), "Skip to content");
    await page.keyboard.press("Enter");
    assert.equal(new URL(page.url()).hash, "#main");
    const install = page.getByText("macOS installation steps", {
      exact: false,
    });
    await install.click();
    assert.equal(
      await page.locator("#install-mac details").getAttribute("open"),
      "",
    );
    assert.equal(
      await page.locator("pre code").innerText(),
      "xattr -cr /Applications/Jump.app",
    );
    await page
      .locator("summary")
      .filter({ hasText: "Can I change the shortcut?" })
      .click();
    assert.match(
      await page.locator("details[open]").last().innerText(),
      /Ctrl \+ Alt \+ Space/,
    );
    console.log(
      `PASS ${width}px layout, images, anchors, keyboard access, and disclosures`,
    );
    await page.close();
  }
  const page = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  await page.goto(origin);
  await page
    .locator("summary")
    .filter({ hasText: "Which editors can I use?" })
    .click();
  assert.equal(await page.locator(".faq details[open]").count(), 1);
  assert.equal(await page.locator(".hero-actions a").count(), 2);
  await page.close();
  assert.deepEqual(errors, []);
  for (const platform of ["mac", "windows"]) {
    const response = await fetch(`${origin}/download/${platform}`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    const location = response.headers.get("location");
    assert.ok(
      location === "/#availability" ||
        location.startsWith(
          "https://github.com/nathanclairmonte/jump/releases/download/",
        ),
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    console.log(`PASS ${platform} live redirect to ${location}`);
  }
  console.log("PASS no-JavaScript page and no browser errors");
  console.log(`Screenshots: ${output}`);
} finally {
  await browser.close();
}
