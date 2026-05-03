/**
 * ActivityPanel — body of the former /profile Activity tab,
 * reused inside /identity?tab=activity.
 *
 * Phase 2 nav consolidation: see briefs/nav-consolidation-audit.md (Cluster 5).
 */

import { Activity, Cpu, Globe, Github, Fingerprint } from "lucide-react";

export function ActivityPanel() {
  const recentActivity = [
    {
      action: "Built app 'DataVault Pro'",
      time: "2 hours ago",
      icon: <Cpu className="w-3.5 h-3.5" />,
    },
    {
      action: "Deployed CustomerCare Pro agent",
      time: "3 hours ago",
      icon: <Activity className="w-3.5 h-3.5" />,
    },
    {
      action: "Created marketplace listing",
      time: "5 hours ago",
      icon: <Globe className="w-3.5 h-3.5" />,
    },
    {
      action: "Updated identity: ENS linked",
      time: "1 day ago",
      icon: <Fingerprint className="w-3.5 h-3.5" />,
    },
    {
      action: "Published workflow template",
      time: "1 day ago",
      icon: <Activity className="w-3.5 h-3.5" />,
    },
    {
      action: "Committed to feat/library-celestia-ui",
      time: "1 day ago",
      icon: <Github className="w-3.5 h-3.5" />,
    },
    {
      action: "Fine-tuned model: code-assist-v2",
      time: "2 days ago",
      icon: <Cpu className="w-3.5 h-3.5" />,
    },
  ];

  return (
    <div className="space-y-2 max-w-2xl">
      {recentActivity.map((item, i) => (
        <div
          key={i}
          className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/10"
        >
          <div className="w-8 h-8 rounded-lg bg-muted/20 flex items-center justify-center text-muted-foreground/60">
            {item.icon}
          </div>
          <span className="text-sm flex-1">{item.action}</span>
          <span className="text-[11px] text-muted-foreground/50">
            {item.time}
          </span>
        </div>
      ))}
    </div>
  );
}

export default ActivityPanel;
