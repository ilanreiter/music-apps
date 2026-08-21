import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { BookingAgent, BookingStatus, BudgetLine, Conflict, Trip, TripItem, TripItemType } from "../types";
import { Badge, Button, Card, Input, Label, PageHeader, Select, Textarea } from "../components/ui";

const TABS = ["Itinerary", "Route", "Budget", "Resources"] as const;
type Tab = (typeof TABS)[number];

const TYPE_TONE: Record<TripItemType, string> = {
  TRANSPORT: "blue",
  STAY: "purple",
  POI: "green",
  ACTIVITY: "amber",
  OTHER: "slate",
};

const BOOKING_TONE: Record<BookingStatus, string> = {
  IDEA: "slate",
  RESEARCHING: "amber",
  READY_TO_BOOK: "blue",
  BOOKED: "purple",
  CONFIRMED: "green",
  CANCELLED: "red",
};

export default function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [agents, setAgents] = useState<BookingAgent[]>([]);
  const [tab, setTab] = useState<Tab>("Itinerary");
  const [showItemForm, setShowItemForm] = useState(false);
  const [route, setRoute] = useState<{ order: { id: string; title: string }[]; totalKm: number } | null>(null);

  function load() {
    if (!id) return;
    api.get<Trip>(`/trips/${id}`).then(setTrip).catch(() => {});
    api.get<Conflict[]>(`/trips/${id}/conflicts`).then(setConflicts).catch(() => {});
  }

  useEffect(() => {
    load();
    api.get<BookingAgent[]>("/booking-agents").then(setAgents).catch(() => {});
  }, [id]);

  async function optimizeRoute() {
    if (!id) return;
    const r = await api.get<{ order: { id: string; title: string }[]; totalKm: number }>(`/trips/${id}/optimize-route`);
    setRoute(r);
  }

  if (!trip) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div>
      <PageHeader
        title={trip.title}
        subtitle={`${trip.destination?.name || "No destination"} · ${trip.status}`}
      />

      {conflicts.length > 0 && (
        <Card className="p-4 mb-4 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40">
          <div className="font-medium text-red-700 dark:text-red-300 mb-1 text-sm">⚠ {conflicts.length} scheduling conflict(s) detected</div>
          <ul className="text-xs text-red-600 dark:text-red-400 space-y-1">
            {conflicts.map((c, i) => <li key={i}>{c.reason}</li>)}
          </ul>
        </Card>
      )}

      <div className="flex gap-1 border-b border-slate-200 mb-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t ? "border-brand-600 text-brand-700" : "border-transparent text-slate-500 hover:text-slate-700"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Itinerary" && (
        <ItineraryTab trip={trip} agents={agents} reload={load} showForm={showItemForm} setShowForm={setShowItemForm} />
      )}
      {tab === "Route" && (
        <div>
          <Button onClick={optimizeRoute} className="mb-4">Optimize POI route</Button>
          {route && (
            <Card className="p-4">
              <p className="text-sm text-slate-600 mb-2">Suggested order (approx {route.totalKm} km total):</p>
              <ol className="list-decimal list-inside text-sm space-y-1">
                {route.order.map((p) => <li key={p.id}>{p.title}</li>)}
              </ol>
            </Card>
          )}
          {!route && <p className="text-sm text-slate-500">Add points of interest with coordinates, then optimize.</p>}
        </div>
      )}
      {tab === "Budget" && <BudgetTab tripId={trip.id} lines={trip.budgetLines} reload={load} />}
      {tab === "Resources" && <ResourcesTab tripId={trip.id} resources={trip.resources} reload={load} />}
    </div>
  );
}

function ItineraryTab({
  trip,
  agents,
  reload,
  showForm,
  setShowForm,
}: {
  trip: Trip;
  agents: BookingAgent[];
  reload: () => void;
  showForm: boolean;
  setShowForm: (v: boolean) => void;
}) {
  const [type, setType] = useState<TripItemType>("TRANSPORT");
  const [itemTitle, setItemTitle] = useState("");
  const [provider, setProvider] = useState("");
  const [location, setLocation] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [startAt, setStartAt] = useState("");
  const [endAt, setEndAt] = useState("");
  const [cost, setCost] = useState("");
  const [bookingStatus, setBookingStatus] = useState<BookingStatus>("IDEA");
  const [confirmationNo, setConfirmationNo] = useState("");
  const [bookingAgentId, setBookingAgentId] = useState("");

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    await api.post(`/trips/${trip.id}/items`, {
      type,
      title: itemTitle,
      provider: provider || null,
      location: location || null,
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
      startAt: startAt ? new Date(startAt).toISOString() : null,
      endAt: endAt ? new Date(endAt).toISOString() : null,
      cost: cost ? parseFloat(cost) : null,
      bookingStatus,
      confirmationNo: confirmationNo || null,
      bookingAgentId: bookingAgentId || null,
    });
    setItemTitle(""); setProvider(""); setLocation(""); setLat(""); setLng("");
    setStartAt(""); setEndAt(""); setCost(""); setConfirmationNo(""); setBookingAgentId("");
    setBookingStatus("IDEA");
    setShowForm(false);
    reload();
  }

  async function updateStatus(itemId: string, s: BookingStatus) {
    await api.patch(`/trips/${trip.id}/items/${itemId}`, { bookingStatus: s });
    reload();
  }

  async function removeItem(itemId: string) {
    if (!confirm("Remove this item?")) return;
    await api.delete(`/trips/${trip.id}/items/${itemId}`);
    reload();
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <Button onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "+ Add item"}</Button>
      </div>

      {showForm && (
        <Card className="p-5 mb-6">
          <form onSubmit={addItem} className="grid grid-cols-3 gap-4">
            <div>
              <Label>Type</Label>
              <Select value={type} onChange={(e) => setType(e.target.value as TripItemType)}>
                {(["TRANSPORT", "STAY", "POI", "ACTIVITY", "OTHER"] as TripItemType[]).map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Title</Label>
              <Input value={itemTitle} onChange={(e) => setItemTitle(e.target.value)} required />
            </div>
            <div>
              <Label>Provider</Label>
              <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. Delta, Marriott" />
            </div>
            <div>
              <Label>Location</Label>
              <Input value={location} onChange={(e) => setLocation(e.target.value)} />
            </div>
            <div>
              <Label>Cost</Label>
              <Input type="number" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
            <div>
              <Label>Latitude (for POIs)</Label>
              <Input type="number" step="any" value={lat} onChange={(e) => setLat(e.target.value)} />
            </div>
            <div>
              <Label>Longitude (for POIs)</Label>
              <Input type="number" step="any" value={lng} onChange={(e) => setLng(e.target.value)} />
            </div>
            <div>
              <Label>Booking status</Label>
              <Select value={bookingStatus} onChange={(e) => setBookingStatus(e.target.value as BookingStatus)}>
                {(["IDEA", "RESEARCHING", "READY_TO_BOOK", "BOOKED", "CONFIRMED", "CANCELLED"] as BookingStatus[]).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Start</Label>
              <Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} />
            </div>
            <div>
              <Label>End</Label>
              <Input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} />
            </div>
            <div>
              <Label>Confirmation #</Label>
              <Input value={confirmationNo} onChange={(e) => setConfirmationNo(e.target.value)} />
            </div>
            <div>
              <Label>Booking agent</Label>
              <Select value={bookingAgentId} onChange={(e) => setBookingAgentId(e.target.value)}>
                <option value="">— none —</option>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </div>
            <div className="col-span-3">
              <Button type="submit">Add to itinerary</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="space-y-3">
        {trip.items.map((item) => (
          <Card key={item.id} className="p-4 flex items-center gap-4">
            <Badge tone={TYPE_TONE[item.type]}>{item.type}</Badge>
            <div className="flex-1">
              <div className="font-medium">{item.title}</div>
              <div className="text-xs text-slate-500">
                {item.provider && `${item.provider} · `}
                {item.location && `${item.location} · `}
                {item.startAt && new Date(item.startAt).toLocaleString()}
                {item.endAt && ` → ${new Date(item.endAt).toLocaleString()}`}
              </div>
              {item.cost != null && <div className="text-xs text-slate-400">{item.currency || "USD"} {item.cost}</div>}
              {item.confirmationNo && <div className="text-xs text-slate-400">Confirmation: {item.confirmationNo}</div>}
              {item.bookingAgent && <div className="text-xs text-slate-400">Via {item.bookingAgent.name}</div>}
            </div>
            <Select
              value={item.bookingStatus}
              onChange={(e) => updateStatus(item.id, e.target.value as BookingStatus)}
              className="w-40"
            >
              {(["IDEA", "RESEARCHING", "READY_TO_BOOK", "BOOKED", "CONFIRMED", "CANCELLED"] as BookingStatus[]).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
            <Badge tone={BOOKING_TONE[item.bookingStatus]}>{item.bookingStatus}</Badge>
            <Button variant="danger" onClick={() => removeItem(item.id)}>Remove</Button>
          </Card>
        ))}
        {trip.items.length === 0 && <p className="text-sm text-slate-500">No itinerary items yet.</p>}
      </div>
    </div>
  );
}

const BUDGET_CATEGORIES = ["TRANSPORT", "LODGING", "FOOD", "ACTIVITIES", "SHOPPING", "INSURANCE", "MISC"] as const;

function BudgetTab({ tripId, lines, reload }: { tripId: string; lines: BudgetLine[]; reload: () => void }) {
  const [category, setCategory] = useState<(typeof BUDGET_CATEGORIES)[number]>("TRANSPORT");
  const [label, setLabel] = useState("");
  const [estimated, setEstimated] = useState("");
  const [actual, setActual] = useState("");

  const totalEstimated = lines.reduce((s, l) => s + l.estimated, 0);
  const totalActual = lines.reduce((s, l) => s + (l.actual ?? 0), 0);

  async function addLine(e: React.FormEvent) {
    e.preventDefault();
    await api.post(`/trips/${tripId}/budget`, {
      category,
      label,
      estimated: parseFloat(estimated || "0"),
      actual: actual ? parseFloat(actual) : null,
    });
    setLabel(""); setEstimated(""); setActual("");
    reload();
  }

  async function removeLine(lineId: string) {
    await api.delete(`/trips/${tripId}/budget/${lineId}`);
    reload();
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-4 mb-6">
        <Card className="p-4">
          <div className="text-xs text-slate-500">Total estimated</div>
          <div className="text-2xl font-semibold">${totalEstimated.toFixed(2)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-slate-500">Total actual</div>
          <div className="text-2xl font-semibold">${totalActual.toFixed(2)}</div>
        </Card>
      </div>

      <Card className="p-5 mb-6">
        <form onSubmit={addLine} className="grid grid-cols-4 gap-4 items-end">
          <div>
            <Label>Category</Label>
            <Select value={category} onChange={(e) => setCategory(e.target.value as any)}>
              {BUDGET_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </div>
          <div>
            <Label>Label</Label>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} required />
          </div>
          <div>
            <Label>Estimated</Label>
            <Input type="number" step="0.01" value={estimated} onChange={(e) => setEstimated(e.target.value)} />
          </div>
          <div>
            <Label>Actual</Label>
            <Input type="number" step="0.01" value={actual} onChange={(e) => setActual(e.target.value)} />
          </div>
          <div className="col-span-4">
            <Button type="submit">Add budget line</Button>
          </div>
        </form>
      </Card>

      <div className="space-y-2">
        {lines.map((l) => (
          <Card key={l.id} className="p-3 flex items-center gap-4">
            <Badge>{l.category}</Badge>
            <div className="flex-1 text-sm">{l.label}</div>
            <div className="text-sm text-slate-500">est. ${l.estimated.toFixed(2)}</div>
            <div className="text-sm text-slate-700">actual ${(l.actual ?? 0).toFixed(2)}</div>
            <Button variant="danger" onClick={() => removeLine(l.id)}>Remove</Button>
          </Card>
        ))}
        {lines.length === 0 && <p className="text-sm text-slate-500">No budget lines yet.</p>}
      </div>
    </div>
  );
}

function ResourcesTab({ tripId, resources, reload }: { tripId: string; resources: Trip["resources"]; reload: () => void }) {
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");

  async function addResource(e: React.FormEvent) {
    e.preventDefault();
    await api.post("/resources", { title, url: url || undefined, category: category || undefined, notes: notes || undefined, tripId });
    setTitle(""); setUrl(""); setCategory(""); setNotes("");
    reload();
  }

  async function removeResource(id: string) {
    await api.delete(`/resources/${id}`);
    reload();
  }

  return (
    <div>
      <Card className="p-5 mb-6">
        <form onSubmit={addResource} className="grid grid-cols-2 gap-4">
          <div>
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
          </div>
          <div>
            <Label>URL</Label>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </div>
          <div>
            <Label>Category</Label>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Guide, Visa, Packing list…" />
          </div>
          <div className="col-span-2">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
          <div className="col-span-2">
            <Button type="submit">Add resource</Button>
          </div>
        </form>
      </Card>

      <div className="space-y-2">
        {resources.map((r) => (
          <Card key={r.id} className="p-3 flex items-center gap-4">
            {r.category && <Badge>{r.category}</Badge>}
            <div className="flex-1 text-sm">
              {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">{r.title}</a> : r.title}
              {r.notes && <div className="text-xs text-slate-400">{r.notes}</div>}
            </div>
            <Button variant="danger" onClick={() => removeResource(r.id)}>Remove</Button>
          </Card>
        ))}
        {resources.length === 0 && <p className="text-sm text-slate-500">No resources linked to this trip yet.</p>}
      </div>
    </div>
  );
}
