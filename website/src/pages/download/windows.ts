import { GITHUB_TOKEN } from "astro:env/server";
import { downloadResponse } from "../../lib/download.mjs";
export const prerender = false;
export const GET = () => downloadResponse("windows", fetch, GITHUB_TOKEN);
export const HEAD = GET;
