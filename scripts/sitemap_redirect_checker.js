/**
 * sitemap_redirect_checker.js
 * Parse a sitemap XML, detect HTTP redirects, and export a CSV report.
 *
 * Usage: node sitemap_redirect_checker.js <file-path-or-URL> [output.csv]
 *
 * Dependencies: axios, fast-xml-parser
 *   npm install
 */

import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import { XMLParser } from "fast-xml-parser";
import axios from "axios";

const DEFAULT_OUTPUT = "myrepo\\AI-GEN-SDLCDemo\\web\\pages\\redirect_report.csv";
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

async function checkRedirect(url, timeout = 15_000) {
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
    const res = await axios.get(url, {
      maxRedirects: 10,
      timeout,
      validateStatus: () => true,
      headers: { "User-Agent": "SitemapRedirectChecker/1.0" },
    });

    // Capture the final resolved URL after all redirects
    const finalUrl =
      res.request?.res?.responseUrl ||
      res.request?.responseURL ||
      url;

    result.final_url = finalUrl;
    result.status_code = res.status;

    // If the final URL differs from the original, a redirect occurred
    if (normalizeUrl(finalUrl) !== normalizeUrl(url)) {
      result.is_redirect = true;

      // Re-issue a HEAD with maxRedirects=0 to capture the first-hop status code
      try {
        const headRes = await axios.head(url, {
          maxRedirects: 0,
          timeout,
          validateStatus: () => true,
          headers: { "User-Agent": "SitemapRedirectChecker/1.0" },
        });
        result.status_code = headRes.status;
        result.redirect_type = String(headRes.status);
      } catch (headErr) {
        if (headErr.response) {
          result.status_code = headErr.response.status;
          result.redirect_type = String(headErr.response.status);
        }
      }
    }
  } catch (err) {
    if (err.code === "ECONNABORTED") {
      result.error = "Timeout";
    } else if (err.code) {
      result.error = `${err.code}: ${err.message}`;
    } else {
      result.error = err.message;
    }
  }

  return result;
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
  const stream = createWriteStream(outputPath, { encoding: "utf8" });
  stream.write(CSV_HEADERS.join(",") + "\n");

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

// ─── 4. Main ─────────────────────────────────────────────────────────────────

async function main() {
  const [, , sitemapSource, outputCsv = DEFAULT_OUTPUT] = process.argv;

  if (!sitemapSource) {
    console.error(
      "Usage: node sitemap_redirect_checker.js <file-or-URL> [output.csv]"
    );
    process.exit(1);
  }

  console.log(`Parsing sitemap: ${sitemapSource}`);
  const urls = await parseSitemap(sitemapSource);
  console.log(`Found ${urls.length} unique URLs.\n`);

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

  // Print summary
  const redirects = results.filter((r) => r.is_redirect);
  const errors = results.filter((r) => r.error);
  const by301 = redirects.filter((r) => r.redirect_type === "301").length;
  const by302 = redirects.filter((r) => r.redirect_type === "302").length;

  console.log("\n── Summary ──────────────────────────────────────");
  console.log(`Total URLs checked : ${results.length}`);
  console.log(`Redirects          : ${redirects.length} (301: ${by301}, 302: ${by302})`);
  console.log(`Errors             : ${errors.length}`);
  console.log("─────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
