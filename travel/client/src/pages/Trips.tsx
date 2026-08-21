import React, { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Destination, Trip } from "../types";
import { Badge, Button, Card, Input, Label, PageHeader, Select } from "../components/ui";

const STATUS_TONE: Record<string, string> = {
  DRAFT: "slate",
  PLANNING: "amber",
  BOOKED: "purple",
  IN_PROGRESS: "blue",
  COMPLETED: "green",
  CANCELLED: "red",
};

export default function Trips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
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
      startDate: startDate ? new Date(startDate).toISOString() : null,
      endDate: endDate ? new Date(endDate).toISOString() : null,
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
            <div>
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div>
              <Label>Destination</Label>
              <Select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                <option value="">— none —</option>
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </div>
            <div>
              <Label>Start date</Label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label>End date</Label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
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
                {t.startDate ? new Date(t.startDate).toLocaleDateString() : "?"} —{" "}
                {t.endDate ? new Date(t.endDate).toLocaleDateString() : "?"}
              </div>
              <div className="text-xs text-slate-400 mt-1">{t._count?.items ?? 0} planned item(s)</div>
            </Card>
          </Link>
        ))}
        {trips.length === 0 && <p className="text-sm text-slate-500">No trips yet.</p>}
      </div>
    </div>
  );
}
