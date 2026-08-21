import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { Trip } from "../types";
import { Button, Card, PageHeader, Select, Textarea } from "../components/ui";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[75%] rounded-lg px-4 py-3 bg-slate-100 dark:bg-slate-800 flex items-center gap-1">
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce [animation-delay:-0.3s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce [animation-delay:-0.15s]" />
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400 dark:bg-slate-500 animate-bounce" />
      </div>
    </div>
  );
}

export default function Assistant() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripId, setTripId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<Trip[]>("/trips").then(setTrips).catch(() => {});
    api.get<{ configured: boolean }>("/ai/status").then((s) => setAiConfigured(s.configured)).catch(() => {});
  }, []);

  useEffect(() => {
    api
      .get<{ role: string; content: string }[]>(`/ai/history${tripId ? `?tripId=${tripId}` : ""}`)
      .then((h) => setMessages(h.map((m) => ({ role: m.role as "user" | "assistant", content: m.content }))))
      .catch(() => setMessages([]));
  }, [tripId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || busy) return;
    const userMsg = input;
    setMessages((m) => [...m, { role: "user", content: userMsg }]);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ reply: string }>("/ai/chat", { tripId: tripId || null, message: userMsg });
      setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)]">
      <PageHeader
        title="AI Assistant"
        subtitle="Ask for destination ideas, itinerary drafts, cost estimates, or logistics advice"
        actions={
          <Select value={tripId} onChange={(e) => setTripId(e.target.value)} className="w-56">
            <option value="">General (no trip context)</option>
            {trips.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </Select>
        }
      />

      {!aiConfigured && (
        <Card className="p-4 mb-4 border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-sm text-amber-700 dark:text-amber-300">
          AI is not configured on the server. Set <code>ANTHROPIC_API_KEY</code> in the server environment to enable the assistant.
        </Card>
      )}

      <Card className="flex-1 overflow-y-auto p-5 space-y-4 mb-4">
        {messages.length === 0 && !busy && (
          <p className="text-sm text-slate-500">
            Try: "Suggest a 5-day itinerary for Kyoto in April" or "What should we pack for Patagonia in December?"
          </p>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            {m.role === "user" ? (
              <div className="max-w-[75%] rounded-lg px-4 py-2 text-sm whitespace-pre-wrap bg-brand-600 text-white">
                {m.content}
              </div>
            ) : (
              <div className="max-w-[75%] rounded-lg px-4 py-2 bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100">
                <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-headings:mt-3 prose-headings:mb-1.5 prose-pre:my-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ))}
        {busy && <TypingIndicator />}
        <div ref={bottomRef} />
      </Card>

      {error && <p className="text-sm text-red-600 mb-2">{error}</p>}

      <form onSubmit={send} className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder="Ask the assistant…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(e as any);
            }
          }}
        />
        <Button type="submit" disabled={busy || !aiConfigured}>{busy ? "…" : "Send"}</Button>
      </form>
    </div>
  );
}
