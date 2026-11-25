import React from "react";
import { lazyWithReload, LazyBoundary } from "../../lib/lazyReload";
import { AlertTriangle, BookOpen, CalendarClock, CheckSquare, ExternalLink, MapPin, Plane, Wallet } from "lucide-react";
import type { MapPoint } from "../RouteMap";
import ResourceThumb from "../ResourceThumb";
import { Trip } from "../../types";
import { Badge, Card } from "../ui";
import { daysFromNow, isBookable, isBooked, money, shortDate } from "./shared";

const RouteMap = lazyWithReload(() => import("../RouteMap"));

export type PlanTab = "Overview" | "Itinerary" | "Schedule" | "Bookings" | "Checklist" | "Route" | "Budget" | "Resources";

/** Readiness at a glance: countdown, what's booked, what's due, and a place to keep key trip information. */
export default function OverviewTab({ trip, goTo, onImportBookings, mapPoints = [] }: { trip: Trip; goTo: (t: PlanTab) => void; onImportBookings?: () => void; mapPoints?: MapPoint[] }) {
  const bookable = trip.items.filter(isBookable);
  const booked = bookable.filter(isBooked);
  const todo = bookable.filter((i) => !isBooked(i) && i.bookingStatus !== "CANCELLED");
  const check = trip.checklist ?? [];
  const checkDone = check.filter((c) => c.done).length;
  const bookedCost = booked.reduce((t, i) => t + (i.cost ?? 0), 0);
  const estimated = trip.budgetLines.reduce((t, l) => t + l.estimated, 0);

  const deadlines = [
    ...booked.filter((i) => i.freeCancelUntil && daysFromNow(i.freeCancelUntil) >= 0).map((i) => ({ at: i.freeCancelUntil!, text: `Free cancellation ends: ${i.title}`, go: "Bookings" as PlanTab })),
    ...check.filter((c) => !c.done && c.dueDate).map((c) => ({ at: c.dueDate!, text: c.text, go: "Checklist" as PlanTab })),
  ].sort((a, b) => a.at.localeCompare(b.at)).slice(0, 8);

  const days = trip.startDate ? daysFromNow(trip.startDate) : null;
  const steps: { text: string; cta: string; go: PlanTab; action?: () => void }[] = [];
  if (!trip.items.length) steps.push({ text: "Build the itinerary: let the AI propose one, paste an existing plan, or import places from Google Maps.", cta: "Itinerary", go: "Itinerary" });
  if (!bookable.length) steps.push({ text: "Add the bookings you already have, e.g. paste a confirmation email.", cta: "Bookings", go: "Bookings" });
  else if (todo.length) steps.push({ text: `${todo.length} item${todo.length === 1 ? " is" : "s are"} not booked yet.`, cta: "Bookings", go: "Bookings" });
  if (!check.length) steps.push({ text: "Get a checklist (visa, insurance, packing) tailored to your traveler profiles.", cta: "Checklist", go: "Checklist" });
  else if (check.some((c) => !c.done && c.dueDate && daysFromNow(c.dueDate) < 0)) steps.push({ text: "Some checklist tasks are overdue.", cta: "Checklist", go: "Checklist" });
  if (bookable.length && onImportBookings) steps.push({ text: "Have another confirmation (another traveler, a hotel, a tour)? Import it.", cta: "Import", go: "Bookings", action: onImportBookings });
  if (trip.items.length) steps.push({ text: "Review the day-by-day schedule for gaps and overlaps.", cta: "Schedule", go: "Schedule" });

  return (
    <div className="space-y-4">
      {!trip.startDate && (
        <Card className="p-4 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[14rem] flex-1 text-sm">
              <div className="font-medium text-amber-800 dark:text-amber-300">This trip has no dates yet</div>
              <div className="text-xs text-amber-700 dark:text-amber-400">Import your flight or hotel confirmation (paste, PDF or .eml) to fill in the real dates and update the itinerary, or set the dates yourself under “Edit trip basics”.</div>
            </div>
            {onImportBookings && <button type="button" onClick={onImportBookings} className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Import booking email / PDF</button>}
          </div>
        </Card>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <Tile icon={CalendarClock} label="Departure" value={days == null ? "Dates not set" : days > 0 ? `In ${days} day${days === 1 ? "" : "s"}` : days === 0 ? "Today" : "Underway / past"} sub={trip.startDate ? shortDate(trip.startDate) : undefined} />
        <Tile icon={Plane} label="Bookings" value={`${booked.length} of ${bookable.length} booked`} sub={todo.length ? `${todo.length} still to book` : bookable.length ? "All booked" : undefined} onClick={() => goTo("Bookings")} />
        <Tile icon={CheckSquare} label="Checklist" value={check.length ? `${checkDone} of ${check.length} done` : "No tasks yet"} sub={check.length ? `${Math.round((checkDone / check.length) * 100)}% ready` : "Suggest a list with AI"} onClick={() => goTo("Checklist")} />
        <Tile icon={Wallet} label="Money" value={money(bookedCost)} sub={estimated ? `booked · ${money(estimated)} budgeted` : "booked so far"} onClick={() => goTo("Budget")} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold">Coming up</h3>
          {!deadlines.length ? <p className="text-sm text-slate-500">No deadlines yet. Free-cancellation dates and checklist due dates show up here.</p> : (
            <ul className="space-y-1.5 text-sm">
              {deadlines.map((d, n) => {
                const left = daysFromNow(d.at);
                return (
                  <li key={n}>
                    <button type="button" onClick={() => goTo(d.go)} className="flex w-full items-center gap-2 text-left hover:text-brand-600">
                      <span className="w-24 shrink-0 text-xs tabular-nums text-slate-500">{shortDate(d.at)}</span>
                      <span className="flex-1 truncate">{d.text}</span>
                      <Badge tone={left < 0 ? "red" : left <= 7 ? "amber" : "slate"}>{left < 0 ? "overdue" : left === 0 ? "today" : `${left}d`}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {todo.length > 0 && (
            <div className="mt-3 border-t border-slate-100 dark:border-slate-800 pt-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-amber-600"><AlertTriangle className="h-3.5 w-3.5" />Still to book</div>
              <ul className="space-y-0.5 text-sm text-slate-600 dark:text-slate-300">{todo.slice(0, 6).map((i) => <li key={i.id} className="truncate">{i.title}</li>)}{todo.length > 6 && <li className="text-xs text-slate-400">+{todo.length - 6} more</li>}</ul>
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-2 text-sm font-semibold">Next steps</h3>
          <ul className="space-y-2 text-sm">
            {steps.length === 0 && <li className="text-slate-500">Everything is in place. Keep an eye on the deadlines on the left.</li>}
            {steps.map((s) => (
              <li key={s.text} className="flex items-center gap-3">
                <span className="flex-1">{s.text}</span>
                <button type="button" onClick={() => (s.action ? s.action() : goTo(s.go))} className="shrink-0 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs hover:border-brand-400 hover:text-brand-600">{s.cta}</button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold"><MapPin className="h-4 w-4" />Map</h3>
            <button type="button" onClick={() => goTo("Route")} className="text-xs text-brand-600 hover:underline">Open route</button>
          </div>
          {mapPoints.length === 0 ? (
            <p className="text-sm text-slate-500">No places with map locations yet. Add stays and activities, then fill in map locations on the Route tab.</p>
          ) : (
            <LazyBoundary label="The map couldn’t load."><React.Suspense fallback={<div className="flex h-[260px] items-center justify-center text-sm text-slate-400">Loading map…</div>}>
              <RouteMap points={mapPoints} height={260} />
            </React.Suspense></LazyBoundary>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold"><BookOpen className="h-4 w-4" />Resources</h3>
            <button type="button" onClick={() => goTo("Resources")} className="text-xs text-brand-600 hover:underline">{(trip.resources ?? []).length ? `See all ${(trip.resources ?? []).length}` : "Add"}</button>
          </div>
          {!(trip.resources ?? []).length ? <p className="text-sm text-slate-500">No guides or links yet. Use Import to file a web page or document here.</p> : (
            <ul className="space-y-2">
              {(trip.resources ?? []).slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center gap-3">
                  <ResourceThumb src={r.imageUrl} className="!h-12 !w-16" />
                  <div className="min-w-0 flex-1 text-sm">
                    {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-brand-600 hover:underline"><span className="truncate">{r.title}</span><ExternalLink className="h-3 w-3 shrink-0" /></a> : <span className="block truncate">{r.title}</span>}
                    {r.category && <div className="text-xs text-slate-500">{r.category}</div>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function Tile({ icon: Icon, label, value, sub, onClick }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; sub?: string; onClick?: () => void }) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-xs text-slate-500"><Icon className="h-3.5 w-3.5" />{label}</div>
      <div className="mt-1 text-lg font-display font-semibold leading-tight">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </>
  );
  return onClick
    ? <button type="button" onClick={onClick} className="text-left"><Card className="p-3 h-full transition-colors hover:border-brand-400">{body}</Card></button>
    : <Card className="p-3 h-full">{body}</Card>;
}
