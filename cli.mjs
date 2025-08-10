#!/usr/bin/env node
// wp-landing-slimmer (npx-ready CLI)
// Usage examples:
//   npx github:<you>/<repo> -- --in ./index.html --base https://example.com --out slim.html
//   npx github:<you>/<repo> -- --url https://example.com/landing --out slim.html
// Flags:
//   --in <file>         Local HTML file (View Source)
//   --url <url>         Live URL (will fetch HTML + linked CSS)
//   --base <origin>     Base origin to resolve relative URLs (defaults to URL origin)
//   --out <file>        Output HTML (default: slim.html)
//   --no-visual         Skip visual regression (faster, no Puppeteer)
//   --viewports "1440x900,1024x768,768x1024,390x844"
//   --keep-font-links   Keep <link href=fonts.googleapis.com> instead of inlining (default: keep if no local font files)
//   --safelist "cls1,cls2,prefix-"  Add extra classes/prefixes to keep
//   --verbose

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import fetch from "node-fetch";
import { PurgeCSS } from "purgecss";
import postcss from "postcss";
import cssnano from "cssnano";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.replace(/^--/, "");
    const v = (argv[i + 1] && !argv[i + 1].startsWith("--")) ? argv[++i] : true;
    args[key] = v;
  }
  return args;
}
const args = parseArgs(process.argv);

const inputPath = args.in || null;
const pageUrl   = args.url || null;
const outPath   = args.out || "slim.html";
const doVisual  = !args["no-visual"];
const keepFontLinks = !!args["keep-font-links"];
const vpsArg    = args.viewports || "1440x900,1024x768,768x1024,390x844";
const safelistExtra = (args.safelist || "").split(",").map(s=>s.trim()).filter(Boolean);
const verbose   = !!args.verbose;

if (!inputPath && !pageUrl) {
  console.error("Provide --in <index.html> OR --url <https://...>");
  process.exit(1);
}

const baseUrl = args.base || (pageUrl ? new URL(pageUrl).origin : "https://example.com");

function log(...msg){ if (verbose) console.log(...msg); }

function absUrl(u, base) {
  if (!u) return null;
  if (/^data:/.test(u)) return null;
  if (/^https?:\/\//i.test(u)) return u;
  if (/^\/\//.test(u)) return new URL(base).protocol + u;
  if (u.startsWith("/")) return new URL(u, base).href;
  return new URL(u, base).href;
}

async function loadHtmlAndCss() {
  let html;
  if (pageUrl) {
    log("Fetching page:", pageUrl);
    const res = await fetch(pageUrl, { headers: { "user-agent":"Mozilla/5.0" }});
    html = await res.text();
  } else {
    html = await fs.readFile(inputPath, "utf8");
  }
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // Gather CSS: linked (order preserved) + inline <style>
  const linked = [...doc.querySelectorAll('link[rel~="stylesheet"]')];
  const inlines = [...doc.querySelectorAll("style")];

  const cssParts = [];

  for (const link of linked) {
    const href = link.getAttribute("href") || "";
    const media = (link.getAttribute("media") || "").trim();
    const url = absUrl(href, baseUrl);
    if (!url) continue;

    let css = "";
    if (!/^https?:/i.test(url) && inputPath) {
      // local relative
      const diskPath = path.resolve(path.dirname(inputPath), href.split("?")[0]);
      log("Reading local CSS:", diskPath);
      try { css = await fs.readFile(diskPath, "utf8"); } catch { css = ""; }
    } else {
      log("Fetching CSS:", url);
      const res = await fetch(url, { headers:{ "user-agent":"Mozilla/5.0" }});
      css = await res.text();
    }
    if (!css) continue;
    if (media && media.toLowerCase() !== "all") {
      cssParts.push(`@media ${media}{\n${css}\n}`);
    } else {
      cssParts.push(css);
    }
  }
  // Inline styles after linked CSS
  for (const st of inlines) cssParts.push(st.textContent || "");

  return { html, css: cssParts.join("\n\n") };
}

function uniques(arr){ return [...new Set(arr)].filter(Boolean); }

// Framework safelist to protect Elementor/Woo/CartFlows & friends
const SAFE_PREFIXES = [
  "elementor","e-","woocommerce","cartflows","wcf","ast-","wp-",
  "swiper","select2","dashicons","uagb","cfp-","wpcf7"
];

function buildSafelist(extra) {
  const standard = [...SAFE_PREFIXES, ...extra.filter(s => !s.endsWith("-"))];
  const prefixes = [
    ...SAFE_PREFIXES,
    ...extra.filter(s => s.endsWith("-")).map(s => s.replace(/-$/,""))
  ];
  const patterns = prefixes.map(p => new RegExp(`^${p}`));
  return { standard, deep: patterns, greedy: patterns };
}

async function purgeCss(html, css, extraSafe=[]) {
  const purge = new PurgeCSS();
  const safelist = buildSafelist(extraSafe);
  const res = await purge.purge({
    content: [{ raw: html, extension: "html" }],
    css: [{ raw: css }],
    safelist,
    defaultExtractor: (content) => {
      const classes = Array.from(content.matchAll(/class=["']([^"']+)["']/g)).flatMap(m=>m[1].split(/\s+/));
      const ids     = Array.from(content.matchAll(/id=["']([^"']+)["']/g)).map(m=>m[1]);
      const tags    = Array.from(content.matchAll(/<\/?([a-z0-9-]+)/gi)).map(m=>m[1]);
      const data    = Array.from(content.matchAll(/\sdata-[a-z0-9-]+(?:=["'][^"']*["'])?/gi)).map(m=>m[0].trim());
      return uniques([...classes, ...ids, ...tags, ...data]);
    },
  });
  return res[0]?.css || css;
}

async function minifyCss(css) {
  const out = await postcss([cssnano({ preset:"default" })]).process(css, { from: undefined });
  return out.css;
}

async function serializeWithStyle(originalHtml, finalCss) {
  const dom = new JSDOM(originalHtml);
  const doc = dom.window.document;

  // Optionally keep Google Fonts <link> (if any) unless you prefer to inline via @font-face with files
  if (!keepFontLinks) {
    doc.querySelectorAll('link[rel~="stylesheet"][href*="fonts.googleapis"]').forEach(el => el.remove());
  }

  // Remove other stylesheet links; remove scripts and perf hints
  doc.querySelectorAll('link[rel~="stylesheet"]:not([href*="fonts.googleapis"])').forEach(el=>el.remove());
  doc.querySelectorAll('script, link[rel="preload"], link[rel="prefetch"], link[rel="dns-prefetch"]').forEach(el=>el.remove());

  // Ensure head/meta
  if (!doc.querySelector('meta[charset]')) {
    const meta = doc.createElement("meta"); meta.setAttribute("charset","utf-8");
    doc.head.prepend(meta);
  }
  if (!doc.querySelector('meta[name="viewport"]')) {
    const meta = doc.createElement("meta"); meta.setAttribute("name","viewport"); meta.setAttribute("content","width=device-width, initial-scale=1");
    doc.head.append(meta);
  }

  // Append one <style>
  const style = doc.createElement("style");
  style.textContent = finalCss;
  doc.head.append(style);

  return "<!DOCTYPE html>\n" + dom.serialize();
}

async function visualGuard(originalHtml, slimHtml, viewportsCsv) {
  let puppeteer, pixelmatch, PNG;
  try {
    ({ default: puppeteer } = await import("puppeteer"));
    pixelmatch = (await import("pixelmatch")).default;
    ({ PNG } = await import("pngjs"));
  } catch (e) {
    console.warn("Visual guard requested but optional deps not installed. Install puppeteer, pixelmatch, pngjs or use --no-visual.");
    return true;
  }

  const browser = await puppeteer.launch({ headless: "new", defaultViewport: null });
  const page = await browser.newPage();
  const tmp1 = path.resolve(".orig__tmp.html");
  const tmp2 = path.resolve(".slim__tmp.html");
  await fs.writeFile(tmp1, originalHtml, "utf8");
  await fs.writeFile(tmp2, slimHtml, "utf8");

  const vps = viewportsCsv.split(",").map(s=>s.trim()).filter(Boolean);
  let worst = 0;

  async function snap(vp, file) {
    const [w,h] = vp.split("x").map(Number);
    await page.setViewport({ width:w, height:h, deviceScaleFactor:1 });
    await page.goto("file:///" + file.replace(/\\/g,"/"), { waitUntil:"networkidle2" });
    const pngPath = file.replace(/\.html$/,"") + "." + vp + ".png";
    await page.screenshot({ path: pngPath, fullPage:true });
    return pngPath;
  }

  for (const vp of vps) {
    const o = await snap(vp, tmp1);
    const s = await snap(vp, tmp2);

    const origPng = PNG.sync.read(await fs.readFile(o));
    const slimPng = PNG.sync.read(await fs.readFile(s));
    const { width, height } = origPng;
    const diff = new PNG({ width, height });
    const n = pixelmatch(origPng.data, slimPng.data, diff.data, width, height, { threshold: 0.1 });
    worst = Math.max(worst, n);
    await fs.writeFile(`diff.${vp}.png`, PNG.sync.write(diff));
    log(`Viewport ${vp} pixel diff: ${n}`);
  }

  await browser.close();
  // <= 500 changed pixels across the full page per viewport is “close enough”
  return worst <= 500;
}

(async () => {
  try {
    // 1) Load page HTML + aggregate CSS (linked order + inline)
    const { html, css } = await loadHtmlAndCss();

    // 2) Purge & minify
    const purged = await purgeCss(html, css, safelistExtra);
    const minimized = await minifyCss(purged);

    // 3) Build slim HTML string for visual check
    const slimHtmlString = await serializeWithStyle(html, minimized);

    // 4) Optional visual guard
    if (doVisual) {
      const ok = await visualGuard(html, slimHtmlString, vpsArg);
      if (!ok) {
        console.error("❌ Visual diff too large. Re-run with --safelist to keep more selectors, or use --no-visual if you accept diffs.");
        process.exit(2);
      }
    }

    // 5) Write final output
    await fs.writeFile(outPath, slimHtmlString, "utf8");
    console.log(`✔ Wrote ${outPath}`);
  } catch (e) {
    console.error("Failed:", e.message);
    if (verbose) console.error(e);
    process.exit(1);
  }
})();
