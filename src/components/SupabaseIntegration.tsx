import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
// We might need a Supabase icon here, but for now, let's use a generic one or text.
// import { Supabase } from "lucide-react"; // Placeholder
import { DatabaseZap, KeyRound, Trash2 } from "lucide-react"; // Using DatabaseZap as a placeholder
import { useSettings } from "@/hooks/useSettings";
import { useSupabase } from "@/hooks/useSupabase";
import { showSuccess, showError } from "@/lib/toast";
import { isSupabaseConnected } from "@/lib/schemas";
import { IpcClient } from "@/ipc/ipc_client";

export function SupabaseIntegration() {
  const { settings, updateSettings, refreshSettings } = useSettings();
  const [isDisconnecting, setIsDisconnecting] = useState(false);

  // Check if there are any connected organizations
  const isConnected = isSupabaseConnected(settings);

  const { organizations, refetchOrganizations, deleteOrganization } =
    useSupabase();

  // PAT dialog state. Lets the user (re)connect Supabase by pasting a
  // Personal Access Token when the OAuth proxy is unavailable.
  const [patDialogOpen, setPatDialogOpen] = useState(false);
  const [patValue, setPatValue] = useState("");
  const [patSubmitting, setPatSubmitting] = useState(false);

  const handleSubmitPat = async () => {
    setPatSubmitting(true);
    try {
      await IpcClient.getInstance().setSupabasePersonalAccessToken(patValue);
      showSuccess("Supabase connected via personal access token");
      setPatDialogOpen(false);
      setPatValue("");
      await refreshSettings();
      await refetchOrganizations();
    } catch (err: any) {
      showError(err?.message || "Failed to set access token");
    } finally {
      setPatSubmitting(false);
    }
  };

  const handleStartOAuth = async () => {
    await IpcClient.getInstance().openExternalUrl(
      "https://oauth.joymarketplace.io/api/supabase/login",
    );
  };

  const patDialog = (
    <Dialog open={patDialogOpen} onOpenChange={setPatDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect Supabase with access token</DialogTitle>
          <DialogDescription>
            Create a Personal Access Token at{" "}
            <button
              type="button"
              className="text-primary underline"
              onClick={() =>
                IpcClient.getInstance().openExternalUrl(
                  "https://supabase.com/dashboard/account/tokens",
                )
              }
            >
              supabase.com/dashboard/account/tokens
            </button>
            , then paste it below. Tokens start with <code>sbp_</code>.
          </DialogDescription>
        </DialogHeader>
        <Input
          type="password"
          autoFocus
          placeholder="sbp_..."
          value={patValue}
          onChange={(e) => setPatValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && patValue.trim() && !patSubmitting) {
              handleSubmitPat();
            }
          }}
        />
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setPatDialogOpen(false)}
            disabled={patSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmitPat}
            disabled={!patValue.trim() || patSubmitting}
          >
            {patSubmitting ? "Validating…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const handleDisconnectAllFromSupabase = async () => {
    setIsDisconnecting(true);
    try {
      // Clear the entire supabase object in settings (including all organizations)
      const result = await updateSettings({
        supabase: undefined,
        // Also disable the migration setting on disconnect
        enableSupabaseWriteSqlMigration: false,
      });
      if (result) {
        showSuccess("Successfully disconnected all Supabase organizations");
        await refetchOrganizations();
      } else {
        showError("Failed to disconnect from Supabase");
      }
    } catch (err: any) {
      showError(
        err.message || "An error occurred while disconnecting from Supabase",
      );
    } finally {
      setIsDisconnecting(false);
    }
  };

  const handleDeleteOrganization = async (organizationSlug: string) => {
    try {
      await deleteOrganization({ organizationSlug });
      showSuccess("Organization disconnected successfully");
    } catch (err: any) {
      showError(err.message || "Failed to disconnect organization");
    }
  };

  const handleMigrationSettingChange = async (enabled: boolean) => {
    try {
      await updateSettings({
        enableSupabaseWriteSqlMigration: enabled,
      });
      showSuccess("Setting updated");
    } catch (err: any) {
      showError(err.message || "Failed to update setting");
    }
  };

  if (!isConnected) {
    return (
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Supabase Integration
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
              Not connected. Use a Personal Access Token to connect without the
              OAuth browser flow.
            </p>
          </div>
          <div className="flex flex-col gap-2 shrink-0">
            <Button
              onClick={() => setPatDialogOpen(true)}
              size="sm"
              className="flex items-center gap-2"
            >
              <KeyRound className="h-4 w-4" />
              Connect with token
            </Button>
            <Button
              onClick={handleStartOAuth}
              variant="outline"
              size="sm"
              className="flex items-center gap-2"
            >
              <DatabaseZap className="h-4 w-4" />
              Connect via OAuth
            </Button>
          </div>
        </div>
        {patDialog}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Supabase Integration
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {organizations.length} organization
            {organizations.length !== 1 ? "s" : ""} connected to Supabase.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setPatDialogOpen(true)}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
            title="Replace stored token with a new Personal Access Token"
          >
            <KeyRound className="h-4 w-4" />
            Update token
          </Button>
          <Button
            onClick={handleDisconnectAllFromSupabase}
            variant="destructive"
            size="sm"
            disabled={isDisconnecting}
            className="flex items-center gap-2"
          >
            {isDisconnecting ? "Disconnecting..." : "Disconnect All"}
            <DatabaseZap className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Connected organizations list */}
      <div className="mt-3 space-y-1">
        {organizations.map((org) => (
          <div
            key={org.organizationSlug}
            className="flex items-center justify-between p-2 rounded-md bg-muted/50 text-sm gap-2"
          >
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-gray-700 dark:text-gray-300 font-medium truncate">
                {org.name || `Organization ${org.organizationSlug.slice(0, 8)}`}
              </span>
              {org.ownerEmail && (
                <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {org.ownerEmail}
                </span>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-muted-foreground hover:text-destructive shrink-0"
              onClick={() => handleDeleteOrganization(org.organizationSlug)}
              title="Disconnect organization"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              <span className="text-xs">Disconnect</span>
            </Button>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <div className="flex items-center space-x-3">
          <Switch
            id="supabase-migrations"
            checked={!!settings?.enableSupabaseWriteSqlMigration}
            onCheckedChange={handleMigrationSettingChange}
          />
          <div className="space-y-1">
            <Label
              htmlFor="supabase-migrations"
              className="text-sm font-medium"
            >
              Write SQL migration files
            </Label>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Generate SQL migration files when modifying your Supabase schema.
              This helps you track database changes in version control, though
              these files aren't used for chat context, which uses the live
              schema.
            </p>
          </div>
        </div>
      </div>
      {patDialog}
    </div>
  );
}
