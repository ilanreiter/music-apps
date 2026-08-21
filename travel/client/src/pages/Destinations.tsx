import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Destination, DestinationStatus } from "../types";
import { Badge, Button, Card, Input, Label, PageHeader, Select, Textarea } from "../components/ui";

const STATUS_TONE: Record<DestinationStatus, string> = {
  IDEA: "slate",
  RESEARCHING: "amber",
  PLANNED: "blue",
  BOOKED: "purple",
  VISITED: "green",
  ARCHIVED: "slate",
};

export default function Destinations() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [country, setCountry] = useState("");
  const [status, setStatus] = useState<DestinationStatus>("IDEA");
  const [notes, setNotes] = useState("");
  const navigate = useNavigate();

  function load() {
    api.get<Destination[]>("/destinations").then(setDestinations).catch(() => {});
  }

  useEffect(load, []);

  async function addDestination(e: React.FormEvent) {
    e.preventDefault();
    await api.post("/destinations", { name, country, status, notes });
    setName("");
    setCountry("");
    setNotes("");
    setStatus("IDEA");
    setShowForm(false);
    load();
  }

  async function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= destinations.length) return;
    const reordered = [...destinations];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    setDestinations(reordered);
    await api.post(
      "/destinations/reorder",
      reordered.map((d, i) => ({ id: d.id, priority: i }))
    );
  }

  async function setDestStatus(id: string, s: DestinationStatus) {
    await api.patch(`/destinations/${id}`, { status: s });
    load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this destination?")) return;
    await api.delete(`/destinations/${id}`);
    load();
  }

  async function startTrip(d: Destination) {
    const trip = await api.post<{ id: string }>("/trips", { title: `Trip to ${d.name}`, destinationId: d.id, status: "PLANNING" });
    navigate(`/trips/${trip.id}`);
  }

  return (
    <div>
      <PageHeader
        title="Destinations"
        subtitle="Your prioritized wishlist — reorder to reflect what's next"
        actions={<Button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "+ Add destination"}</Button>}
      />

      {showForm && (
        <Card className="p-5 mb-6">
          <form onSubmit={addDestination} className="grid grid-cols-2 gap-4">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <Label>Country</Label>
              <Input value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
            <div>
              <Label>Status</Label>
              <Select value={status} onChange={(e) => setStatus(e.target.value as DestinationStatus)}>
                {Object.keys(STATUS_TONE).map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
            <div className="col-span-2">
              <Button type="submit">Save destination</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="space-y-3">
        {destinations.map((d, i) => (
          <Card key={d.id} className="p-4 flex items-center gap-4">
            <div className="flex flex-col gap-1">
              <button onClick={() => move(i, -1)} disabled={i === 0} className="text-slate-400 hover:text-slate-700 disabled:opacity-30">▲</button>
              <button onClick={() => move(i, 1)} disabled={i === destinations.length - 1} className="text-slate-400 hover:text-slate-700 disabled:opacity-30">▼</button>
            </div>
            <div className="w-8 text-center text-slate-400 font-mono">#{i + 1}</div>
            <div className="flex-1">
              <div className="font-medium">{d.name}</div>
              <div className="text-xs text-slate-500">{d.country}{d.bestSeason ? ` · Best: ${d.bestSeason}` : ""}</div>
              {d.notes && <div className="text-xs text-slate-400 mt-1">{d.notes}</div>}
              {d.tags?.length > 0 && (
                <div className="flex gap-1 mt-1">
                  {d.tags.map((t) => <Badge key={t}>{t}</Badge>)}
                </div>
              )}
            </div>
            <Select
              value={d.status}
              onChange={(e) => setDestStatus(d.id, e.target.value as DestinationStatus)}
              className="w-40"
            >
              {Object.keys(STATUS_TONE).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </Select>
            <Badge tone={STATUS_TONE[d.status]}>{d._count?.trips ?? 0} trip(s)</Badge>
            <Button variant="secondary" onClick={() => startTrip(d)}>Plan trip</Button>
            <Button variant="danger" onClick={() => remove(d.id)}>Delete</Button>
          </Card>
        ))}
        {destinations.length === 0 && <p className="text-sm text-slate-500">No destinations yet.</p>}
      </div>
    </div>
  );
}
