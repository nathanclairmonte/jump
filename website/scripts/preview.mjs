import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadResponse } from "../src/lib/download.mjs";

const root = fileURLToPath(new URL("../dist/client/", import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".png": "image/png",
  ".avif": "image/avif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
createServer(async (request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { Allow: "GET, HEAD" }).end();
    return;
  }
  try {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const platform = /^\/download\/(mac|windows)\/?$/.exec(pathname)?.[1];
    if (platform) {
      const redirect = await downloadResponse(
        platform,
        fetch,
        process.env.GITHUB_TOKEN,
      );
      response
        .writeHead(redirect.status, Object.fromEntries(redirect.headers))
        .end();
      return;
    }
    const path = resolve(
      root,
      `.${decodeURIComponent(pathname === "/" ? "/index.html" : pathname)}`,
    );
    if (!path.startsWith(resolve(root) + sep)) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
      "Content-Type": types[extname(path)] ?? "application/octet-stream",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(4322, "127.0.0.1", () =>
  console.log("Built website: http://127.0.0.1:4322"),
);
