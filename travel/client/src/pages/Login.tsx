import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { Button, Card, Input, Label } from "../components/ui";
import { CompassIcon } from "../components/icons";

export default function Login() {
  const { login, register } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, name, password);
      }
      navigate("/");
    } catch (err: any) {
      setError(err.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 px-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="flex items-center justify-center gap-2 text-xl font-display font-semibold text-center mb-1">
          <CompassIcon className="h-5 w-5 text-brand-600 dark:text-brand-400" />
          Wander
        </h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 text-center mb-6">Plan your next trip together</p>
        <form onSubmit={onSubmit} className="space-y-3">
          {mode === "register" && (
            <div>
              <Label>Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          )}
          <div>
            <Label>Email</Label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full justify-center">
            {mode === "login" ? "Log in" : "Create account"}
          </Button>
        </form>
        <button
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="text-xs text-brand-600 hover:underline w-full text-center mt-4"
        >
          {mode === "login" ? "New here? Create an account" : "Already have an account? Log in"}
        </button>
      </Card>
    </div>
  );
}
