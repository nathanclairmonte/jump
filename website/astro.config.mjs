import { defineConfig, envField } from "astro/config";
import vercel from "@astrojs/vercel";

export default defineConfig({
  site: process.env.SITE_URL || "https://jump.n4than.com",
  adapter: vercel(),
  devToolbar: { enabled: false },
  env: {
    schema: {
      GITHUB_TOKEN: envField.string({
        context: "server",
        access: "secret",
        optional: true,
      }),
    },
  },
});
