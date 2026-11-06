import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm, mkdir, copyFile } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(artifactDir, "dist");
  await rm(distDir, { recursive: true, force: true });

  await copyFonts(distDir);
  await copySupplierGuide(distDir);

  await esbuild({
    entryPoints: [path.resolve(artifactDir, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    external: [
      "*.node",
      // Mastra + the AI SDK are kept OUT of the bundle on purpose. Bundling the
      // full Mastra tree produced a 12 MB output that died at runtime with
      // `Dynamic require of "events" is not supported` (a CJS `ws` dependency
      // reaching for a Node builtin inside an ESM bundle). Left external, the
      // output is ~120 KB and Node resolves them from node_modules at runtime —
      // which is where `pnpm install` has already put them on Render.
      "@mastra/*",
      "@ai-sdk/*",
      "sharp",
      "better-sqlite3",
      "sqlite3",
      "canvas",
      "bcrypt",
      "bcryptjs",
      "argon2",
      "express-session",
      "fsevents",
      "re2",
      "farmhash",
      "xxhash-addon",
      "bufferutil",
      "utf-8-validate",
      "ssh2",
      "cpu-features",
      "dtrace-provider",
      "isolated-vm",
      "lightningcss",
      "pg-native",
      "oracledb",
      "mongodb-client-encryption",
      "nodemailer",
      "handlebars",
      "knex",
      "typeorm",
      "protobufjs",
      "onnxruntime-node",
      "@tensorflow/*",
      "@prisma/client",
      "@mikro-orm/*",
      "@grpc/*",
      "@swc/*",
      "@aws-sdk/*",
      "@azure/*",
      "@opentelemetry/*",
      "@google-cloud/*",
      "@google/*",
      "googleapis",
      "firebase-admin",
      "@parcel/watcher",
      "@sentry/profiling-node",
      "@tree-sitter/*",
      "aws-sdk",
      "classic-level",
      "dd-trace",
      "ffi-napi",
      "grpc",
      "hiredis",
      "kerberos",
      "leveldown",
      "miniflare",
      "mysql2",
      "newrelic",
      "odbc",
      "piscina",
      "realm",
      "ref-napi",
      "rocksdb",
      "sass-embedded",
      "sequelize",
      "serialport",
      "snappy",
      "tinypool",
      "usb",
      "workerd",
      "wrangler",
      "zeromq",
      "zeromq-prebuilt",
      "playwright",
      "puppeteer",
      "puppeteer-core",
      "electron",
      "pdfkit",
    ],
    sourcemap: "linked",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
    },
  });
}

async function copyFonts(distDir) {
  const srcFonts = path.resolve(artifactDir, "src/assets/fonts");
  const destFonts = path.resolve(distDir, "assets/fonts");
  await mkdir(destFonts, { recursive: true });
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(srcFonts).catch(() => []);
  for (const file of files) {
    await copyFile(path.join(srcFonts, file), path.join(destFonts, file));
  }

  // Copy root asset files (logo.png, etc.)
  const srcAssets = path.resolve(artifactDir, "src/assets");
  const destAssets = path.resolve(distDir, "assets");
  await mkdir(destAssets, { recursive: true });
  const assetFiles = await readdir(srcAssets).catch(() => []);
  for (const file of assetFiles) {
    // Only copy files (not sub-directories like fonts/)
    const srcPath = path.join(srcAssets, file);
    const { stat } = await import("node:fs/promises");
    const s = await stat(srcPath).catch(() => null);
    if (s && s.isFile()) {
      await copyFile(srcPath, path.join(destAssets, file));
    }
  }
}

/**
 * Copy the published supplier pricing guide into the bundle.
 *
 * The greeting templates carry it as their DOCUMENT header and the greeting
 * email attaches it, both of which read it at RUNTIME from `assets/`. The
 * single source of truth is the portal's `public/` copy (the same file the
 * portal serves at /supplier-pricing-guide.pdf); copying it here keeps ONE
 * committed copy instead of a second 2.5 MB duplicate that would drift.
 */
async function copySupplierGuide(distDir) {
  const src = path.resolve(artifactDir, "..", "rfq-portal", "public", "supplier-pricing-guide.pdf");
  const destDir = path.resolve(distDir, "assets");
  await mkdir(destDir, { recursive: true });
  try {
    await copyFile(src, path.join(destDir, "supplier-pricing-guide.pdf"));
  } catch (err) {
    // Not fatal: the greeting still sends, without its document header.
    console.warn(
      `supplier pricing guide not copied (${err.code || err.message}) — the greeting will send without the attachment`,
    );
  }
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
