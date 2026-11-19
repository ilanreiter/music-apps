import { AlertTriangle } from "lucide-react";
import { Conflict, Trip, TripItem } from "../../types";
import { Badge, Card } from "../ui";
import { BOOKING_STATUSES, BOOKING_TONE } from "./shared";

const label = (s: string) => BOOKING_STATUSES.find((x) => x.value === s)?.label ?? s;

/** Day-by-day agenda built from the itinerary and bookings. Undated trips use "Day N" (item times are stored against a placeholder date). */
export default function ScheduleTab({ trip, conflicts }: { trip: Trip; conflicts: Conflict[] }) {
  const undated = !trip.startDate;
  const dayKey = (iso: string) => (undated ? iso.slice(0, 10) : new Date(iso).toLocaleDateString("en-CA"));
  const timeOf = (iso: string) => {
    const d = new Date(iso);
    const h = undated ? d.getUTCHours() : d.getHours(), m = undated ? d.getUTCMinutes() : d.getMinutes();
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  };
  const clash = new Set(conflicts.flatMap((c) => [c.itemAId, c.itemBId]));
  const dated = trip.items.filter((i) => i.startAt);
  const undatedItems = trip.items.filter((i) => !i.startAt);
  const days = new Map<string, TripItem[]>();
  for (const i of dated.slice().sort((a, b) => a.startAt!.localeCompare(b.startAt!))) days.set(dayKey(i.startAt!), [...(days.get(dayKey(i.startAt!)) ?? []), i]);
  const keys = [...days.keys()].sort();
  const first = keys[0] ? new Date(keys[0] + "T12:00:00").getTime() : 0;
  const dayNo = (k: string) => Math.round((new Date(k + "T12:00:00").getTime() - first) / 86_400_000) + 1;

  if (!trip.items.length) return <Card className="p-8 text-center text-sm text-slate-500">The schedule fills in as you add itinerary items and bookings.</Card>;

  return (
    <div className="space-y-4">
      {conflicts.length > 0 && <p className="flex items-center gap-1.5 text-sm text-red-600"><AlertTriangle className="h-4 w-4" />{conflicts.length} scheduling conflict{conflicts.length === 1 ? "" : "s"}: the overlapping items are marked in red.</p>}
      {keys.map((k) => (
        <Card key={k} className="p-4">
          <h3 className="mb-2 text-sm font-semibold">
            Day {dayNo(k)}{!undated && <span className="ml-2 font-normal text-slate-500">{new Date(k + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</span>}
          </h3>
          <ul className="space-y-1.5">
            {days.get(k)!.map((i) => (
              <li key={i.id} className={`flex items-start gap-3 rounded-md px-2 py-1.5 text-sm ${clash.has(i.id) ? "bg-red-50 dark:bg-red-950/30" : ""}`}>
                <span className="w-20 shrink-0 tabular-nums text-xs text-slate-500 pt-0.5">{timeOf(i.startAt!)}{i.endAt ? <><br /><span className="text-slate-400">→ {timeOf(i.endAt)}</span></> : null}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{i.title}</div>
                  <div className="text-xs text-slate-500">{[i.type[0] + i.type.slice(1).toLowerCase(), i.provider, i.location, i.confirmationNo && `ref ${i.confirmationNo}`].filter(Boolean).join(" · ")}</div>
                </div>
                {i.type !== "POI" && <Badge tone={BOOKING_TONE[i.bookingStatus]}>{label(i.bookingStatus)}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {undatedItems.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold">Not scheduled yet <span className="font-normal text-slate-400">· {undatedItems.length}</span></h3>
          <ul className="space-y-1 text-sm">{undatedItems.map((i) => <li key={i.id} className="flex items-center gap-2"><span className="flex-1">{i.title}</span>{i.type !== "POI" && <Badge tone={BOOKING_TONE[i.bookingStatus]}>{label(i.bookingStatus)}</Badge>}</li>)}</ul>
        </Card>
      )}
    </div>
  );
}
