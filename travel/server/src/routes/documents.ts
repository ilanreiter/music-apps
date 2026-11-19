import express, { Router } from "express";
import { extractPdfText } from "../lib/pdfText";

const router = Router();

// Raw PDF body in, plain text out (local text extraction, with OCR for scans). The text is then reviewed and parsed like pasted text.
router.post("/pdf-text", express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "15mb" }), async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Send the PDF file as the request body." });
  try {
    res.json(await extractPdfText(req.body));
  } catch (e: any) {
    res.status(422).json({ error: e?.message || "That PDF could not be read." });
  }
});

export default router;
