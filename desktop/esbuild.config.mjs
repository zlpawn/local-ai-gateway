import esbuild from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const outdir = path.resolve("desktop", "dist");
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const isWatch = process.argv.includes("--watch");

if (isWatch) {
  const ctx = await esbuild.context({
    entryPoints: ["desktop/src/main.ts", "desktop/src/styles/main.css"],
    bundle: true,
    outdir,
    sourcemap: true,
    target: ["chrome100"],
    format: "esm",
    logLevel: "info",
  });
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  // JS bundle
  await esbuild.build({
    entryPoints: ["desktop/src/main.ts"],
    bundle: true,
    outfile: path.join(outdir, "panel.bundle.js"),
    sourcemap: true,
    target: ["chrome100"],
    format: "iife",
    logLevel: "info",
  });
  // CSS bundle
  await esbuild.build({
    entryPoints: ["desktop/src/styles/main.css"],
    bundle: true,
    outfile: path.join(outdir, "panel.css"),
    sourcemap: true,
    target: ["chrome100"],
    loader: { ".css": "css" },
    logLevel: "info",
  });
}
