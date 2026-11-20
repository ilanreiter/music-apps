import { BookingStatus, TripItem } from "../../types";

export const BOOKING_STATUSES: { value: BookingStatus; label: string }[] = [
  { value: "IDEA", label: "Idea" }, { value: "RESEARCHING", label: "Researching" }, { value: "READY_TO_BOOK", label: "Ready to book" },
  { value: "BOOKED", label: "Booked" }, { value: "CONFIRMED", label: "Confirmed" }, { value: "CANCELLED", label: "Cancelled" },
];
export const BOOKING_TONE: Record<BookingStatus, string> = { IDEA: "slate", RESEARCHING: "amber", READY_TO_BOOK: "blue", BOOKED: "purple", CONFIRMED: "green", CANCELLED: "red" };
export const isBooked = (i: TripItem) => i.bookingStatus === "BOOKED" || i.bookingStatus === "CONFIRMED";
/** Things you book: everything except plain points of interest. */
export const isBookable = (i: TripItem) => i.type !== "POI";

/** Text of an uploaded file: PDFs and images are read on the server (text layer, or OCR for scans and screenshots); anything else as text. */
export async function readDocumentText(f: File): Promise<{ text: string; note?: string }> {
  const binary = /\.(pdf|png|jpe?g|webp|gif)$/i.test(f.name) || /^(application\/pdf|image\/)/.test(f.type);
  if (!binary) return { text: await readFileText(f) };
  const res = await fetch("/api/documents/file-text", { method: "POST", credentials: "include", headers: { "Content-Type": "application/octet-stream" }, body: f });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Could not read the file (${res.status})`);
  return { text: body.text, note: /ocr/.test(body.method ?? "") ? "Read with OCR (scanned or image) — check the text for misreads." : undefined };
}

export const readFileText = (f: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result ?? ""));
  r.onerror = () => reject(new Error("Could not read the file"));
  r.readAsText(f);
});

/** Date-only values are stored at noon UTC so they never shift a day with the viewer's timezone. */
export const dateToIso = (d: string) => (d ? `${d}T12:00:00.000Z` : null);
export const isoToDate = (iso?: string | null) => (iso ? iso.slice(0, 10) : "");
export const daysFromNow = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
export const shortDate = (iso: string) => new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
export const money = (n: number | null | undefined, cur?: string | null) => (n == null ? "—" : `${cur && cur !== "USD" ? cur + " " : "$"}${Math.round(n).toLocaleString("en-US")}`);
