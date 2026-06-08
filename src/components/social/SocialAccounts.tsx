/**
 * Accounts tab — connect provider accounts, configure OAuth app credentials,
 * and toggle per-account enabled / auto-reply state.
 */

import { Loader2, Plug, Settings2, Trash2 } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SocialProvider } from "@/db/social_schema";
import { showError, showSuccess } from "@/lib/toast";

import {
  useBeginSocialOAuth,
  useDisconnectSocialAccount,
  useSetSocialAppCredentials,
  useSocialAccounts,
  useSocialProviderConfig,
  useSocialProviders,
  useUpdateSocialAccount,
} from "@/hooks/useSocial";
import {
  PROVIDER_ACCENT,
  PROVIDER_LABEL,
  PROVIDER_ORDER,
  providerInitial,
} from "./shared";

function ProviderGlyph({ provider }: { provider: SocialProvider }) {
  return (
    <div
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border text-sm font-semibold ${PROVIDER_ACCENT[provider]}`}
    >
      {providerInitial(provider)}
    </div>
  );
}

export function SocialAccounts() {
  const { data: providers } = useSocialProviders();
  const { data: config } = useSocialProviderConfig();
  const { data: accounts, isLoading } = useSocialAccounts();
  const beginOAuth = useBeginSocialOAuth();
  const disconnect = useDisconnectSocialAccount();
  const updateAccount = useUpdateSocialAccount();
  const setCreds = useSetSocialAppCredentials();

  const [configProvider, setConfigProvider] = useState<SocialProvider | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [redirectUri, setRedirectUri] = useState("");

  const implemented = new Set(
    (providers ?? []).filter((p) => p.implemented).map((p) => p.provider),
  );
  const configuredMap = new Map(
    (config ?? []).map((c) => [c.provider, c]),
  );

  async function handleConnect(provider: SocialProvider) {
    try {
      await beginOAuth.mutateAsync(provider);
      showSuccess(`${PROVIDER_LABEL[provider]} connected.`);
    } catch (err) {
      showError(err);
    }
  }

  function openConfig(provider: SocialProvider) {
    setConfigProvider(provider);
    setClientId("");
    setClientSecret("");
    setRedirectUri(configuredMap.get(provider)?.redirectUri ?? "");
  }

  async function saveConfig() {
    if (!configProvider) return;
    try {
      await setCreds.mutateAsync({
        provider: configProvider,
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim() || undefined,
        redirectUri: redirectUri.trim() || undefined,
      });
      showSuccess(`${PROVIDER_LABEL[configProvider]} credentials saved.`);
      setConfigProvider(null);
    } catch (err) {
      showError(err);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Connect a platform</CardTitle>
          <CardDescription>
            Reddit, X, LinkedIn, Facebook and Instagram all connect via real
            OAuth. Add each platform's app credentials, then connect.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          {PROVIDER_ORDER.map((provider) => {
            const isImplemented = implemented.has(provider);
            const cfg = configuredMap.get(provider);
            const isConfigured = cfg?.configured ?? false;
            return (
              <div
                key={provider}
                className="flex items-center gap-3 rounded-xl border border-border/40 bg-muted/20 p-3"
              >
                <ProviderGlyph provider={provider} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {PROVIDER_LABEL[provider]}
                    </span>
                    {!isImplemented && (
                      <Badge variant="outline" className="text-[10px]">
                        Coming soon
                      </Badge>
                    )}
                    {isImplemented && isConfigured && (
                      <Badge variant="secondary" className="text-[10px]">
                        Configured
                      </Badge>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {isImplemented
                      ? isConfigured
                        ? "Ready to connect"
                        : "Add app credentials to connect"
                      : "Integration point ready"}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    title="App credentials"
                    onClick={() => openConfig(provider)}
                  >
                    <Settings2 className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      !isImplemented ||
                      !isConfigured ||
                      beginOAuth.isPending
                    }
                    onClick={() => handleConnect(provider)}
                  >
                    {beginOAuth.isPending &&
                    beginOAuth.variables === provider ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plug className="h-4 w-4" />
                    )}
                    <span className="ml-1">Connect</span>
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connected accounts</CardTitle>
          <CardDescription>
            {accounts?.length ?? 0} account
            {(accounts?.length ?? 0) === 1 ? "" : "s"} connected.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {!isLoading && (accounts?.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">
              No accounts yet. Connect a platform above.
            </p>
          )}
          {accounts?.map((account) => (
            <div
              key={account.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-border/40 bg-muted/20 p-3"
            >
              <ProviderGlyph provider={account.provider} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{account.label}</span>
                  {account.tokenStatus !== "ok" && (
                    <Badge variant="destructive" className="text-[10px]">
                      {account.tokenStatus}
                    </Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {account.handle ?? PROVIDER_LABEL[account.provider]}
                </p>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={account.enabled}
                    onCheckedChange={(v) =>
                      updateAccount.mutate({
                        accountId: account.id,
                        enabled: v,
                      })
                    }
                  />
                  Enabled
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={account.autoReply}
                    onCheckedChange={(v) =>
                      updateAccount.mutate({
                        accountId: account.id,
                        autoReply: v,
                      })
                    }
                  />
                  Auto-reply
                </label>
                <Button
                  size="icon"
                  variant="ghost"
                  title="Disconnect"
                  onClick={async () => {
                    try {
                      await disconnect.mutateAsync(account.id);
                      showSuccess("Account disconnected.");
                    } catch (err) {
                      showError(err);
                    }
                  }}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog
        open={configProvider !== null}
        onOpenChange={(open) => !open && setConfigProvider(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {configProvider
                ? `${PROVIDER_LABEL[configProvider]} app credentials`
                : "App credentials"}
            </DialogTitle>
            <DialogDescription>
              Stored encrypted on this device. These come from your OAuth app on
              the platform's developer portal.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Client ID</Label>
              <Input
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder="Client / app id"
              />
            </div>
            <div className="space-y-1">
              <Label>Client secret</Label>
              <Input
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder="Client secret (if required)"
              />
            </div>
            <div className="space-y-1">
              <Label>Redirect URI</Label>
              <Input
                value={redirectUri}
                onChange={(e) => setRedirectUri(e.target.value)}
                placeholder="http://localhost:53682/callback"
              />
              <p className="text-xs text-muted-foreground">
                Register this exact URI in the platform's OAuth app settings.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfigProvider(null)}>
              Cancel
            </Button>
            <Button
              onClick={saveConfig}
              disabled={!clientId.trim() || setCreds.isPending}
            >
              {setCreds.isPending && (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
