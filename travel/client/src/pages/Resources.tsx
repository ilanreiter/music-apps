import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Destination, Resource } from "../types";
import { Badge, Button, Card, Input, Label, PageHeader, Select, Textarea } from "../components/ui";

export default function Resources() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [destinationId, setDestinationId] = useState("");
  const [notes, setNotes] = useState("");

  function load() {
    api.get<Resource[]>("/resources").then(setResources).catch(() => {});
  }
  useEffect(() => {
    load();
    api.get<Destination[]>("/destinations").then(setDestinations).catch(() => {});
  }, []);

  async function addResource(e: React.FormEvent) {
    e.preventDefault();
    await api.post("/resources", {
      title,
      url: url || undefined,
      category: category || undefined,
      destinationId: destinationId || undefined,
      notes: notes || undefined,
    });
    setTitle(""); setUrl(""); setCategory(""); setDestinationId(""); setNotes("");
    setShowForm(false);
    load();
  }

  async function remove(id: string) {
    await api.delete(`/resources/${id}`);
    load();
  }

  return (
    <div>
      <PageHeader
        title="Resource Discovery"
        subtitle="Guides, visa info, packing lists, and useful links"
        actions={<Button onClick={() => setShowForm((v) => !v)}>{showForm ? "Cancel" : "+ Add resource"}</Button>}
      />

      {showForm && (
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
            <div>
              <Label>Destination</Label>
              <Select value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                <option value="">— none —</option>
                {destinations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Notes</Label>
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </div>
            <div className="col-span-2">
              <Button type="submit">Save resource</Button>
            </div>
          </form>
        </Card>
      )}

      <div className="space-y-2">
        {resources.map((r) => (
          <Card key={r.id} className="p-4 flex items-center gap-4">
            {r.category && <Badge>{r.category}</Badge>}
            <div className="flex-1">
              <div className="font-medium">
                {r.url ? <a href={r.url} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">{r.title}</a> : r.title}
              </div>
              {r.notes && <div className="text-xs text-slate-400">{r.notes}</div>}
            </div>
            <Button variant="danger" onClick={() => remove(r.id)}>Delete</Button>
          </Card>
        ))}
        {resources.length === 0 && <p className="text-sm text-slate-500">No resources yet.</p>}
      </div>
    </div>
  );
}
