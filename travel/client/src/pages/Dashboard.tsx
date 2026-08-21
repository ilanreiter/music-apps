import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { Destination, Trip } from "../types";
import { Card, PageHeader, Badge } from "../components/ui";

export default function Dashboard() {
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);

  useEffect(() => {
    api.get<Destination[]>("/destinations").then(setDestinations).catch(() => {});
    api.get<Trip[]>("/trips").then(setTrips).catch(() => {});
  }, []);

  const upcoming = trips
    .filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED")
    .slice(0, 5);
  const topDestinations = [...destinations].sort((a, b) => a.priority - b.priority).slice(0, 5);

  return (
    <div>
      <PageHeader title="Dashboard" subtitle="Your travel planning at a glance" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Top destinations</h2>
            <Link to="/destinations" className="text-xs text-brand-600 hover:underline">View all</Link>
          </div>
          {topDestinations.length === 0 && <p className="text-sm text-slate-500">No destinations yet. Add your first one!</p>}
          <ul className="space-y-2">
            {topDestinations.map((d, i) => (
              <li key={d.id} className="flex items-center justify-between text-sm">
                <span>
                  <span className="text-slate-400 mr-2">#{i + 1}</span>
                  {d.name}
                </span>
                <Badge>{d.status}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Active trips</h2>
            <Link to="/trips" className="text-xs text-brand-600 hover:underline">View all</Link>
          </div>
          {upcoming.length === 0 && <p className="text-sm text-slate-500">No trips in progress yet.</p>}
          <ul className="space-y-2">
            {upcoming.map((t) => (
              <li key={t.id}>
                <Link to={`/trips/${t.id}`} className="flex items-center justify-between text-sm hover:text-brand-700">
                  <span>{t.title}</span>
                  <Badge tone="blue">{t.status}</Badge>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
}
