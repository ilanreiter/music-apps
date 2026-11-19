import React from "react";
import { Flower2, Leaf, Snowflake, Sun } from "lucide-react";

export const SEASON_META: Record<string, { Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; color: string }> = {
  Winter: { Icon: Snowflake, color: "var(--season-winter)" },
  Spring: { Icon: Flower2, color: "var(--season-spring)" },
  Summer: { Icon: Sun, color: "var(--season-summer)" },
  Fall: { Icon: Leaf, color: "var(--season-fall)" },
};
