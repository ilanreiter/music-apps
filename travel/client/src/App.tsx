import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { ThemeProvider } from "./lib/ThemeContext";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import Budget from "./pages/Budget";
import TripDetail from "./pages/TripDetail";
import BookingAgents from "./pages/BookingAgents";
import Resources from "./pages/Resources";
import Assistant from "./pages/Assistant";
import Preferences from "./pages/Preferences";
import Inbox from "./pages/Inbox";
import Documents from "./pages/Documents";
import Travelers from "./pages/Travelers";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center text-slate-400">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="import" element={<Inbox />} />
        <Route path="documents" element={<Documents />} />
        <Route path="inbox" element={<Navigate to="/import" replace />} />
        <Route path="budget" element={<Budget />} />
        {/* Removed tabs: old links land on the Dashboard. Trip detail pages are still opened from a card. */}
        <Route path="destinations" element={<Navigate to="/" replace />} />
        <Route path="trips" element={<Navigate to="/" replace />} />
        <Route path="trips/:id" element={<TripDetail />} />
        <Route path="travelers" element={<Travelers />} />
        <Route path="finances" element={<Navigate to="/budget" replace />} />
        <Route path="booking-agents" element={<BookingAgents />} />
        <Route path="resources" element={<Resources />} />
        <Route path="assistant" element={<Assistant />} />
        <Route path="preferences" element={<Preferences />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );
}
