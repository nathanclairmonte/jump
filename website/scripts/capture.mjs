import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const mode = process.argv[2] || "launcher";
if (!["launcher", "social"].includes(mode))
  throw new Error("Use launcher or social");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport:
      mode === "launcher"
        ? { width: 664, height: 500 }
        : { width: 1200, height: 630 },
    deviceScaleFactor: mode === "launcher" ? 2 : 1,
    reducedMotion: "reduce",
  });
  const target = (path) => fileURLToPath(new URL(path, import.meta.url));
  if (mode === "launcher") {
    await page.goto(
      process.env.APP_URL || "http://127.0.0.1:1420/launcher.html",
    );
    await page.getByRole("textbox", { name: "Search projects" }).waitFor();
    await page.getByText("portfolio", { exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => {
      for (const button of document.querySelectorAll("button"))
        if (/^(platform|data):/.test(button.textContent)) button.remove();
    });
    const panel = page
      .getByRole("textbox", { name: "Search projects" })
      .locator("xpath=../..");
    await panel.screenshot({
      path: target("../src/assets/launcher.png"),
      omitBackground: true,
    });
  } else {
    const data = async (path) =>
      `data:image/png;base64,${(await readFile(target(path))).toString("base64")}`;
    const html = (await readFile(target("social.html"), "utf8"))
      .replace(
        "{{FONT}}",
        `data:font/woff2;base64,${(await readFile(target("../node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"))).toString("base64")}`,
      )
      .replace("{{ICON}}", await data("../public/images/icon.png"))
      .replace("{{LAUNCHER}}", await data("../src/assets/launcher.png"));
    await page.setContent(html);
    await page.evaluate(() => document.fonts.ready);
    await page
      .locator("img")
      .evaluateAll((images) =>
        Promise.all(images.map((image) => image.decode())),
      );
    await mkdir(target("../public/images/"), { recursive: true });
    await page.screenshot({ path: target("../public/images/social.png") });
  }
  console.log(`Captured ${mode}`);
} finally {
  await browser.close();
}
