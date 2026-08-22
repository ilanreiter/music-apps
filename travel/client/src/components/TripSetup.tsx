import React, { useRef, useState } from "react";
import { api } from "../lib/api";
import { ProposedItem, ProposedItinerary, Trip, TripGoal, TripItemType, TripPlanningType } from "../types";
import { Badge, Button, Card, Input, Label, Select, Textarea } from "../components/ui";
import { DownloadIcon, PencilIcon, SparklesIcon } from "../components/icons";

const GOAL_LABEL: Record<TripGoal, string> = {
  NATURE: "Nature",
  SIGHTSEEING: "Sightseeing",
  CITY: "City",
  RELAXATION: "Relaxation",
  ADVENTURE: "Adventure",
  MIXED: "Mixed",
  OTHER: "Other",
};

const PLANNING_LABEL: Record<TripPlanningType, string> = {
  SELF_PLANNED: "Self-planned",
  GROUP: "Group trip",
  ORGANIZED: "Organized/tour",
};

const TYPE_TONE: Record<TripItemType, string> = {
  TRANSPORT: "blue",
  STAY: "purple",
  POI: "green",
  ACTIVITY: "amber",
  OTHER: "slate",
};

function TripBasics({ trip, reload }: { trip: Trip; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [datesKnown, setDatesKnown] = useState(!!trip.startDate);
  const [startDate, setStartDate] = useState(trip.startDate ? trip.startDate.slice(0, 10) : "");
  const [endDate, setEndDate] = useState(trip.endDate ? trip.endDate.slice(0, 10) : "");
  const [durationNights, setDurationNights] = useState(trip.durationNights ? String(trip.durationNights) : "");
  const [travelSeason, setTravelSeason] = useState(trip.travelSeason || "");
  const [planningType, setPlanningType] = useState<TripPlanningType>(trip.planningType || "SELF_PLANNED");
  const [goal, setGoal] = useState<TripGoal>(trip.goal || "MIXED");
  const [goalDetail, setGoalDetail] = useState(trip.goalDetail || "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    await api.patch(`/trips/${trip.id}`, {
      startDate: datesKnown && startDate ? new Date(startDate).toISOString() : null,
      endDate: datesKnown && endDate ? new Date(endDate).toISOString() : null,
      durationNights: durationNights ? parseInt(durationNights, 10) : null,
      travelSeason: travelSeason || null,
      planningType,
      goal,
      goalDetail: goalDetail || null,
    });
    setEditing(false);
    reload();
  }

  if (!editing) {
    return (
      <Card className="p-4 mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="text-sm text-slate-600 dark:text-slate-300">
            {trip.startDate
              ? `${new Date(trip.startDate).toLocaleDateString()} — ${trip.endDate ? new Date(trip.endDate).toLocaleDateString() : "?"}`
              : trip.durationNights
              ? `${trip.durationNights} night(s)${trip.travelSeason ? ` · ${trip.travelSeason}` : ""}`
              : "Dates not set"}
          </div>
          {trip.goal && <Badge tone="green">{GOAL_LABEL[trip.goal]}</Badge>}
          {trip.planningType && <Badge>{PLANNING_LABEL[trip.planningType]}</Badge>}
          <Button variant="ghost" className="ml-auto" onClick={() => setEditing(true)}>Edit trip basics</Button>
        </div>
        {trip.goalDetail && (
          <div className="text-sm text-slate-500 dark:text-slate-400 mt-2 italic">"{trip.goalDetail}"</div>
        )}
      </Card>
    );
  }

  return (
    <Card className="p-5 mb-6">
      <form onSubmit={save} className="grid grid-cols-2 gap-4">
        <div className="col-span-2 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" id="dk" checked={datesKnown} onChange={(e) => setDatesKnown(e.target.checked)} className="rounded" />
          <label htmlFor="dk">I know the exact dates</label>
        </div>
        {datesKnown ? (
          <>
            <div>
              <Label>Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>End date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </>
        ) : (
          <>
            <div>
              <Label>How many nights?</Label>
              <Input type="number" min={1} value={durationNights} onChange={(e) => setDurationNights(e.target.value)} />
            </div>
            <div>
              <Label>Time of year</Label>
              <Input value={travelSeason} onChange={(e) => setTravelSeason(e.target.value)} placeholder="e.g. Late spring" />
            </div>
          </>
        )}
        <div>
          <Label>Planning type</Label>
          <Select value={planningType} onChange={(e) => setPlanningType(e.target.value as TripPlanningType)}>
            {(Object.keys(PLANNING_LABEL) as TripPlanningType[]).map((p) => <option key={p} value={p}>{PLANNING_LABEL[p]}</option>)}
          </Select>
        </div>
        <div>
          <Label>Trip goal / style</Label>
          <Select value={goal} onChange={(e) => setGoal(e.target.value as TripGoal)}>
            {(Object.keys(GOAL_LABEL) as TripGoal[]).map((g) => <option key={g} value={g}>{GOAL_LABEL[g]}</option>)}
          </Select>
        </div>
        <div className="col-span-2">
          <Label>What's this trip actually about? (optional)</Label>
          <Textarea
            rows={2}
            value={goalDetail}
            onChange={(e) => setGoalDetail(e.target.value)}
            placeholder="e.g. watching bird migration, relaxing near the beach, celebrating an anniversary…"
          />
          <p className="text-xs text-slate-400 mt-1">This is what the AI itinerary proposal weighs most heavily — more useful than the category above.</p>
        </div>
        <div className="col-span-2 flex gap-2">
          <Button type="submit">Save</Button>
          <Button type="button" variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </form>
    </Card>
  );
}

function BuildItinerary({ trip, reload, onDismiss }: { trip: Trip; reload: () => void; onDismiss: () => void }) {
  const [mode, setMode] = useState<"choose" | "import" | "propose">("choose");
  const [pastedText, setPastedText] = useState("");
  const [extraNotes, setExtraNotes] = useState("");
  const [proposal, setProposal] = useState<ProposedItinerary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPastedText((prev) => (prev ? prev + "\n\n" : "") + String(reader.result || ""));
    reader.readAsText(file);
  }

  async function runImport() {
    if (!pastedText.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<ProposedItinerary>(`/trips/${trip.id}/import-itinerary`, { rawText: pastedText });
      setProposal(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runPropose() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<ProposedItinerary>(`/trips/${trip.id}/propose-itinerary`, { extraNotes });
      setProposal(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyProposal(items: ProposedItem[]) {
    await api.post(`/trips/${trip.id}/items/bulk`, { items });
    setProposal(null);
    setMode("choose");
    reload();
  }

  if (proposal) {
    return (
      <ProposalReviewWrapper
        proposal={proposal}
        onApplied={applyProposal}
        onDiscard={() => setProposal(null)}
      />
    );
  }

  return (
    <Card className="p-5 mb-6">
      <h2 className="font-semibold mb-1">Build your itinerary</h2>
      <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
        No itinerary items yet — start from scratch, bring in a plan you already have, or let Claude propose one.
      </p>

      {mode === "choose" && (
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={onDismiss}
            className="text-left p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-brand-400 transition-colors"
          >
            <div className="font-medium mb-1 flex items-center gap-1.5"><PencilIcon className="h-4 w-4 text-brand-600 dark:text-brand-400" /> Start from scratch</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Add transport, stays and POIs one at a time below.</div>
          </button>
          <button
            onClick={() => setMode("import")}
            className="text-left p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-brand-400 transition-colors"
          >
            <div className="font-medium mb-1 flex items-center gap-1.5"><DownloadIcon className="h-4 w-4 text-brand-600 dark:text-brand-400" /> Import existing itinerary</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Paste text (or a booking/confirmation email), or upload a file — Claude will structure it.</div>
          </button>
          <button
            onClick={() => setMode("propose")}
            className="text-left p-4 rounded-lg border border-slate-200 dark:border-slate-700 hover:border-brand-400 transition-colors"
          >
            <div className="font-medium mb-1 flex items-center gap-1.5"><SparklesIcon className="h-4 w-4 text-brand-600 dark:text-brand-400" /> Propose with AI</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">Claude drafts a day-by-day plan from your trip goal and saved preferences.</div>
          </button>
        </div>
      )}

      {mode === "import" && (
        <div>
          <Label>Paste itinerary text or an email you received</Label>
          <Textarea rows={6} value={pastedText} onChange={(e) => setPastedText(e.target.value)} placeholder="Paste booking confirmations, an itinerary from an agent, or an email here…" />
          <div className="flex items-center gap-3 mt-2">
            <input ref={fileInputRef} type="file" accept=".txt,.md,.eml,text/plain" onChange={onFileChosen} className="text-xs" />
          </div>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-4">
            <Button onClick={runImport} disabled={busy || !pastedText.trim()}>{busy ? "Parsing…" : "Parse itinerary"}</Button>
            <Button variant="secondary" onClick={() => setMode("choose")}>Back</Button>
          </div>
        </div>
      )}

      {mode === "propose" && (
        <div>
          <Label>Anything else Claude should know? (optional)</Label>
          <Textarea rows={3} value={extraNotes} onChange={(e) => setExtraNotes(e.target.value)} placeholder="e.g. we want one slow day, avoid early mornings, traveling with a toddler…" />
          <p className="text-xs text-slate-400 mt-2">
            Uses this trip's goal/dates and your saved travel preferences. Edit those on the Preferences page anytime.
          </p>
          {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
          <div className="flex gap-2 mt-4">
            <Button onClick={runPropose} disabled={busy}>{busy ? "Thinking…" : "Generate proposal"}</Button>
            <Button variant="secondary" onClick={() => setMode("choose")}>Back</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function ProposalReviewWrapper({
  proposal,
  onApplied,
  onDiscard,
}: {
  proposal: ProposedItinerary;
  onApplied: (items: ProposedItem[]) => void;
  onDiscard: () => void;
}) {
  const [included, setIncluded] = useState<boolean[]>(proposal.items.map(() => true));
  const [busy, setBusy] = useState(false);

  function toggle(i: number) {
    setIncluded((arr) => arr.map((v, idx) => (idx === i ? !v : v)));
  }

  async function apply() {
    setBusy(true);
    try {
      await onApplied(proposal.items.filter((_, i) => included[i]));
    } finally {
      setBusy(false);
    }
  }

  const byDay = new Map<number, { item: ProposedItem; index: number }[]>();
  proposal.items.forEach((item, index) => {
    const list = byDay.get(item.day) || [];
    list.push({ item, index });
    byDay.set(item.day, list);
  });
  const count = included.filter(Boolean).length;

  return (
    <Card className="p-5 mb-6">
      <h2 className="font-semibold mb-2">Proposed itinerary</h2>
      {proposal.summary && <p className="text-sm text-slate-600 dark:text-slate-300 mb-4">{proposal.summary}</p>}
      <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
        {[...byDay.entries()].sort(([a], [b]) => a - b).map(([day, entries]) => (
          <div key={day}>
            <div className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">Day {day}</div>
            <div className="space-y-1">
              {entries.map(({ item, index }) => (
                <label key={index} className="flex items-start gap-2 text-sm p-2 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/60 cursor-pointer">
                  <input type="checkbox" checked={included[index]} onChange={() => toggle(index)} className="mt-1 rounded" />
                  <span className="flex-1">
                    <Badge tone={TYPE_TONE[item.type]}>{item.type}</Badge>{" "}
                    <span className="font-medium">{item.title}</span>
                    {item.time && <span className="text-slate-400"> · {item.time}</span>}
                    {item.location && <span className="text-slate-400"> · {item.location}</span>}
                    {item.estimatedCost != null && <span className="text-slate-400"> · ~${item.estimatedCost}</span>}
                    {item.notes && <div className="text-xs text-slate-400 mt-0.5">{item.notes}</div>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
        {proposal.items.length === 0 && <p className="text-sm text-slate-500">Nothing was extracted — try adding more detail.</p>}
      </div>
      <div className="flex gap-2 mt-4 pt-3 border-t border-slate-200 dark:border-slate-800">
        <Button onClick={apply} disabled={busy || count === 0}>{busy ? "Adding…" : `Add ${count} item(s) to itinerary`}</Button>
        <Button variant="secondary" onClick={onDiscard}>Discard</Button>
      </div>
    </Card>
  );
}

export default function TripSetup({ trip, reload }: { trip: Trip; reload: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  return (
    <div>
      <TripBasics trip={trip} reload={reload} />
      {trip.items.length === 0 && !dismissed && (
        <BuildItinerary trip={trip} reload={reload} onDismiss={() => setDismissed(true)} />
      )}
    </div>
  );
}
