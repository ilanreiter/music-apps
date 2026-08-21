import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { BookingAgent } from "../types";
import { Badge, Button, Card, Input, Label, PageHeader, Textarea } from "../components/ui";

export default function BookingAgents() {
  const [agents, setAgents] = useState<BookingAgent[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [contact, setContact] = useState("");
  const [website, setWebsite] = useState("");
  const [notes, setNotes] = useState("");

  function load() {
    api.get<BookingAgent[]>("/booking-agents").then(setAgents).catch(() => {});
  }
  useEffect(load, []);

  async function addAgent(e: React.FormEvent) {
    e.preventDefault();
    await api.post("/booking-agents", { name, type, contact, website, notes });
    setName(""); setType(""); setContact(""); setWebsite(""); setNotes("");
    setShowForm(false);
    load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this booking agent?")) return;
    await api.delete(`/booking-agents/${id}`);
    load();
  }

  return (
    <div>
      <PageHeader
        title="Booking Agents"
        subtitle="Travel agents, sites, and contacts you use to book trip items"
        actions={<Button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "+ Add agent"}</Button>}
      />

      {showForm && (
        <Card className="p-5 mb-6">
          <form onSubmit={addAgent} className="grid grid-cols-2 gap-4">
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <Label>Type</Label>
              <Input value={type} onChange={(e) => setType(e.target.value)} placeholder="Travel agency, OTA, airline…" />
            </div>
            <div>
              <Label>Contact</Label>
              <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Email / phone" />
            </div>
            <div>
              <Label>Website</Label>
              <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" />
            </div>
            <div className="col-span-2">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
            <div className="col-span-2">
              <Button type="submit">Save agent</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="space-y-2">
        {agents.map((a) => (
          <Card key={a.id} className="p-4 flex items-center gap-4">
            <div className="flex-1">
              <div className="font-medium">{a.name}</div>
              <div className="text-xs text-slate-500">
                {a.type && `${a.type} · `}
                {a.contact}
                {a.website && (
                  <>
                    {" · "}
                    <a href={a.website} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">{a.website}</a>
                  </>
                )}
              </div>
              {a.notes && <div className="text-xs text-slate-400 mt-1">{a.notes}</div>}
            </div>
            <Badge>{a._count?.items ?? 0} booking(s)</Badge>
            <Button variant="danger" onClick={() => remove(a.id)}>Delete</Button>
          </Card>
        ))}
        {agents.length === 0 && <p className="text-sm text-slate-500">No booking agents yet.</p>}
      </div>
    </div>
  );
}
