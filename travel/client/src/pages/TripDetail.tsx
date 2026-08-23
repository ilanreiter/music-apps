import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { BookingAgent, BookingStatus, BudgetLine, Conflict, Trip, TripItem, TripItemType } from "../types";
import { Badge, BadgeSelect, Button, Card, Input, Label, PageHeader, Select, Textarea } from "../components/ui";
import TripSetup from "../components/TripSetup";
import { AlertTriangleIcon } from "../components/icons";
import type { MapPoint } from "../components/RouteMap";

const RouteMap = React.lazy(() => import("../components/RouteMap"));

const TABS = ["Itinerary", "Route", "Budget", "Resources"] as const;
type Tab = (typeof TABS)[number];

const BOOKING_TONE: Record<BookingStatus, string> = {
  IDEA: "slate",
  RESEARCHING: "amber",
  READY_TO_BOOK: "blue",
  BOOKED: "purple",
  CONFIRMED: "green",
  CANCELLED: "red",
};

function startOfDay(iso: string) {
  const d = new Date(iso);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// When the trip has no real start date, item times are anchored to a fixed
// placeholder date server-side (see tripItems.ts) purely to preserve
// time-of-day and duration — that date itself is meaningless and must not
// be shown to the user, only the clock time.
function formatItemTime(trip: Trip, iso: string): string {
  const d = new Date(iso);
  if (trip.startDate) return d.toLocaleString();
  // Undated trips anchor items to a fixed placeholder UTC date purely to
  // preserve time-of-day (see UNDATED_TRIP_ANCHOR in tripItems.ts) — that
  // clock time was set as UTC server-side, so it must be read back with the
  // UTC getters here too. Using the local-time formatter instead would shift
  // the displayed hour by the browser's timezone offset for no reason (e.g.
  // a stored "09:00" showing as "4:00 AM" in US Central).
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const period = hours >= 12 ? "PM" : "AM";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${period}`;
}

function formatDuration(startAt?: string | null, endAt?: string | null): string | null {
  if (!startAt || !endAt) return null;
  const minutes = Math.round((new Date(endAt).getTime() - new Date(startAt).getTime()) / 60_000);
  if (minutes <= 0) return null;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// Best-effort day number for the leftmost column. Prefers the trip's actual
// start date; falls back to the earliest dated item in the trip (for trips
// planned before exact dates are known); falls back to a "Day N" prefix left
// in notes by the AI propose/import flow (used when neither the trip nor any
// item has a real date yet). Returns null when none of that is available.
function dayNumberFor(trip: Trip, item: TripItem): number | null {
  if (trip.startDate && item.startAt) {
    return Math.round((startOfDay(item.startAt) - startOfDay(trip.startDate)) / 86_400_000) + 1;
  }
  if (item.startAt) {
    const datedStarts = trip.items.filter((i) => i.startAt).map((i) => startOfDay(i.startAt as string));
    if (datedStarts.length) {
      const earliest = Math.min(...datedStarts);
      return Math.round((startOfDay(item.startAt) - earliest) / 86_400_000) + 1;
    }
  }
  const match = item.notes?.match(/^Day (\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export default function TripDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [agents, setAgents] = useState<BookingAgent[]>([]);
  const [tab, setTab] = useState<Tab>("Itinerary");
  const [showItemForm, setShowItemForm] = useState(false);

  function load() {
    if (!id) return;
    api.get<Trip>(`/trips/${id}`).then(setTrip).catch(() => {});
    api.get<Conflict[]>(`/trips/${id}/conflicts`).then(setConflicts).catch(() => {});
  }

  useEffect(() => {
    load();
    api.get<BookingAgent[]>("/booking-agents").then(setAgents).catch(() => {});
  }, [id]);

  async function deleteTrip() {
    if (!trip) return;
    if (!confirm(`Delete "${trip.title}"? This permanently removes the trip and all its itinerary items, budget lines, and resources. This cannot be undone.`)) return;
    await api.delete(`/trips/${trip.id}`);
    navigate("/trips");
  }

  if (!trip) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div>
      <PageHeader
        title={trip.title}
        subtitle={`${trip.destination?.name || "No destination"} · ${trip.status}`}
        actions={<Button variant="danger" onClick={deleteTrip}>Delete trip</Button>}
      />

      {conflicts.length > 0 && (
        <Card className="p-4 mb-4 border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40">
          <div className="font-medium text-red-700 dark:text-red-300 mb-1 text-sm flex items-center gap-1.5">
            <AlertTriangleIcon className="h-4 w-4" /> {conflicts.length} scheduling conflict(s) detected
          </div>
          <ul className="text-xs text-red-600 dark:text-red-400 space-y-1">
            {conflicts.map((c, i) => <li key={i}>{c.reason}</li>)}
          </ul>
        </Card>
      )}

      <TripSetup trip={trip} reload={load} />

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800 mb-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === t
                ? "border-brand-600 text-brand-700 dark:text-brand-400"
                : "border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Itinerary" && (
        <ItineraryTab trip={trip} agents={agents} reload={load} showForm={showItemForm} setShowForm={setShowItemForm} />
      )}
      {tab === "Route" && <RouteTab trip={trip} reload={load} />}
      {tab === "Budget" && <BudgetTab tripId={trip.id} lines={trip.budgetLines} items={trip.items} reload={load} />}
      {tab === "Resources" && <ResourcesTab tripId={trip.id} resources={trip.resources} reload={load} />}
    </div>
  );
}

function RouteTab({ trip, reload }: { trip: Trip; reload: () => void }) {
  const [optimized, setOptimized] = useState<{ order: MapPoint[]; totalKm: number } | null>(null);
  const [optimizing, setOptimizing] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeError, setGeocodeError] = useState<string | null>(null);
  const [geocodeMsg, setGeocodeMsg] = useState<string | null>(null);
  const [dayFilter, setDayFilter] = useState<number | "ALL">("ALL");

  const days = [...new Set(trip.items.map((i) => dayNumberFor(trip, i)).filter((d): d is number => d != null))].sort(
    (a, b) => a - b
  );

  const dayFilteredItems = trip.items.filter((i) => dayFilter === "ALL" || dayNumberFor(trip, i) === dayFilter);

  const itineraryPoints: MapPoint[] = dayFilteredItems
    .filter((i): i is TripItem & { lat: number; lng: number } => i.lat != null && i.lng != null)
    .map((i) => ({ id: i.id, title: i.title, lat: i.lat, lng: i.lng }));

  const missingCount = dayFilteredItems.filter((i) => i.lat == null || i.lng == null).length;

  async function optimizeRoute() {
    setOptimizing(true);
    try {
      const r = await api.get<{ order: MapPoint[]; totalKm: number }>(`/trips/${trip.id}/optimize-route`);
      setOptimized(r);
    } finally {
      setOptimizing(false);
    }
  }

  async function fillMissingCoordinates() {
    setGeocoding(true);
    setGeocodeError(null);
    setGeocodeMsg(null);
    try {
      const r = await api.post<{ updated: number; checked: number }>(`/trips/${trip.id}/geocode-items`);
      setGeocodeMsg(
        r.updated > 0
          ? `Placed ${r.updated} of ${r.checked} item(s) on the map.`
          : "Couldn't identify map locations for the remaining items — they may be too generic (e.g. \"drive home\")."
      );
      reload();
    } catch (err: any) {
      setGeocodeError(err.message);
    } finally {
      setGeocoding(false);
    }
  }

  // The optimize-route call always runs over the full itinerary server-side —
  // when a day filter is active, narrow its result down to that day's points
  // rather than re-requesting an optimization scoped to one day.
  const dayFilteredIds = new Set(itineraryPoints.map((p) => p.id));
  const displayPoints = optimized ? optimized.order.filter((p) => dayFilteredIds.has(p.id)) : itineraryPoints;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          onClick={() => setDayFilter("ALL")}
          className={`px-3 py-1 rounded-full text-xs font-medium border ${
            dayFilter === "ALL"
              ? "bg-brand-600 border-brand-600 text-white"
              : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-brand-400"
          }`}
        >
          All days
        </button>
        {days.map((d) => (
          <button
            key={d}
            onClick={() => setDayFilter(d)}
            className={`px-3 py-1 rounded-full text-xs font-medium border ${
              dayFilter === d
                ? "bg-brand-600 border-brand-600 text-white"
                : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-brand-400"
            }`}
          >
            Day {d}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <Button onClick={optimizeRoute} disabled={optimizing}>
          {optimizing ? "Optimizing…" : "Optimize POI route"}
        </Button>
        {missingCount > 0 && (
          <Button variant="secondary" onClick={fillMissingCoordinates} disabled={geocoding}>
            {geocoding ? "Locating…" : `Fill in ${missingCount} missing map location(s) with AI`}
          </Button>
        )}
        {optimized && (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            Suggested order — approx {optimized.totalKm} km total
          </span>
        )}
        {optimized && (
          <Button variant="ghost" onClick={() => setOptimized(null)}>Show full itinerary instead</Button>
        )}
      </div>
      {geocodeMsg && <p className="text-sm text-green-600 dark:text-green-400 mb-2">{geocodeMsg}</p>}
      {geocodeError && <p className="text-sm text-red-600 mb-2">{geocodeError}</p>}

      {displayPoints.length === 0 ? (
        <p className="text-sm text-slate-500 mt-2">
          {dayFilter !== "ALL"
            ? `No mapped items on Day ${dayFilter}.`
            : 'No itinerary items have coordinates yet. Use "Fill in missing map locations with AI" above, or add a latitude/longitude when creating a transport, stay, or POI item.'}
        </p>
      ) : (
        <div className="space-y-4">
          <React.Suspense fallback={<div className="h-[420px] rounded-lg border border-slate-200 dark:border-slate-800 flex items-center justify-center text-sm text-slate-400">Loading map…</div>}>
            <RouteMap points={displayPoints} />
          </React.Suspense>
          <Card className="p-4">
            <ol className="list-decimal list-inside text-sm space-y-1 text-slate-700 dark:text-slate-300">
              {displayPoints.map((p) => <li key={p.id}>{p.title}</li>)}
            </ol>
          </Card>
        </div>
      )}
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
  const [durationHours, setDurationHours] = useState("");
  const [cost, setCost] = useState("");
  const [bookingStatus, setBookingStatus] = useState<BookingStatus>("IDEA");
  const [confirmationNo, setConfirmationNo] = useState("");
  const [bookingAgentId, setBookingAgentId] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<(typeof BUDGET_CATEGORIES)[number] | "ALL">("ALL");

  // If a duration was given but no explicit end time, derive one from start + duration.
  function resolveEndAt(): string {
    if (endAt) return new Date(endAt).toISOString();
    if (startAt && durationHours) {
      const end = new Date(startAt);
      end.setMinutes(end.getMinutes() + Math.round(parseFloat(durationHours) * 60));
      return end.toISOString();
    }
    return "";
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const resolvedEndAt = resolveEndAt();
    await api.post(`/trips/${trip.id}/items`, {
      type,
      title: itemTitle,
      provider: provider || null,
      location: location || null,
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
      startAt: startAt ? new Date(startAt).toISOString() : null,
      endAt: resolvedEndAt || null,
      cost: cost ? parseFloat(cost) : null,
      bookingStatus,
      confirmationNo: confirmationNo || null,
      bookingAgentId: bookingAgentId || null,
    });
    setItemTitle(""); setProvider(""); setLocation(""); setLat(""); setLng("");
    setStartAt(""); setEndAt(""); setDurationHours(""); setCost(""); setConfirmationNo(""); setBookingAgentId("");
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
              <Label>Or duration (hours)</Label>
              <Input
                type="number"
                step="0.25"
                min="0"
                value={durationHours}
                onChange={(e) => setDurationHours(e.target.value)}
                placeholder="e.g. 1.5"
                disabled={!!endAt}
              />
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

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          onClick={() => setCategoryFilter("ALL")}
          className={`px-3 py-1 rounded-full text-xs font-medium border ${
            categoryFilter === "ALL"
              ? "bg-brand-600 border-brand-600 text-white"
              : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-brand-400"
          }`}
        >
          All ({trip.items.length})
        </button>
        {BUDGET_CATEGORIES.map((cat) => {
          const count = trip.items.filter((i) => budgetCategoryForItem(i) === cat).length;
          if (count === 0) return null;
          return (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1 rounded-full text-xs font-medium border ${
                categoryFilter === cat
                  ? "bg-brand-600 border-brand-600 text-white"
                  : "border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-brand-400"
              }`}
            >
              {categoryLabel(cat)} ({count})
            </button>
          );
        })}
      </div>

      <div className="overflow-x-auto">
        <div className={`${ITEM_ROW_MIN_WIDTH} space-y-3`}>
          <div className={`hidden sm:grid ${ITEM_ROW_GRID_COLS} gap-4 px-4 text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide`}>
            <div>Day</div>
            <div>Category</div>
            <div>Item</div>
            <div>Duration</div>
            <div>Cost</div>
            <div>Status</div>
            <div></div>
          </div>
          {trip.items
            .filter((item) => categoryFilter === "ALL" || budgetCategoryForItem(item) === categoryFilter)
            .map((item) => (
              <ItineraryItemRow
                key={item.id}
                trip={trip}
                item={item}
                day={dayNumberFor(trip, item)}
                duration={formatDuration(item.startAt, item.endAt)}
                updateStatus={updateStatus}
                removeItem={removeItem}
                reload={reload}
              />
            ))}
          {trip.items.length === 0 && <p className="text-sm text-slate-500">No itinerary items yet.</p>}
          {trip.items.length > 0 && trip.items.filter((item) => categoryFilter === "ALL" || budgetCategoryForItem(item) === categoryFilter).length === 0 && (
            <p className="text-sm text-slate-500">No items in this category.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Shared across the header row and every item row so columns line up down
// the page. Wrapped in a horizontally-scrolling container (with a matching
// min-width) rather than letting columns wrap/shrink on narrow screens,
// since squeezing a 7-column table never stays legible.
const ITEM_ROW_GRID_COLS = "grid-cols-[3rem_8rem_minmax(0,1fr)_6rem_9rem_10rem_4.5rem]";
const ITEM_ROW_MIN_WIDTH = "min-w-[62rem]";

function ItineraryItemRow({
  trip,
  item,
  day,
  duration,
  updateStatus,
  removeItem,
  reload,
}: {
  trip: Trip;
  item: TripItem;
  day: number | null;
  duration: string | null;
  updateStatus: (itemId: string, s: BookingStatus) => void;
  removeItem: (itemId: string) => void;
  reload: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState(item.userNotes || "");
  const [saving, setSaving] = useState(false);
  const dirty = draft !== (item.userNotes || "");

  async function saveUserNotes() {
    setSaving(true);
    try {
      await api.patch(`/trips/${trip.id}/items/${item.id}`, { userNotes: draft.trim() || null });
      reload();
    } finally {
      setSaving(false);
    }
  }

  const hasNotes = !!(item.notes || item.userNotes);

  return (
    <Card className="p-4">
      <div className={`grid ${ITEM_ROW_GRID_COLS} gap-4 items-start`}>
        <div className="text-xs font-semibold text-slate-400 dark:text-slate-500 pt-0.5">
          {day != null ? `Day ${day}` : "—"}
        </div>
        <div className="pt-0.5">
          <Badge tone={CATEGORY_TONE[budgetCategoryForItem(item)]}>{categoryLabel(budgetCategoryForItem(item))}</Badge>
        </div>
        <div className="min-w-0">
          <div className="font-medium">{item.title}</div>
          <div className="text-xs text-slate-500">
            {item.provider && `${item.provider} · `}
            {item.location && `${item.location} · `}
            {item.startAt && formatItemTime(trip, item.startAt)}
            {item.endAt && ` → ${formatItemTime(trip, item.endAt)}`}
          </div>
          {item.confirmationNo && <div className="text-xs text-slate-400">Confirmation: {item.confirmationNo}</div>}
          {item.bookingAgent && <div className="text-xs text-slate-400">Via {item.bookingAgent.name}</div>}
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-brand-600 dark:text-brand-400 hover:underline mt-1"
          >
            {expanded ? "▲ Hide notes" : `▼ Notes${hasNotes ? " •" : ""}`}
          </button>
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 pt-0.5">
          {duration && `⏱ ${duration}`}
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400 pt-0.5">
          {item.cost != null &&
            (item.costPerNight != null && item.nights != null
              ? `${item.currency || "USD"} ${item.costPerNight}/night × ${item.nights} night${item.nights === 1 ? "" : "s"} = ${item.currency || "USD"} ${item.cost}`
              : `${item.currency || "USD"} ${item.cost}`)}
        </div>
        <div>
          <BadgeSelect
            value={item.bookingStatus}
            onChange={(s) => updateStatus(item.id, s)}
            tone={BOOKING_TONE[item.bookingStatus]}
            options={(["IDEA", "RESEARCHING", "READY_TO_BOOK", "BOOKED", "CONFIRMED", "CANCELLED"] as BookingStatus[]).map((s) => ({
              value: s,
              label: s.replace(/_/g, " "),
            }))}
          />
        </div>
        <div>
          <Button variant="danger" onClick={() => removeItem(item.id)}>Remove</Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div>
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">AI notes</div>
            {item.notes ? (
              <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-wrap">{item.notes}</p>
            ) : (
              <p className="text-sm text-slate-400 italic">None for this item.</p>
            )}
          </div>
          <div>
            <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Your notes</div>
            <Textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add your own notes — reservation details, reminders, anything the AI didn't cover…"
            />
            <div className="flex gap-2 mt-2">
              <Button onClick={saveUserNotes} disabled={saving || !dirty}>{saving ? "Saving…" : "Save"}</Button>
              {dirty && (
                <Button variant="secondary" onClick={() => setDraft(item.userNotes || "")}>Cancel</Button>
              )}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

const BUDGET_CATEGORIES = ["TRANSPORT", "FLIGHTS", "LODGING", "FOOD", "ACTIVITIES", "OTHER"] as const;

const CATEGORY_TONE: Record<(typeof BUDGET_CATEGORIES)[number], string> = {
  TRANSPORT: "blue",
  FLIGHTS: "indigo",
  LODGING: "purple",
  FOOD: "amber",
  ACTIVITIES: "green",
  OTHER: "slate",
};

const CATEGORY_EMOJI: Record<(typeof BUDGET_CATEGORIES)[number], string> = {
  TRANSPORT: "🚗",
  FLIGHTS: "✈️",
  LODGING: "🏨",
  FOOD: "🍽️",
  ACTIVITIES: "🎟️",
  OTHER: "📦",
};

function categoryLabel(cat: (typeof BUDGET_CATEGORIES)[number]): string {
  return `${CATEGORY_EMOJI[cat]} ${cat}`;
}

// Maps itinerary item types to the closest budget category, so AI/manual
// cost estimates on itinerary items can be folded into the budget totals
// without the user re-entering them by hand.
const ITEM_TYPE_TO_BUDGET_CATEGORY: Record<TripItemType, (typeof BUDGET_CATEGORIES)[number]> = {
  TRANSPORT: "TRANSPORT",
  STAY: "LODGING",
  POI: "ACTIVITIES",
  ACTIVITY: "ACTIVITIES",
  OTHER: "OTHER",
};

// Item type alone can't distinguish a meal or a flight from any other
// TRANSPORT/OTHER/ACTIVITY item, so a title match routes these to their own
// category regardless of what type the AI (or a manual add) tagged them with.
const FOOD_TITLE_PATTERN = /\b(meal|meals|breakfast|lunch|dinner|food)\b/i;
const FLIGHT_TITLE_PATTERN = /\b(flight|flights|airfare|airline)\b/i;

function budgetCategoryForItem(item: TripItem): (typeof BUDGET_CATEGORIES)[number] {
  if (FOOD_TITLE_PATTERN.test(item.title)) return "FOOD";
  if (item.type === "TRANSPORT" && FLIGHT_TITLE_PATTERN.test(item.title)) return "FLIGHTS";
  return ITEM_TYPE_TO_BUDGET_CATEGORY[item.type];
}

function BudgetTab({
  tripId,
  lines,
  items,
  reload,
}: {
  tripId: string;
  lines: BudgetLine[];
  items: TripItem[];
  reload: () => void;
}) {
  const [category, setCategory] = useState<(typeof BUDGET_CATEGORIES)[number]>("TRANSPORT");
  const [label, setLabel] = useState("");
  const [estimated, setEstimated] = useState("");
  const [actual, setActual] = useState("");

  const costedItems = items.filter((i) => i.cost != null);
  const itineraryTotal = costedItems.reduce((s, i) => s + (i.cost ?? 0), 0);
  const itineraryByCategory = new Map<(typeof BUDGET_CATEGORIES)[number], { total: number; count: number }>();
  for (const item of costedItems) {
    const cat = budgetCategoryForItem(item);
    const entry = itineraryByCategory.get(cat) || { total: 0, count: 0 };
    entry.total += item.cost ?? 0;
    entry.count += 1;
    itineraryByCategory.set(cat, entry);
  }

  const manualEstimated = lines.reduce((s, l) => s + l.estimated, 0);
  const totalEstimated = manualEstimated + itineraryTotal;
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
          <div className="text-xs text-slate-400 mt-1">
            ${itineraryTotal.toFixed(2)} from itinerary items + ${manualEstimated.toFixed(2)} manual
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-slate-500">Total actual</div>
          <div className="text-2xl font-semibold">${totalActual.toFixed(2)}</div>
          <div className="text-xs text-slate-400 mt-1">From manual budget lines only</div>
        </Card>
      </div>

      {costedItems.length > 0 && (
        <Card className="p-5 mb-6">
          <h2 className="font-semibold mb-1">From itinerary items</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
            Automatically totaled from cost estimates on this trip's {costedItems.length} costed item(s) — updates whenever the itinerary changes, no manual entry needed.
          </p>
          <div className="space-y-2">
            {[...itineraryByCategory.entries()].map(([cat, { total, count }]) => (
              <div key={cat} className="flex items-center gap-4 text-sm">
                <Badge tone={CATEGORY_TONE[cat]}>{categoryLabel(cat)}</Badge>
                <div className="flex-1 text-slate-500 dark:text-slate-400">
                  {count} item{count === 1 ? "" : "s"}
                </div>
                <div className="font-medium">${total.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-5 mb-6">
        <form onSubmit={addLine} className="grid grid-cols-4 gap-4 items-end">
          <div>
            <Label>Category</Label>
            <Select value={category} onChange={(e) => setCategory(e.target.value as any)}>
              {BUDGET_CATEGORIES.map((c) => <option key={c} value={c}>{categoryLabel(c)}</option>)}
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

      <h2 className="font-semibold mb-2">Manual budget lines</h2>
      <div className="space-y-2">
        {lines.map((l) => (
          <Card key={l.id} className="p-3 flex items-center gap-4">
            <Badge tone={CATEGORY_TONE[l.category]}>{categoryLabel(l.category)}</Badge>
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
