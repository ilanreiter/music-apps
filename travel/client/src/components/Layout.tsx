import React, { useEffect, useState } from "react";
import { api } from "../lib/api";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/AuthContext";
import { useTheme } from "../lib/ThemeContext";
import { motion } from "framer-motion";
import { Bot, BookOpen, Inbox as InboxIcon, LayoutGrid, PiggyBank, Handshake, Settings, Users } from "lucide-react";
import { MoonIcon, SunIcon, WanderLogo } from "./icons";
import GlobalSearch from "./GlobalSearch";

const navItems = [
  { to: "/", label: "Dashboard", end: true, Icon: LayoutGrid },
  { to: "/import", label: "Import", Icon: InboxIcon },
  { to: "/budget", label: "Budget", Icon: PiggyBank },
  { to: "/travelers", label: "Travelers", Icon: Users },
  { to: "/booking-agents", label: "Booking Agents", Icon: Handshake },
  { to: "/resources", label: "Resources", Icon: BookOpen },
  { to: "/assistant", label: "AI Assistant", Icon: Bot },
  { to: "/preferences", label: "Preferences", Icon: Settings },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const [pending, setPending] = useState(0);
  const loc = useLocation();
  useEffect(() => { api.get<{ pending: number }>("/inbox/count").then((r) => setPending(r.pending)).catch(() => {}); }, [loc.pathname]);

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 sticky top-0 z-[1200] h-screen bg-brand-900 text-white flex flex-col">
        <div className="px-5 py-5 flex items-center gap-2 text-xl font-display font-semibold border-b border-white/10 shrink-0">
          <WanderLogo className="h-8 w-8 shrink-0" />
          <span className="leading-tight">Wander<span className="block text-[11px] font-sans font-normal text-brand-200">Travel Planner</span></span>
        </div>
        <div className="px-3 pt-3"><GlobalSearch variant="sidebar" /></div>
        <nav className="flex-1 min-h-0 overflow-y-auto px-2 py-3 space-y-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive ? "text-white" : "text-brand-100 hover:bg-white/10"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-md bg-white/15 ring-1 ring-white/10"
                      transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    />
                  )}
                  <item.Icon className="relative h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="relative">{item.label}</span>
                  {item.to === "/import" && pending > 0 && <span className="relative ml-auto rounded-full bg-white/20 px-1.5 text-[11px]">{pending}</span>}
                </>
              )}
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
        <div className="max-w-[1800px] mx-auto px-6 py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
