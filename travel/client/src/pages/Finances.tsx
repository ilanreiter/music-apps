import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Destination, Trip } from "../types";
import { Badge, Button, Card, Input, Label, PageHeader, Select } from "../components/ui";

interface Estimate {
  currency: string;
  flights: number;
  lodging: number;
  food: number;
  activities: number;
  localTransport: number;
  misc: number;
  total: number;
  notes: string;
}

export default function Finances() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [destinationName, setDestinationName] = useState("");
  const [travelers, setTravelers] = useState(2);
  const [nights, setNights] = useState(7);
  const [style, setStyle] = useState<"budget" | "mid-range" | "luxury">("mid-range");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiConfigured, setAiConfigured] = useState(true);

  useEffect(() => {
    api.get<Trip[]>("/trips").then((ts) => Promise.all(ts.map((t) => api.get<Trip>(`/trips/${t.id}`)))).then(setTrips).catch(() => {});
    api.get<Destination[]>("/destinations").then(setDestinations).catch(() => {});
    api.get<{ configured: boolean }>("/ai/status").then((s) => setAiConfigured(s.configured)).catch(() => {});
  }, []);

  async function runEstimate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setEstimate(null);
    try {
      const result = await api.post<Estimate>("/ai/estimate-cost", { destinationName, travelers, nights, style });
      setEstimate(result);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const tripTotals = trips.map((t) => ({
    trip: t,
    estimated: t.budgetLines.reduce((s, l) => s + l.estimated, 0),
    actual: t.budgetLines.reduce((s, l) => s + (l.actual ?? 0), 0),
  }));

  return (
    <div>
      <PageHeader title="Finances" subtitle="Rough estimates and detailed budgets across all trips" />

      <Card className="p-5 mb-8">
        <h2 className="font-semibold mb-3">Rough cost estimator (AI)</h2>
        {!aiConfigured && (
          <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">AI is not configured on the server — set ANTHROPIC_API_KEY to enable this.</p>
        )}
        <form onSubmit={runEstimate} className="grid grid-cols-4 gap-4 items-end">
          <div>
            <Label>Destination</Label>
            <Select value={destinationName} onChange={(e) => setDestinationName(e.target.value)}>
              <option value="">— choose —</option>
              {destinations.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </Select>
          </div>
          <div>
            <Label>Travelers</Label>
            <Input type="number" min={1} value={travelers} onChange={(e) => setTravelers(parseInt(e.target.value) || 1)} />
          </div>
          <div>
            <Label>Nights</Label>
            <Input type="number" min={1} value={nights} onChange={(e) => setNights(parseInt(e.target.value) || 1)} />
          </div>
          <div>
            <Label>Style</Label>
            <Select value={style} onChange={(e) => setStyle(e.target.value as any)}>
              <option value="budget">Budget</option>
              <option value="mid-range">Mid-range</option>
              <option value="luxury">Luxury</option>
            </Select>
          </div>
          <div className="col-span-4">
            <Button type="submit" disabled={loading || !destinationName}>{loading ? "Estimating…" : "Get AI estimate"}</Button>
          </div>
        </form>

        {error && <p className="text-sm text-red-600 mt-3">{error}</p>}

        {estimate && (
          <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
            <div><span className="text-slate-500">Flights:</span> {estimate.currency} {estimate.flights}</div>
            <div><span className="text-slate-500">Lodging:</span> {estimate.currency} {estimate.lodging}</div>
            <div><span className="text-slate-500">Food:</span> {estimate.currency} {estimate.food}</div>
            <div><span className="text-slate-500">Activities:</span> {estimate.currency} {estimate.activities}</div>
            <div><span className="text-slate-500">Local transport:</span> {estimate.currency} {estimate.localTransport}</div>
            <div><span className="text-slate-500">Misc:</span> {estimate.currency} {estimate.misc}</div>
            <div className="col-span-3 font-semibold text-base border-t pt-2 mt-1">
              Total: {estimate.currency} {estimate.total}
            </div>
            {estimate.notes && <p className="col-span-3 text-xs text-slate-500">{estimate.notes}</p>}
          </div>
        )}
      </Card>

      <h2 className="font-semibold mb-3">Trip budgets</h2>
      <div className="space-y-2">
        {tripTotals.map(({ trip, estimated, actual }) => (
          <Link key={trip.id} to={`/trips/${trip.id}`}>
            <Card className="p-4 flex items-center gap-4 hover:border-brand-400">
              <div className="flex-1">
                <div className="font-medium">{trip.title}</div>
                <div className="text-xs text-slate-500">{trip.destination?.name}</div>
              </div>
              <div className="text-sm text-slate-500">est. ${estimated.toFixed(2)}</div>
              <div className="text-sm">actual ${actual.toFixed(2)}</div>
              <Badge tone={actual > estimated && estimated > 0 ? "red" : "green"}>
                {estimated > 0 ? `${Math.round((actual / estimated) * 100)}% of budget` : "no budget set"}
              </Badge>
            </Card>
          </Link>
        ))}
        {tripTotals.length === 0 && <p className="text-sm text-slate-500">No trips yet.</p>}
      </div>
    </div>
  );
}
