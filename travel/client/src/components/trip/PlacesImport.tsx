import { useState } from "react";
import { FileUp, Loader2, MapPin } from "lucide-react";
import { api } from "../../lib/api";
import { Trip } from "../../types";
import { Button, Card, Textarea } from "../ui";
import { readFileText } from "./shared";

interface Place { title: string; lat: number | null; lng: number | null; notes: string | null; url: string | null }

/** Brings places from Google Maps (Takeout saved places, My Maps KML, saved-list CSV, or pasted names/links) into the itinerary. */
export default function PlacesImport({ trip, reload }: { trip: Trip; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [filename, setFilename] = useState("");
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [pick, setPick] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const parse = async (content = text, name = filename) => {
    setBusy(true); setError(""); setPlaces(null);
    try {
      const r = await api.post<{ places: Place[] }>(`/trips/${trip.id}/import-places`, { filename: name, content });
      const have = new Set(trip.items.map((i) => i.title.toLowerCase()));
      setPlaces(r.places);
      setPick(new Set(r.places.map((p, n) => (have.has(p.title.toLowerCase()) ? -1 : n)).filter((n) => n >= 0)));
      if (!r.places.length) setError("No places were found in that file.");
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };
  const onFile = async (f?: File) => {
    if (!f) return;
    const content = await readFileText(f);
    setText(content.length > 4000 ? "" : content); setFilename(f.name);
    await parse(content, f.name);
  };
  const add = async () => {
    setBusy(true);
    try {
      const chosen = (places ?? []).filter((_, n) => pick.has(n));
      await api.post(`/trips/${trip.id}/items/places`, { places: chosen });
      setPlaces(null); setText(""); setFilename(""); setOpen(false); reload();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  };

  if (!open) return <div className="mb-4 flex justify-end"><Button variant="secondary" onClick={() => setOpen(true)}><MapPin className="h-4 w-4 mr-1.5" />Import places from Google Maps</Button></div>;
  const noCoords = (places ?? []).filter((p, n) => pick.has(n) && p.lat == null).length;
  return (
    <Card className="p-4 mb-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Import places from Google Maps</h3>
          <p className="text-xs text-slate-500">Upload a Google Takeout “Saved places” file (.json or .csv), a My Maps export (.kml), or paste place names / Google Maps links, one per line. Google doesn't let apps read shared list links directly, so export the list first.</p>
        </div>
        <button type="button" onClick={() => { setOpen(false); setPlaces(null); setError(""); }} className="text-xs text-slate-500 hover:underline">Close</button>
      </div>
      {!places && (
        <>
          <Textarea rows={5} value={text} onChange={(e) => { setText(e.target.value); setFilename(""); }} placeholder={"Belém Tower\nhttps://www.google.com/maps/place/Time+Out+Market/@38.7068,-9.1459,17z\nPastéis de Belém"} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
              <FileUp className="h-4 w-4" />Upload file<input type="file" accept=".json,.geojson,.csv,.kml,.txt,text/*" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <Button onClick={() => parse()} disabled={busy || !text.trim()}>{busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}Read places</Button>
          </div>
        </>
      )}
      {places && places.length > 0 && (
        <>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <button type="button" className="hover:underline" onClick={() => setPick(new Set(places.map((_, n) => n)))}>Select all</button>
            <button type="button" className="hover:underline" onClick={() => setPick(new Set())}>None</button>
            <span>{pick.size} of {places.length} selected</span>
          </div>
          <ul className="max-h-72 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-md border border-slate-200 dark:border-slate-800">
            {places.map((p, n) => (
              <li key={n} className="flex items-start gap-3 p-2 text-sm">
                <input type="checkbox" className="mt-1 h-4 w-4 accent-brand-600" checked={pick.has(n)} aria-label={`Add ${p.title}`}
                  onChange={(e) => setPick((s) => { const x = new Set(s); e.target.checked ? x.add(n) : x.delete(n); return x; })} />
                <div className="min-w-0 flex-1"><div className="truncate font-medium">{p.title}</div>{p.notes && <div className="truncate text-xs text-slate-500">{p.notes}</div>}</div>
                <span className={`shrink-0 text-xs ${p.lat != null ? "text-green-600" : "text-slate-400"}`}>{p.lat != null ? "on map" : "no location"}</span>
              </li>
            ))}
          </ul>
          {noCoords > 0 && <p className="text-xs text-slate-500">{noCoords} selected place{noCoords === 1 ? " has" : "s have"} no coordinates. Use “Fill in missing map locations with AI” on the Route tab after adding to place them on the map.</p>}
          <div className="flex gap-2">
            <Button onClick={add} disabled={busy || !pick.size}>{busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}Add {pick.size} to itinerary</Button>
            <Button variant="secondary" onClick={() => setPlaces(null)}>Back</Button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Card>
  );
}
