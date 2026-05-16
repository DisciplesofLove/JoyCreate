/**
 * AgentSurfacesNav
 *
 * Phase 2 nav consolidation: the sidebar previously listed every agent
 * surface (Agents, Swarm, Orchestrator, Automation, Autonomous, Production,
 * Coding) as a separate top-level entry. The canonical entry now lives
 * under "AI & Agents → Agents" and this strip surfaces the related pages
 * as in-page tabs. Each "tab" is a router Link so the underlying pages,
 * routes, and IPC handlers are completely unchanged — we only collapse
 * the sidebar real estate.
 *
 * Drop into any agent surface page below the header for cross-navigation.
 */

import { Link, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  Network,
  Orbit,
  Zap,
  BrainCircuit,
  Activity,
  Code2,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Surface = {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const SURFACES: Surface[] = [
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/coding-agent", label: "Coding", icon: Code2 },
  { to: "/agent-swarm", label: "Swarm", icon: Network },
  { to: "/agent-orchestrator", label: "Orchestrator", icon: Orbit },
  { to: "/automation-orchestrator", label: "Automation", icon: Zap },
  { to: "/autonomous-agent", label: "Autonomous", icon: BrainCircuit },
  { to: "/autonomous-agent-production", label: "Production", icon: Activity },
];

export function AgentSurfacesNav() {
  const { location } = useRouterState();
  const current = location.pathname;

  return (
    <div
      className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/50 bg-background/40 p-1"
      role="tablist"
      aria-label="Agent surfaces"
    >
      {SURFACES.map((surface) => {
        const Icon = surface.icon;
        const isActive = current === surface.to;
        return (
          <Link
            key={surface.to}
            to={surface.to}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition",
              isActive
                ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {surface.label}
          </Link>
        );
      })}
    </div>
  );
}
