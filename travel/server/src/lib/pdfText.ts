// Text from a PDF, read locally (nothing is sent anywhere here): `pdftotext` (poppler) for normal PDFs,
// and Tesseract OCR on rendered pages for scanned / photographed ones. Same approach as the statement vault.
import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const run = promisify(execFile);
const OCR_LANGS = process.env.OCR_LANGS || "eng+heb";
const OCR_MAX_PAGES = 8;
const BIDI = /[‎‏‪-‮⁦-⁩]/g; // invisible direction marks Hebrew/Arabic PDFs embed

export interface PdfText { text: string; method: "text" | "ocr"; pages: number }

async function pdfPages(file: string): Promise<number> {
  try {
    const { stdout } = await run("pdfinfo", [file], { timeout: 20_000 });
    return parseInt(stdout.match(/Pages:\s+(\d+)/)?.[1] ?? "1", 10) || 1;
  } catch { return 1; }
}

const clean = (s: string) => s.replace(BIDI, "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export async function extractPdfText(buf: Buffer): Promise<PdfText> {
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("That file is not a PDF.");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdf-"));
  try {
    const file = path.join(dir, "in.pdf");
    await fs.writeFile(file, buf);
    const pages = await pdfPages(file);
    let text = "";
    try {
      const { stdout } = await run("pdftotext", ["-layout", file, "-"], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
      text = clean(stdout);
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new Error("PDF reading is not installed on the server (poppler-utils).");
    }
    // A text PDF yields well over ~40 characters a page; less means scanned images.
    if (text.length >= Math.min(pages, OCR_MAX_PAGES) * 40) return { text, method: "text", pages };

    try {
      await run("pdftoppm", ["-r", "250", "-png", "-l", String(OCR_MAX_PAGES), file, path.join(dir, "p")], { timeout: 120_000 });
      const imgs = (await fs.readdir(dir)).filter((f) => f.startsWith("p") && f.endsWith(".png")).sort();
      const parts: string[] = [];
      for (const img of imgs) {
        const { stdout } = await run("tesseract", [path.join(dir, img), "-", "-l", OCR_LANGS, "--psm", "3"], { timeout: 180_000, maxBuffer: 10 * 1024 * 1024 });
        parts.push(stdout);
      }
      const ocr = clean(parts.join("\n\n"));
      if (ocr.length > text.length) return { text: ocr, method: "ocr", pages };
    } catch (e: any) {
      if (e?.code === "ENOENT" && !text) throw new Error("OCR is not installed on the server (tesseract).");
    }
    if (!text) throw new Error("No readable text was found in that PDF.");
    return { text, method: "text", pages };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
