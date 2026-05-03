/**
 * Unified Identity Page — Create Once, Use Everywhere
 *
 * Route: /identity
 *
 * Central hub for managing your Universal Identity. Phase 2 of the nav
 * consolidation (briefs/nav-consolidation-audit.md, Cluster 5) folds the
 * former /ssi-credentials, /creator-profile, and /profile pages into this
 * page as tabs. The old routes still resolve and render a deprecation
 * banner that links here with the matching `?tab=` selected.
 *
 * Tabs:
 *   1. Identity        — DID + ENS/JNS + Multi-chain Wallets + Reputation
 *   2. Public Profile  — Public-facing creator profile (was /creator-profile)
 *   3. SSI Credentials — Verifiable credentials (was /ssi-credentials)
 *   4. Account & Billing — Account + usage + connected services (was /profile)
 *   5. Activity        — Recent activity log (was /profile activity tab)
 */

import { useNavigate, useSearch } from "@tanstack/react-router";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Fingerprint,
  UserCircle,
  Stamp,
  KeyRound,
  Activity,
} from "lucide-react";
import { UnifiedIdentityHub } from "@/components/identity/UnifiedIdentityHub";
import { PublicProfilePanel } from "@/components/identity/me/PublicProfilePanel";
import { SSICredentialsPanel } from "@/components/identity/me/SSICredentialsPanel";
import { AccountBillingPanel } from "@/components/identity/me/AccountBillingPanel";
import { ActivityPanel } from "@/components/identity/me/ActivityPanel";

export const IDENTITY_TABS = [
  "identity",
  "public",
  "ssi",
  "account",
  "activity",
] as const;
export type IdentityTab = (typeof IDENTITY_TABS)[number];

export default function UnifiedIdentityPage() {
  const search = useSearch({ from: "/identity" });
  const navigate = useNavigate();
  const activeTab: IdentityTab = (search?.tab as IdentityTab) ?? "identity";

  const handleTabChange = (value: string) => {
    void navigate({
      to: "/identity",
      search: { tab: value as IdentityTab },
      replace: true,
    });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="border-b p-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center">
            <Fingerprint className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Identity</h1>
            <p className="text-sm text-muted-foreground">
              Your universal identity, public profile, credentials, and account
            </p>
          </div>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex-1 flex flex-col min-h-0"
      >
        <div className="border-b px-4">
          <TabsList className="bg-transparent">
            <TabsTrigger value="identity" className="gap-1.5">
              <Fingerprint className="w-3.5 h-3.5" /> Identity
            </TabsTrigger>
            <TabsTrigger value="public" className="gap-1.5">
              <UserCircle className="w-3.5 h-3.5" /> Public Profile
            </TabsTrigger>
            <TabsTrigger value="ssi" className="gap-1.5">
              <Stamp className="w-3.5 h-3.5" /> SSI Credentials
            </TabsTrigger>
            <TabsTrigger value="account" className="gap-1.5">
              <KeyRound className="w-3.5 h-3.5" /> Account & Billing
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-1.5">
              <Activity className="w-3.5 h-3.5" /> Activity
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Identity tab renders the existing UnifiedIdentityHub which manages
            its own scrolling internally — no extra ScrollArea wrapper. */}
        <TabsContent
          value="identity"
          className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden"
          forceMount
        >
          <UnifiedIdentityHub />
        </TabsContent>

        {/* Other tabs render simpler bodies; wrap each in a ScrollArea so they
            scroll independently inside the page chrome. */}
        <TabsContent
          value="public"
          className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden"
        >
          <ScrollArea className="h-full">
            <div className="p-4">
              <PublicProfilePanel />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent
          value="ssi"
          className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden"
        >
          <ScrollArea className="h-full">
            <div className="p-4">
              <SSICredentialsPanel />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent
          value="account"
          className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden"
        >
          <ScrollArea className="h-full">
            <div className="p-4">
              <AccountBillingPanel />
            </div>
          </ScrollArea>
        </TabsContent>

        <TabsContent
          value="activity"
          className="flex-1 min-h-0 mt-0 data-[state=inactive]:hidden"
        >
          <ScrollArea className="h-full">
            <div className="p-4">
              <ActivityPanel />
            </div>
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </div>
  );
}
