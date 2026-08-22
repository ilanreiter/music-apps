import React, { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Traveler } from "../types";
import { Button, Card, Input, Label, PageHeader, Select, Textarea } from "../components/ui";

const EMOJI_CHOICES = ["🧑", "👩", "👨", "🧔", "👵", "👴", "👧", "👦", "🧑‍🦱", "🧑‍🦰", "🧑‍🦳", "🐶", "🐱"];
const MAX_PHOTO_DIMENSION = 256;

interface TravelerFormState {
  name: string;
  age: string;
  homeLocation: string;
  avatarEmoji: string;
  photoUrl: string;
  travelPreferences: string;
  stayPreferences: string;
  transportPreferences: string;
  foodPreferences: string;
  notes: string;
}

const emptyForm: TravelerFormState = {
  name: "",
  age: "",
  homeLocation: "",
  avatarEmoji: "",
  photoUrl: "",
  travelPreferences: "",
  stayPreferences: "",
  transportPreferences: "",
  foodPreferences: "",
  notes: "",
};

function toPayload(f: TravelerFormState) {
  return {
    name: f.name,
    age: f.age.trim() ? Number(f.age) : null,
    homeLocation: f.homeLocation || null,
    avatarEmoji: f.avatarEmoji || null,
    photoUrl: f.photoUrl || null,
    travelPreferences: f.travelPreferences || null,
    stayPreferences: f.stayPreferences || null,
    transportPreferences: f.transportPreferences || null,
    foodPreferences: f.foodPreferences || null,
    notes: f.notes || null,
  };
}

function toForm(t: Traveler): TravelerFormState {
  return {
    name: t.name,
    age: t.age != null ? String(t.age) : "",
    homeLocation: t.homeLocation || "",
    avatarEmoji: t.avatarEmoji || "",
    photoUrl: t.photoUrl || "",
    travelPreferences: t.travelPreferences || "",
    stayPreferences: t.stayPreferences || "",
    transportPreferences: t.transportPreferences || "",
    foodPreferences: t.foodPreferences || "",
    notes: t.notes || "",
  };
}

function readAndDownscaleImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read image"));
      img.onload = () => {
        const scale = Math.min(1, MAX_PHOTO_DIMENSION / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("Canvas not supported"));
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  });
}

function Avatar({ t, size = "h-10 w-10 text-xl" }: { t: { photoUrl?: string | null; avatarEmoji?: string | null; name: string }; size?: string }) {
  if (t.photoUrl) {
    return <img src={t.photoUrl} alt={t.name} className={`${size} rounded-full object-cover shrink-0`} />;
  }
  return (
    <div className={`${size} rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0`}>
      {t.avatarEmoji || t.name.charAt(0).toUpperCase()}
    </div>
  );
}

function TravelerForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: TravelerFormState;
  onSave: (f: TravelerFormState) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [photoError, setPhotoError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError("");
    try {
      const dataUrl = await readAndDownscaleImage(file);
      setForm((f) => ({ ...f, photoUrl: dataUrl, avatarEmoji: "" }));
    } catch {
      setPhotoError("Couldn't load that image — try a different file.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(form);
      }}
      className="grid grid-cols-2 gap-4"
    >
      <div className="col-span-2 flex items-center gap-4">
        <Avatar t={form} size="h-16 w-16 text-3xl" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-16 shrink-0">
              <Select
                value={form.avatarEmoji}
                onChange={(e) => setForm({ ...form, avatarEmoji: e.target.value, photoUrl: "" })}
                className="text-lg text-center px-1"
              >
                <option value="">—</option>
                {EMOJI_CHOICES.map((emoji) => (
                  <option key={emoji} value={emoji}>{emoji}</option>
                ))}
              </Select>
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" onChange={handlePhotoChange} className="text-xs text-slate-500" />
            {form.photoUrl && (
              <Button type="button" variant="ghost" onClick={() => setForm({ ...form, photoUrl: "" })}>
                Remove photo
              </Button>
            )}
          </div>
          {photoError && <p className="text-xs text-red-500">{photoError}</p>}
        </div>
      </div>
      <div>
        <Label>Name</Label>
        <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </div>
      <div>
        <Label>Age</Label>
        <Input
          type="number"
          min={0}
          max={130}
          value={form.age}
          onChange={(e) => setForm({ ...form, age: e.target.value })}
        />
      </div>
      <div className="col-span-2">
        <Label>🏠 Home location</Label>
        <Input
          value={form.homeLocation}
          onChange={(e) => setForm({ ...form, homeLocation: e.target.value })}
          placeholder="e.g. Seattle, WA"
        />
      </div>
      <div className="col-span-2">
        <Label>🧭 Travel preferences</Label>
        <Textarea
          rows={2}
          value={form.travelPreferences}
          onChange={(e) => setForm({ ...form, travelPreferences: e.target.value })}
          placeholder="Pace, interests, must-dos/avoids — e.g. prefers a slow pace, loves hiking and local food, avoids crowded tourist traps…"
        />
      </div>
      <div className="col-span-2">
        <Label>🏨 Hotel &amp; stay preferences</Label>
        <Textarea
          rows={2}
          value={form.stayPreferences}
          onChange={(e) => setForm({ ...form, stayPreferences: e.target.value })}
          placeholder="e.g. prefers boutique hotels over chains, needs a quiet room, wants a pool, always books ground floor…"
        />
      </div>
      <div className="col-span-2">
        <Label>🚗 Transportation preferences</Label>
        <Textarea
          rows={2}
          value={form.transportPreferences}
          onChange={(e) => setForm({ ...form, transportPreferences: e.target.value })}
          placeholder="e.g. prefers direct flights, aisle seat, gets carsick on long drives, happy to take night trains…"
        />
      </div>
      <div className="col-span-2">
        <Label>🍽️ Food preferences</Label>
        <Textarea
          rows={2}
          value={form.foodPreferences}
          onChange={(e) => setForm({ ...form, foodPreferences: e.target.value })}
          placeholder="e.g. vegetarian, loves spicy food, allergic to shellfish, always up for street food…"
        />
      </div>
      <div className="col-span-2">
        <Label>📝 Other important information</Label>
        <Textarea
          rows={3}
          value={form.notes}
          onChange={(e) => setForm({ ...form, notes: e.target.value })}
          placeholder="Mobility needs, passport/visa notes, frequent flyer numbers, anything booking agents should know…"
        />
      </div>
      <div className="col-span-2 flex items-center gap-3">
        <Button type="submit">Save traveler</Button>
        <Button type="button" variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export default function Travelers() {
  const [travelers, setTravelers] = useState<Traveler[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  function load() {
    api.get<Traveler[]>("/travelers").then(setTravelers).catch(() => {});
  }
  useEffect(load, []);

  async function addTraveler(f: TravelerFormState) {
    await api.post("/travelers", toPayload(f));
    setShowAddForm(false);
    load();
  }

  async function updateTraveler(id: string, f: TravelerFormState) {
    await api.patch(`/travelers/${id}`, toPayload(f));
    setEditingId(null);
    load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this traveler profile?")) return;
    await api.delete(`/travelers/${id}`);
    load();
  }

  return (
    <div>
      <PageHeader
        title="Travelers"
        subtitle="Who's traveling — home location, ages, and preferences the AI assistant and booking agents should know"
        actions={
          !showAddForm && (
            <Button onClick={() => { setShowAddForm(true); setEditingId(null); }}>+ Add traveler</Button>
          )
        }
      />

      {showAddForm && (
        <Card className="p-5 mb-6">
          <TravelerForm initial={emptyForm} onSave={addTraveler} onCancel={() => setShowAddForm(false)} />
        </Card>
      )}

      <div className="space-y-3">
        {travelers.map((t) =>
          editingId === t.id ? (
            <Card key={t.id} className="p-5">
              <TravelerForm initial={toForm(t)} onSave={(f) => updateTraveler(t.id, f)} onCancel={() => setEditingId(null)} />
            </Card>
          ) : (
            <Card key={t.id} className="p-4">
              <div className="flex items-start gap-4">
                <Avatar t={t} />
                <div className="flex-1 space-y-1">
                  <div className="font-medium">
                    {t.name}
                    {t.age != null && <span className="text-slate-400 font-normal"> · {t.age} yrs</span>}
                    {t.homeLocation && <span className="text-slate-400 font-normal"> · 🏠 {t.homeLocation}</span>}
                  </div>
                  {t.travelPreferences && (
                    <div className="text-xs text-slate-500"><span className="text-slate-400">🧭 Travel:</span> {t.travelPreferences}</div>
                  )}
                  {t.stayPreferences && (
                    <div className="text-xs text-slate-500"><span className="text-slate-400">🏨 Stays:</span> {t.stayPreferences}</div>
                  )}
                  {t.transportPreferences && (
                    <div className="text-xs text-slate-500"><span className="text-slate-400">🚗 Transport:</span> {t.transportPreferences}</div>
                  )}
                  {t.foodPreferences && (
                    <div className="text-xs text-slate-500"><span className="text-slate-400">🍽️ Food:</span> {t.foodPreferences}</div>
                  )}
                  {t.notes && (
                    <div className="text-xs text-slate-500"><span className="text-slate-400">📝 Other:</span> {t.notes}</div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <Button variant="secondary" onClick={() => { setEditingId(t.id); setShowAddForm(false); }}>Edit</Button>
                  <Button variant="danger" onClick={() => remove(t.id)}>Delete</Button>
                </div>
              </div>
            </Card>
          )
        )}
        {travelers.length === 0 && !showAddForm && (
          <p className="text-sm text-slate-500">No travelers added yet.</p>
        )}
      </div>
    </div>
  );
}
