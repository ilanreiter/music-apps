import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { useTheme } from "../lib/ThemeContext";
import { CompassIcon, MoonIcon, SunIcon } from "./icons";

const navItems = [
  { to: "/", label: "Dashboard", end: true, emoji: "🏠" },
  { to: "/destinations", label: "Destinations", emoji: "🗺️" },
  { to: "/trips", label: "Trips", emoji: "🧳" },
  { to: "/finances", label: "Finances", emoji: "💰" },
  { to: "/booking-agents", label: "Booking Agents", emoji: "🤝" },
  { to: "/resources", label: "Resources", emoji: "📚" },
  { to: "/assistant", label: "AI Assistant", emoji: "🤖" },
  { to: "/preferences", label: "Preferences", emoji: "⚙️" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 sticky top-0 h-screen bg-brand-900 text-white flex flex-col">
        <div className="px-5 py-5 flex items-center gap-2 text-xl font-display font-semibold border-b border-white/10 shrink-0">
          <CompassIcon className="h-5 w-5 shrink-0" />
          Wander
        </div>
        <nav className="flex-1 min-h-0 overflow-y-auto px-2 py-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? "bg-white/15 text-white" : "text-brand-100 hover:bg-white/10"
                }`
              }
            >
              <span aria-hidden="true">{item.emoji}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-white/10 text-sm shrink-0">
          <div className="mb-2 truncate text-brand-100">{user?.name}</div>
          <div className="flex items-center justify-between">
            <button
              onClick={() => logout()}
              className="text-xs uppercase tracking-wide text-brand-200 hover:text-white"
            >
              Log out
            </button>
            <button
              onClick={toggleTheme}
              aria-label="Toggle dark mode"
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              className="text-brand-200 hover:text-white"
            >
              {theme === "dark" ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950 transition-colors">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
