// Turns an uploaded file or a web address into plain text for the importer.
import dns from "dns/promises";
import net from "net";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { extractPdfText } from "./pdfText";

const run = promisify(execFile);
const OCR_LANGS = process.env.OCR_LANGS || "eng+heb";

const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";
const isImage = (b: Buffer) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 4).toString("latin1") === "RIFF" || b.subarray(0, 3).toString("latin1") === "GIF";

/** OCR for a screenshot or photo (e.g. a booking confirmation screenshot). */
export async function extractImageText(buf: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "img-"));
  try {
    const f = path.join(dir, "in");
    await fs.writeFile(f, buf);
    const { stdout } = await run("tesseract", [f, "-", "-l", OCR_LANGS, "--psm", "3"], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    const text = stdout.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
    if (!text) throw new Error("No readable text was found in that image.");
    return text;
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error("OCR is not installed on the server (tesseract).");
    throw e;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

/** PDF (text layer, or OCR for scans) or image (OCR) bytes to text. */
export async function bytesToText(buf: Buffer): Promise<{ text: string; method: string }> {
  if (isPdf(buf)) { const r = await extractPdfText(buf); return { text: r.text, method: r.method === "ocr" ? "pdf-ocr" : "pdf" }; }
  if (isImage(buf)) return { text: await extractImageText(buf), method: "image-ocr" };
  throw new Error("Only PDFs and images (PNG, JPG) can be read as files here; paste other text directly.");
}

export function htmlToText(html: string): { title: string; text: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const ld = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).join("\n");
  let t = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/table|\/section)[^>]*>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, h, inner) => `${inner} (${h})`)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  if (ld) t += `\n\nStructured data on the page:\n${ld.slice(0, 6000)}`;
  return { title, text: t };
}

function privateIp(ip: string): boolean {
  if (net.isIPv6(ip)) return ip === "::1" || ip.toLowerCase().startsWith("fc") || ip.toLowerCase().startsWith("fd") || ip.toLowerCase().startsWith("fe80") || ip.startsWith("::ffff:127.") || ip.startsWith("::ffff:10.") || ip.startsWith("::ffff:192.168.");
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a >= 224;
}

/** Fetches a public web page (or PDF) and returns its text. Refuses private/internal addresses. */
export async function urlToText(raw: string): Promise<{ text: string; title: string; method: string }> {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new Error("That is not a valid web address."); }
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http(s) addresses can be read.");
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => { throw new Error("That web address could not be found."); });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error("That address points to a private network and can't be read.");
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; TripPlannerImport/1.0)", Accept: "text/html,application/pdf,text/plain;q=0.9,*/*;q=0.5" } });
    if (!res.ok) throw new Error(`The page answered with an error (${res.status}). Many travel sites block automatic reading: open it, copy the text and paste it instead.`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > 8_000_000) throw new Error("That page is too large to import.");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8_000_000) throw new Error("That page is too large to import.");
    if (isPdf(buf) || isImage(buf)) { const r = await bytesToText(buf); return { text: r.text, title: u.hostname, method: r.method }; }
    const body = buf.toString("utf8");
    const ct = res.headers.get("content-type") ?? "";
    if (/html/i.test(ct) || /<html|<body|<!doctype/i.test(body.slice(0, 500))) {
      const { title, text } = htmlToText(body);
      if (text.replace(/\s/g, "").length < 200) throw new Error("That page has almost no readable text (it probably loads its content with JavaScript or needs a login). Open it, copy the text and paste it instead.");
      return { text, title: title || u.hostname, method: "web" };
    }
    return { text: body, title: u.hostname, method: "web" };
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("The page took too long to answer.");
    throw e;
  } finally { clearTimeout(timer); }
}

const metaContent = (html: string, keys: string[]): string | null => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    if (!key || !keys.includes(key)) continue;
    const c = /content\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (c) return c.replace(/&amp;/g, "&").trim();
  }
  return null;
};

/** The preview picture of a public web page (og:image / twitter:image), or null. Never throws. */
export async function pageImage(raw: string): Promise<string | null> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const u = new URL(raw.trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    const addrs = await dns.lookup(u.hostname, { all: true });
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null;
    const res = await fetch(u, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; TripPlannerImport/1.0)", Accept: "text/html,image/*;q=0.8" } });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (/^image\//i.test(ct)) return u.toString();
    if (!/html/i.test(ct)) return null;
    const html = (await res.text()).slice(0, 600_000);
    const found = metaContent(html, ["og:image:secure_url", "og:image", "og:image:url", "twitter:image", "twitter:image:src"])
      ?? /<link\b[^>]*rel\s*=\s*["']image_src["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? null;
    if (!found) return null;
    const abs = new URL(found, res.url || u);
    return /^https?:$/.test(abs.protocol) ? abs.toString().slice(0, 1000) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}
