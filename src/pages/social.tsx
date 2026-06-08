/**
 * Social — agent-managed multi-platform social media command center.
 *
 * A tabbed workspace: Overview, Composer, Calendar, Campaigns, Inbox,
 * Approvals, Analytics, Accounts, and the autonomous Agent settings.
 */

import {
  BarChart3,
  Bot,
  CalendarDays,
  CheckSquare,
  LayoutDashboard,
  Megaphone,
  MessagesSquare,
  PenSquare,
  Users,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { SocialAccounts } from "@/components/social/SocialAccounts";
import { SocialAgentPanel } from "@/components/social/SocialAgentPanel";
import { SocialAnalytics } from "@/components/social/SocialAnalytics";
import { SocialApprovals } from "@/components/social/SocialApprovals";
import { SocialCalendar } from "@/components/social/SocialCalendar";
import { SocialCampaigns } from "@/components/social/SocialCampaigns";
import { SocialComposer } from "@/components/social/SocialComposer";
import { SocialInbox } from "@/components/social/SocialInbox";
import { SocialOverview } from "@/components/social/SocialOverview";
import { useSocialAgentStatus } from "@/hooks/useSocial";

export type SocialTab =
  | "overview"
  | "composer"
  | "calendar"
  | "campaigns"
  | "inbox"
  | "approvals"
  | "analytics"
  | "accounts"
  | "agent";

const TABS: Array<{
  value: SocialTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { value: "overview", label: "Overview", icon: LayoutDashboard },
  { value: "composer", label: "Composer", icon: PenSquare },
  { value: "calendar", label: "Calendar", icon: CalendarDays },
  { value: "campaigns", label: "Campaigns", icon: Megaphone },
  { value: "inbox", label: "Inbox", icon: MessagesSquare },
  { value: "approvals", label: "Approvals", icon: CheckSquare },
  { value: "analytics", label: "Analytics", icon: BarChart3 },
  { value: "accounts", label: "Accounts", icon: Users },
  { value: "agent", label: "Agent", icon: Bot },
];

export default function SocialPage() {
  const [tab, setTab] = useState<SocialTab>("overview");
  const { data: status } = useSocialAgentStatus();

  const pendingApprovals =
    (status?.pendingPostApprovals ?? 0) + (status?.pendingReplyApprovals ?? 0);
  const newEngagements = status?.newEngagements ?? 0;

  return (
    <div className="flex h-full flex-col">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as SocialTab)}
        className="flex h-full flex-col"
      >
        <header className="border-b bg-background px-6 py-4">
          <div className="flex items-center gap-2">
            <MessagesSquare className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold tracking-tight">Social</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Plan, generate, schedule and engage across every platform — fully
            agent-managed.
          </p>
          <ScrollArea className="mt-4 w-full">
            <TabsList className="h-auto flex-wrap">
              {TABS.map(({ value, label, icon: Icon }) => (
                <TabsTrigger key={value} value={value} className="gap-1.5">
                  <Icon className="h-4 w-4" />
                  {label}
                  {value === "approvals" && pendingApprovals > 0 && (
                    <Badge variant="secondary" className="ml-1 text-[10px]">
                      {pendingApprovals}
                    </Badge>
                  )}
                  {value === "inbox" && newEngagements > 0 && (
                    <Badge variant="secondary" className="ml-1 text-[10px]">
                      {newEngagements}
                    </Badge>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </ScrollArea>
        </header>

        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-6xl p-6">
            <TabsContent value="overview" className="mt-0">
              <SocialOverview onNavigate={setTab} />
            </TabsContent>
            <TabsContent value="composer" className="mt-0">
              <SocialComposer />
            </TabsContent>
            <TabsContent value="calendar" className="mt-0">
              <SocialCalendar />
            </TabsContent>
            <TabsContent value="campaigns" className="mt-0">
              <SocialCampaigns />
            </TabsContent>
            <TabsContent value="inbox" className="mt-0">
              <SocialInbox />
            </TabsContent>
            <TabsContent value="approvals" className="mt-0">
              <SocialApprovals />
            </TabsContent>
            <TabsContent value="analytics" className="mt-0">
              <SocialAnalytics />
            </TabsContent>
            <TabsContent value="accounts" className="mt-0">
              <SocialAccounts />
            </TabsContent>
            <TabsContent value="agent" className="mt-0">
              <SocialAgentPanel />
            </TabsContent>
          </div>
        </ScrollArea>
      </Tabs>
    </div>
  );
}
