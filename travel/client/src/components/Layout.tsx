import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { useTheme } from "../lib/ThemeContext";

const navItems = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/destinations", label: "Destinations" },
  { to: "/trips", label: "Trips" },
  { to: "/finances", label: "Finances" },
  { to: "/booking-agents", label: "Booking Agents" },
  { to: "/resources", label: "Resources" },
  { to: "/assistant", label: "AI Assistant" },
  { to: "/preferences", label: "Preferences" },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 bg-brand-900 text-white flex flex-col">
        <div className="px-5 py-5 text-xl font-semibold border-b border-white/10">✈ Wander</div>
        <nav className="flex-1 px-2 py-4 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? "bg-white/15 text-white" : "text-brand-100 hover:bg-white/10"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-4 border-t border-white/10 text-sm">
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
              className="text-lg leading-none text-brand-200 hover:text-white"
            >
              {theme === "dark" ? "☀" : "🌙"}
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
