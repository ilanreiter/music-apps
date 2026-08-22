import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Destination, Trip, TripGoal, TripPlanningType } from "../types";
import { Badge, Button, Card, Input, Label, PageHeader, Select, Textarea } from "../components/ui";

const STATUS_TONE: Record<string, string> = {
  DRAFT: "slate",
  PLANNING: "amber",
  BOOKED: "purple",
  IN_PROGRESS: "blue",
  COMPLETED: "green",
  CANCELLED: "red",
};

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

export default function Trips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [datesKnown, setDatesKnown] = useState(true);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [durationNights, setDurationNights] = useState("");
  const [travelSeason, setTravelSeason] = useState("");
  const [planningType, setPlanningType] = useState<TripPlanningType>("SELF_PLANNED");
  const [goal, setGoal] = useState<TripGoal>("MIXED");
  const [goalDetail, setGoalDetail] = useState("");
  const navigate = useNavigate();

  function load() {
    api.get<Trip[]>("/trips").then(setTrips).catch(() => {});
  }

  useEffect(() => {
    load();
    api.get<Destination[]>("/destinations").then(setDestinations).catch(() => {});
  }, []);

  async function createTrip(e: React.FormEvent) {
    e.preventDefault();
    const trip = await api.post<Trip>("/trips", {
      title,
      destinationId: destinationId || null,
      startDate: datesKnown && startDate ? new Date(startDate).toISOString() : null,
      endDate: datesKnown && endDate ? new Date(endDate).toISOString() : null,
      durationNights: durationNights ? parseInt(durationNights, 10) : null,
      travelSeason: travelSeason || null,
      planningType,
      goal,
      goalDetail: goalDetail || null,
    });
    navigate(`/trips/${trip.id}`);
  }

  return (
    <div>
      <PageHeader
        title="Trips"
        subtitle="Plan the details for each journey"
        actions={<Button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "+ New trip"}</Button>}
      />

      {showForm && (
        <Card className="p-5 mb-6">
          <form onSubmit={createTrip} className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="col-span-2">
              <Label>Destination</Label>
              <Select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                <option value="">— none —</option>
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </div>

            <div className="col-span-2 flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 -mb-1">
              <input
                type="checkbox"
                id="datesKnown"
                checked={datesKnown}
                onChange={(e) => setDatesKnown(e.target.checked)}
                className="rounded"
              />
              <label htmlFor="datesKnown">I know the exact dates</label>
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
                  <Input
                    type="number"
                    min={1}
                    value={durationNights}
                    onChange={(e) => setDurationNights(e.target.value)}
                    placeholder="e.g. 7"
                  />
                </div>
                <div>
                  <Label>Time of year</Label>
                  <Input
                    value={travelSeason}
                    onChange={(e) => setTravelSeason(e.target.value)}
                    placeholder="e.g. Late spring, or June 2027"
                  />
                </div>
              </>
            )}

            <div>
              <Label>Planning type</Label>
              <Select value={planningType} onChange={(e) => setPlanningType(e.target.value as TripPlanningType)}>
                {(Object.keys(PLANNING_LABEL) as TripPlanningType[]).map((p) => (
                  <option key={p} value={p}>{PLANNING_LABEL[p]}</option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Trip goal / style</Label>
              <Select value={goal} onChange={(e) => setGoal(e.target.value as TripGoal)}>
                {(Object.keys(GOAL_LABEL) as TripGoal[]).map((g) => (
                  <option key={g} value={g}>{GOAL_LABEL[g]}</option>
                ))}
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
            </div>

            <div className="col-span-2">
              <Button type="submit">Create trip</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {trips.map((t) => (
          <Link key={t.id} to={`/trips/${t.id}`}>
            <Card className="p-4 hover:border-brand-400 transition-colors">
              <div className="flex items-center justify-between mb-1">
                <div className="font-medium">{t.title}</div>
                <Badge tone={STATUS_TONE[t.status]}>{t.status}</Badge>
              </div>
              <div className="text-xs text-slate-500">{t.destination?.name || "No destination linked"}</div>
              <div className="text-xs text-slate-400 mt-1">
                {t.startDate
                  ? `${new Date(t.startDate).toLocaleDateString()} — ${t.endDate ? new Date(t.endDate).toLocaleDateString() : "?"}`
                  : t.durationNights
                  ? `${t.durationNights} night(s)${t.travelSeason ? ` · ${t.travelSeason}` : ""}`
                  : "Dates not set yet"}
              </div>
              <div className="flex gap-1 mt-2">
                {t.goal && <Badge tone="green">{GOAL_LABEL[t.goal]}</Badge>}
                {t.planningType && <Badge>{PLANNING_LABEL[t.planningType]}</Badge>}
              </div>
              {t.goalDetail && <div className="text-xs text-slate-400 italic mt-1 line-clamp-1">"{t.goalDetail}"</div>}
              <div className="text-xs text-slate-400 mt-2">{t._count?.items ?? 0} planned item(s)</div>
            </Card>
          </Link>
        ))}
        {trips.length === 0 && <p className="text-sm text-slate-500">No trips yet.</p>}
      </div>
    </div>
  );
}
