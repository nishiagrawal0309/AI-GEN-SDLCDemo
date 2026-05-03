/**
 * sitemap_redirect_checker.js
 * Parse a sitemap XML, resolve redirects, export a CSV report, and create
 * a resolved sitemap with 404-ending URLs excluded.
 *
 * Usage:
 *   node sitemap_redirect_checker.js <file-path-or-URL> [output.csv] [resolved-sitemap.xml] [--max-urls=N]
 *
 * Dependencies: axios, fast-xml-parser
 *   npm install
 */
import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import { XMLParser } from "fast-xml-parser";
import axios from "axios";

const DEFAULT_OUTPUT = "web/pages/redirect_report.csv";
const CSV_HEADERS = [
  "original_url",
  "final_url",
  "status_code",
  "is_redirect",
  "redirect_type",
  "redirect_chain",
  "error",
  "checked_at",
];
const MAX_REDIRECT_HOPS = 10;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "SitemapRedirectChecker/1.1";

// ─── 1. Sitemap Parser ────────────────────────────────────────────────────────

async function parseSitemap(source) {
  let xmlText;
  if (/^https?:\/\//i.test(source)) {
    const res = await axios.get(source, { timeout: 30_000, responseType: "text" });
    xmlText = res.data;
  } else {
    xmlText = fs.readFileSync(source, "utf8");
  }

  const parser = new XMLParser({ ignoreAttributes: false });
  const doc = parser.parse(xmlText);

  // Sitemap index: contains <sitemapindex> with nested <sitemap><loc>
  if (doc.sitemapindex) {
    const sitemaps = toArray(doc.sitemapindex.sitemap);
    const nested = await Promise.all(sitemaps.map((s) => parseSitemap(s.loc)));
    return [...new Set(nested.flat())];
  }

  // Standard sitemap: contains <urlset> with <url><loc>
  const urlset = doc.urlset || {};
  const urls = toArray(urlset.url || []).map((u) => u.loc).filter(Boolean);
  return [...new Set(urls)];
}

function toArray(val) {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

// ─── 2. Redirect Checker ─────────────────────────────────────────────────────

async function checkRedirect(url, timeout = REQUEST_TIMEOUT_MS) {
  const result = {
    original_url: url,
    final_url: url,
    status_code: null,
    is_redirect: false,
    redirect_type: "",
    redirect_chain: [],
    error: "",
    checked_at: new Date().toISOString(),
  };

  try {
    const final = await followRedirectChain(url, timeout);
    result.final_url = final.finalUrl;
    result.status_code = final.status;
    result.redirect_chain = final.chain;
    result.is_redirect = final.chain.length > 0;
    result.redirect_type = final.chain.length > 0 ? extractRedirectType(final.chain[0]) : "";
  } catch (err) {
    result.error = formatError(err);
  }

  return result;
}

async function followRedirectChain(inputUrl, timeout) {
  let currentUrl = inputUrl;
  const chain = [];

  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const response = await axios.get(currentUrl, {
      maxRedirects: 0,
      timeout,
      validateStatus: () => true,
      headers: { "User-Agent": USER_AGENT },
    });

    const status = response.status;
    const locationHeader = response.headers?.location;

    if (status >= 300 && status < 400 && locationHeader) {
      const nextUrl = resolveLocation(currentUrl, locationHeader);
      chain.push(`${status}:${nextUrl}`);
      currentUrl = nextUrl;
      continue;
    }

    return {
      finalUrl: currentUrl,
      status,
      chain,
    };
  }

  const overflowError = new Error(`Exceeded max redirect hops (${MAX_REDIRECT_HOPS})`);
  overflowError.code = "REDIRECT_LOOP";
  throw overflowError;
}

function resolveLocation(fromUrl, locationHeader) {
  try {
    return new URL(locationHeader, fromUrl).toString();
  } catch {
    return locationHeader;
  }
}

function extractRedirectType(chainEntry) {
  const match = String(chainEntry ?? "").match(/^(\d{3}):/);
  return match ? match[1] : "";
}

function formatError(err) {
  if (err?.code === "ECONNABORTED") return "Timeout";
  if (err?.response?.status) return `HTTP_${err.response.status}`;
  if (err?.code && err?.message) return `${err.code}: ${err.message}`;
  if (err?.message) return err.message;
  return "Unknown error";
}

function normalizeUrl(u) {
  try {
    const p = new URL(u);
    return `${p.origin}${p.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

// ─── 3. CSV Export ───────────────────────────────────────────────────────────

function escapeCSV(val) {
  const s = String(val ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function saveCSV(results, outputPath = DEFAULT_OUTPUT) {
  ensureParentDirectory(outputPath);
  const stream = createWriteStream(outputPath, { encoding: "utf8" });
  const quotedHeaders = CSV_HEADERS.map((h) => `"${h}"`).join(",");
  stream.write(quotedHeaders + "\n");

  for (const row of results) {
    const line = CSV_HEADERS.map((h) => {
      const v = h === "redirect_chain" ? row[h].join(" | ") : row[h];
      return escapeCSV(v);
    }).join(",");
    stream.write(line + "\n");
  }

  await new Promise((resolve, reject) => {
    stream.end();
    stream.on("finish", resolve);
    stream.on("error", reject);
  });

  console.log(`\nReport saved → ${path.resolve(outputPath)}`);
}

function saveResolvedSitemap(urls, outputPath) {
  ensureParentDirectory(outputPath);
  const uniqueUrls = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...uniqueUrls.map((url) => `  <url><loc>${escapeXml(url)}</loc></url>`),
    "</urlset>",
    "",
  ];
  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
  console.log(`Resolved sitemap saved → ${path.resolve(outputPath)}`);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function ensureParentDirectory(filePath) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
}

function is404Result(result) {
  const has404Status = Number(result.status_code) === 404;
  const endsWith404Path = /\/404\/?$/i.test(result.final_url || "");
  return has404Status || endsWith404Path;
}

function parseCliArgs(argv) {
  const positional = [];
  const flags = {
    maxUrls: null,
  };

  for (const arg of argv) {
    if (arg.startsWith("--max-urls=")) {
      const raw = arg.split("=")[1];
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed > 0) flags.maxUrls = parsed;
      continue;
    }
    positional.push(arg);
  }

  const sitemapSource = positional[0];
  const outputCsv = positional[1] || DEFAULT_OUTPUT;
  const outputSitemap = positional[2] || outputCsv.replace(/\.csv$/i, "_resolved.xml");

  return {
    sitemapSource,
    outputCsv,
    outputSitemap,
    maxUrls: flags.maxUrls,
  };
}

// ─── 4. Main ─────────────────────────────────────────────────────────────────

async function main() {
  const { sitemapSource, outputCsv, outputSitemap, maxUrls } = parseCliArgs(
    process.argv.slice(2)
  );

  if (!sitemapSource) {
    console.error(
      "Usage: node sitemap_redirect_checker.js <file-or-URL> [output.csv] [resolved-sitemap.xml] [--max-urls=N]"
    );
    process.exit(1);
  }

  console.log(`Parsing sitemap: ${sitemapSource}`);
  let urls = await parseSitemap(sitemapSource);
  if (maxUrls) {
    urls = urls.slice(0, maxUrls);
  }
  console.log(`Found ${urls.length} unique URLs to check.\n`);

  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    process.stdout.write(`[${i + 1}/${urls.length}] ${url} … `);
    const result = await checkRedirect(url);
    console.log(
      result.error
        ? `ERROR: ${result.error}`
        : result.is_redirect
        ? `→ ${result.redirect_type} → ${result.final_url}`
        : `OK (${result.status_code})`
    );
    results.push(result);
  }

  await saveCSV(results, outputCsv);

  const filteredUrls = results
    .filter((r) => !r.error)
    .filter((r) => !is404Result(r))
    .map((r) => r.final_url);
  saveResolvedSitemap(filteredUrls, outputSitemap);

  // Print summary
  const redirects = results.filter((r) => r.is_redirect);
  const errors = results.filter((r) => r.error);
  const excluded404 = results.filter((r) => is404Result(r)).length;
  const by301 = redirects.filter((r) => r.redirect_type === "301").length;
  const by302 = redirects.filter((r) => r.redirect_type === "302").length;

  console.log("\n── Summary ──────────────────────────────────────");
  console.log(`Total URLs checked : ${results.length}`);
  console.log(`Redirects          : ${redirects.length} (301: ${by301}, 302: ${by302})`);
  console.log(`Excluded 404 URLs  : ${excluded404}`);
  console.log(`Final sitemap URLs : ${filteredUrls.length}`);
  console.log(`Errors             : ${errors.length}`);
  console.log("─────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
