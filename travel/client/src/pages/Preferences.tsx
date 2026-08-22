import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Preferences as PreferencesType } from "../types";
import { Button, Card, Input, Label, PageHeader, Select, Textarea } from "../components/ui";

const PACE_OPTIONS = ["Relaxed", "Moderate", "Packed"];
const BUDGET_OPTIONS = ["Budget-conscious", "Mid-range", "Splurge on a few things", "Luxury"];

export default function Preferences() {
  const [prefs, setPrefs] = useState<PreferencesType | null>(null);
  const [interests, setInterests] = useState("");
  const [pace, setPace] = useState("");
  const [budgetStyle, setBudgetStyle] = useState("");
  const [notes, setNotes] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get<PreferencesType>("/preferences").then((p) => {
      setPrefs(p);
      setInterests(p.interests.join(", "));
      setPace(p.pace || "");
      setBudgetStyle(p.budgetStyle || "");
      setNotes(p.notes || "");
    });
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const updated = await api.put<PreferencesType>("/preferences", {
      interests: interests.split(",").map((s) => s.trim()).filter(Boolean),
      pace: pace || null,
      budgetStyle: budgetStyle || null,
      notes: notes || null,
    });
    setPrefs(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  if (!prefs) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div>
      <PageHeader
        title="Travel Preferences"
        subtitle="Shared household preferences the AI assistant uses when proposing itineraries and estimates"
      />

      <Card className="p-5 max-w-2xl">
        <form onSubmit={save} className="space-y-4">
          <div>
            <Label>Interests (comma-separated)</Label>
            <Input
              value={interests}
              onChange={(e) => setInterests(e.target.value)}
              placeholder="hiking, local food, museums, architecture, beaches…"
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Preferred pace</Label>
              <Select value={pace} onChange={(e) => setPace(e.target.value)}>
                <option value="">— unspecified —</option>
                {PACE_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
              </Select>
            </div>
            <div>
              <Label>Budget style</Label>
              <Select value={budgetStyle} onChange={(e) => setBudgetStyle(e.target.value)}>
                <option value="">— unspecified —</option>
                {BUDGET_OPTIONS.map((b) => <option key={b} value={b}>{b}</option>)}
              </Select>
            </div>
          </div>
          <div>
            <Label>Anything else worth knowing?</Label>
            <Textarea
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. we prefer walkable neighborhoods, avoid very early flights, one of us has a peanut allergy, we like a rest day every 3-4 days…"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit">Save preferences</Button>
            {saved && <span className="text-sm text-green-600 dark:text-green-400">Saved</span>}
          </div>
        </form>
      </Card>
    </div>
  );
}
