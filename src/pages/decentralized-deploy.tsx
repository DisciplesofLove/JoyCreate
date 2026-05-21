/**
 * Decentralized Deploy Page
 * Deploy apps to 4everland, Fleek, IPFS, Arweave, and other Web3 platforms
 */

import { useState, useEffect, useMemo } from "react";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom, appsListAtom } from "@/atoms/appAtoms";
import {
  useDecentralizedPlatforms,
  useDecentralizedCredentials,
  useSaveDecentralizedCredentials,
  useRemoveDecentralizedCredentials,
  useDecentralizedDeploy,
  useDecentralizedDeployments,
  type DecentralizedCredentials,
} from "@/hooks/useDecentralizedDeploy";
import { GitHubConnector } from "@/components/GitHubConnector";
import { VercelConnector } from "@/components/VercelConnector";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Globe,
  Key,
  Upload,
  Check,
  Clock,
  ExternalLink,
  Copy,
  Trash2,
  Settings,
  Loader2,
  Shield,
  Infinity,
  Database,
  Coins,
  Box,
  Link2,
} from "lucide-react";
import { format } from "date-fns";

// Platform icons/logos
const PLATFORM_ICONS: Record<string, React.ReactNode> = {
  "4everland": <Box className="h-5 w-5 text-blue-500" />,
  fleek: <Globe className="h-5 w-5 text-yellow-500" />,
  "ipfs-pinata": <Database className="h-5 w-5 text-purple-500" />,
  "ipfs-infura": <Database className="h-5 w-5 text-orange-500" />,
  "ipfs-web3storage": <Database className="h-5 w-5 text-cyan-500" />,
  arweave: <Infinity className="h-5 w-5 text-gray-400" />,
  filecoin: <Coins className="h-5 w-5 text-green-500" />,
  skynet: <Globe className="h-5 w-5 text-red-500" />,
  spheron: <Shield className="h-5 w-5 text-indigo-500" />,
  filebase: <Database className="h-5 w-5 text-pink-500" />,
};

const PERMANENCE_COLORS: Record<string, string> = {
  permanent: "bg-purple-500/10 text-purple-400 border-purple-500/30",
  pinned: "bg-blue-500/10 text-blue-400 border-blue-500/30",
  temporary: "bg-yellow-500/10 text-yellow-400 border-yellow-500/30",
};

export default function DecentralizedDeployPage() {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const apps = useAtomValue(appsListAtom);
  const app = useMemo(
    () => apps.find((a) => a.id === selectedAppId),
    [apps, selectedAppId]
  );
  const { data: platforms, isLoading: platformsLoading } =
    useDecentralizedPlatforms();
  const { data: deployments, isLoading: deploymentsLoading } =
    useDecentralizedDeployments(selectedAppId ?? undefined);

  const [selectedPlatform, setSelectedPlatform] = useState<string>("4everland");
  const [showCredentialsDialog, setShowCredentialsDialog] = useState(false);
  const [showDeployDialog, setShowDeployDialog] = useState(false);

  // Get first platform if available
  useEffect(() => {
    if (platforms && Object.keys(platforms).length > 0 && !selectedPlatform) {
      setSelectedPlatform(Object.keys(platforms)[0]);
    }
  }, [platforms, selectedPlatform]);

  if (platformsLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const platformList = platforms ? Object.values(platforms) : [];
  const currentPlatform = platforms?.[selectedPlatform];
  const appDeployments =
    deployments?.filter((d) => d.appId === selectedAppId) ?? [];

  return (
    <div className="flex flex-col h-full p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Publish &amp; Deploy
          </h1>
          <p className="text-muted-foreground">
            Pick any host — centralized (Vercel, GitHub Pages) or decentralized
            (IPFS, Arweave, 4everland, Fleek, Spheron) — for this deployment.
          </p>
        </div>
        {app && (
          <Badge variant="outline" className="text-sm">
            {app.name}
          </Badge>
        )}
      </div>

      {/* Centralized providers (Vercel + GitHub) */}
      {selectedAppId && app && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z" clipRule="evenodd" />
                </svg>
                GitHub
              </CardTitle>
              <CardDescription>Sync code to GitHub (required for Vercel).</CardDescription>
            </CardHeader>
            <CardContent>
              <GitHubConnector appId={selectedAppId} folderName={app.name} expanded />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M24 22.525H0l12-21.05 12 21.05z" />
                </svg>
                Vercel
              </CardTitle>
              <CardDescription>Centralized hosting with global CDN and HTTPS.</CardDescription>
            </CardHeader>
            <CardContent>
              {!app.githubOrg || !app.githubRepo ? (
                <p className="text-sm text-muted-foreground">
                  Connect GitHub first — Vercel deploys from a repository.
                </p>
              ) : (
                <VercelConnector appId={selectedAppId} folderName={app.name} />
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-2">Decentralized Providers</h2>
        <p className="text-sm text-muted-foreground mb-3">
          Permanent, censorship-resistant hosting on IPFS, Arweave, and Web3 networks.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1">
        {/* Platform Selection */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              Platforms
            </CardTitle>
            <CardDescription>
              Choose a decentralized storage platform
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ScrollArea className="h-[400px] pr-4">
              <div className="space-y-2">
                {platformList.map((platform) => (
                  <button
                    key={platform.id}
                    onClick={() => setSelectedPlatform(platform.id)}
                    className={cn(
                      "w-full p-3 rounded-lg border text-left transition-colors",
                      selectedPlatform === platform.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      {PLATFORM_ICONS[platform.id] || (
                        <Globe className="h-5 w-5" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="font-medium">{platform.name}</div>
                        <div className="text-xs text-muted-foreground truncate">
                          {platform.pricing}
                        </div>
                      </div>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-xs",
                          PERMANENCE_COLORS[platform.permanence] || "bg-gray-500/10 text-gray-400 border-gray-500/30"
                        )}
                      >
                        {platform.permanence}
                      </Badge>
                    </div>
                  </button>
                ))}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        {/* Platform Details & Deploy */}
        <Card className="lg:col-span-2">
          {currentPlatform ? (
            <>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {PLATFORM_ICONS[currentPlatform.id] || (
                      <Globe className="h-6 w-6" />
                    )}
                    <div>
                      <CardTitle>{currentPlatform.name}</CardTitle>
                      <CardDescription>
                        {currentPlatform.description}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setShowCredentialsDialog(true)}
                    >
                      <Key className="h-4 w-4 mr-2" />
                      Configure
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setShowDeployDialog(true)}
                      disabled={!selectedAppId}
                    >
                      <Upload className="h-4 w-4 mr-2" />
                      Deploy
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Tabs defaultValue="features">
                  <TabsList className="mb-4">
                    <TabsTrigger value="features">Features</TabsTrigger>
                    <TabsTrigger value="deployments">
                      Deployments{" "}
                      {appDeployments.length > 0 && (
                        <Badge variant="secondary" className="ml-2">
                          {
                            appDeployments.filter(
                              (d) => d.platform === selectedPlatform
                            ).length
                          }
                        </Badge>
                      )}
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="features" className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1">
                        <Label className="text-muted-foreground">
                          Permanence
                        </Label>
                        <p className="font-medium capitalize">
                          {currentPlatform.permanence}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-muted-foreground">
                          Pricing
                        </Label>
                        <p className="font-medium capitalize">
                          {currentPlatform.pricing}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-muted-foreground">
                          Custom Domains
                        </Label>
                        <p className="font-medium">
                          {currentPlatform.supportsCustomDomains ? "Yes" : "No"}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-muted-foreground">
                          Requirements
                        </Label>
                        <div className="flex gap-2">
                          {currentPlatform.requiresApiKey && (
                            <Badge variant="outline">API Key</Badge>
                          )}
                          {currentPlatform.supportsENS && (
                            <Badge variant="outline">ENS Support</Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <Separator />
                    <div className="space-y-2">
                      <Label className="text-muted-foreground">Features</Label>
                      <div className="flex flex-wrap gap-2">
                        {currentPlatform.features.map((feature) => (
                          <Badge
                            key={feature}
                            variant="secondary"
                            className="capitalize"
                          >
                            {feature.replace(/-/g, " ")}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="deployments">
                    <DeploymentList
                      deployments={appDeployments.filter(
                        (d) => d.platform === selectedPlatform
                      )}
                      loading={deploymentsLoading}
                    />
                  </TabsContent>
                </Tabs>
              </CardContent>
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-muted-foreground">Select a platform</p>
            </div>
          )}
        </Card>
      </div>

      {/* Credentials Dialog */}
      {currentPlatform && (
        <CredentialsDialog
          platform={currentPlatform}
          open={showCredentialsDialog}
          onOpenChange={setShowCredentialsDialog}
        />
      )}

      {/* Deploy Dialog */}
      {currentPlatform && selectedAppId && (
        <DeployDialog
          platform={currentPlatform}
          appId={selectedAppId}
          open={showDeployDialog}
          onOpenChange={setShowDeployDialog}
        />
      )}
    </div>
  );
}

// Credentials Configuration Dialog
function CredentialsDialog({
  platform,
  open,
  onOpenChange,
}: {
  platform: {
    id: string;
    name: string;
    requiresApiKey: boolean;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: credentials, isLoading } = useDecentralizedCredentials(
    platform.id
  );
  const saveMutation = useSaveDecentralizedCredentials();
  const removeMutation = useRemoveDecentralizedCredentials();

  const [apiKey, setApiKey] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    if (credentials) {
      setProjectId(credentials.projectId || "");
    }
  }, [credentials]);

  const handleSave = () => {
    saveMutation.mutate(
      {
        platform: platform.id,
        credentials: {
          platform: platform.id,
          apiKey: apiKey || undefined,
          accessToken: accessToken || undefined,
          projectId: projectId || undefined,
        },
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          setApiKey("");
          setAccessToken("");
        },
      }
    );
  };

  const handleRemove = () => {
    removeMutation.mutate(platform.id, {
      onSuccess: () => onOpenChange(false),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            Configure {platform.name}
          </DialogTitle>
          <DialogDescription>
            Enter your API credentials for {platform.name}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            {credentialHintFor(platform.id) && (
              <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg text-xs text-blue-200 whitespace-pre-wrap">
                {credentialHintFor(platform.id)}
              </div>
            )}
            {credentials?.hasApiKey && (
              <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2">
                <Check className="h-4 w-4 text-green-500" />
                <span className="text-sm text-green-400">
                  API credentials configured
                </span>
              </div>
            )}

            {platform.requiresApiKey && (
              <div className="space-y-2">
                <Label htmlFor="apiKey">{apiKeyLabelFor(platform.id)}</Label>
                <Input
                  id="apiKey"
                  type="password"
                  placeholder={apiKeyPlaceholderFor(platform.id)}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="accessToken">{accessTokenLabelFor(platform.id)}</Label>
              {platform.id === "arweave" ? (
                <Textarea
                  id="accessToken"
                  rows={6}
                  placeholder='{"kty":"RSA","n":"...","e":"AQAB",...}'
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  className="font-mono text-xs"
                />
              ) : (
                <Input
                  id="accessToken"
                  type="password"
                  placeholder="Enter access token if required"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                />
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="projectId">{projectIdLabelFor(platform.id)}</Label>
              <Input
                id="projectId"
                placeholder={projectIdPlaceholderFor(platform.id)}
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {credentials?.hasApiKey && (
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removeMutation.isPending}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Remove
            </Button>
          )}
          <Button
            onClick={handleSave}
            disabled={saveMutation.isPending || (!apiKey && !accessToken)}
          >
            {saveMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Deploy Dialog
function DeployDialog({
  platform,
  appId,
  open,
  onOpenChange,
}: {
  platform: { id: string; name: string };
  appId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deployMutation = useDecentralizedDeploy();

  const [buildCommand, setBuildCommand] = useState("npm run build");
  const [outputDir, setOutputDir] = useState("dist");
  const [ensName, setEnsName] = useState("");

  const handleDeploy = () => {
    deployMutation.mutate(
      {
        appId,
        platform: platform.id,
        buildCommand,
        outputDir,
        ensName: ensName || undefined,
      },
      {
        onSuccess: (result) => {
          if (result.success) {
            onOpenChange(false);
          }
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Deploy to {platform.name}
          </DialogTitle>
          <DialogDescription>
            Configure your deployment settings
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="buildCommand">Build Command</Label>
            <Input
              id="buildCommand"
              placeholder="npm run build"
              value={buildCommand}
              onChange={(e) => setBuildCommand(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Command to build your app (leave empty to deploy existing files)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="outputDir">Output Directory</Label>
            <Input
              id="outputDir"
              placeholder="dist"
              value={outputDir}
              onChange={(e) => setOutputDir(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Directory containing your built files
            </p>
          </div>

          {platform.id !== "arweave" && (
            <div className="space-y-2">
              <Label htmlFor="ensName">ENS Name (optional)</Label>
              <Input
                id="ensName"
                placeholder="myapp.eth"
                value={ensName}
                onChange={(e) => setEnsName(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Link your deployment to an ENS domain
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleDeploy} disabled={deployMutation.isPending}>
            {deployMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Deploying...
              </>
            ) : (
              <>
                <Upload className="h-4 w-4 mr-2" />
                Deploy
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Deployment List Component
function DeploymentList({
  deployments,
  loading,
}: {
  deployments: Array<{
    id: string;
    status: string;
    cid?: string;
    url: string;
    gatewayUrls: string[];
    createdAt: number;
  }>;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (deployments.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Globe className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>No deployments yet</p>
        <p className="text-sm">Deploy your app to see it here</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-[300px]">
      <div className="space-y-3">
        {deployments.map((deployment) => (
          <div
            key={deployment.id}
            className="p-4 border rounded-lg space-y-3"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge
                  variant={
                    deployment.status === "live" ? "default" : "secondary"
                  }
                >
                  {deployment.status === "live" ? (
                    <Check className="h-3 w-3 mr-1" />
                  ) : (
                    <Clock className="h-3 w-3 mr-1" />
                  )}
                  {deployment.status}
                </Badge>
                {deployment.cid && (
                  <code className="text-xs bg-muted px-2 py-1 rounded">
                    {deployment.cid.slice(0, 12)}...
                  </code>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {format(new Date(deployment.createdAt), "MMM d, yyyy HH:mm")}
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.open(deployment.url, "_blank")}
              >
                <ExternalLink className="h-3 w-3 mr-2" />
                View
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard.writeText(deployment.url)}
              >
                <Copy className="h-3 w-3 mr-2" />
                Copy URL
              </Button>
              {deployment.cid && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    navigator.clipboard.writeText(deployment.cid!)
                  }
                >
                  <Link2 className="h-3 w-3 mr-2" />
                  Copy CID
                </Button>
              )}
            </div>

            {deployment.gatewayUrls.length > 1 && (
              <div className="text-xs text-muted-foreground">
                <span className="font-medium">Gateways:</span>{" "}
                {deployment.gatewayUrls.slice(0, 3).join(" • ")}
              </div>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ---------------------------------------------------------------------------
// Per-platform credential field labels + hints.
//
// Different providers expect very different credential shapes (Fleek wants a
// Personal Access Token + Site ID; Arweave wants the raw JWK wallet JSON;
// Pinata wants a JWT). The generic dialog above stays simple by deferring
// the copy to these helpers.
// ---------------------------------------------------------------------------

function credentialHintFor(platformId: string): string | null {
  switch (platformId) {
    case "arweave":
      return "Paste your Arweave wallet JWK (the full JSON file contents) into the Access Token field. Each file in your build will be signed and posted to the permaweb, and the manifest transaction id becomes your deployment URL.";
    case "fleek":
      return "Generate a Personal Access Token in Fleek\u2192Settings\u2192Personal Access Tokens and paste it as API Key. Set Project / Site ID to the target site\u2019s id (Fleek dashboard URL).";
    case "ipfs-pinata":
      return "Use a Pinata JWT (Account\u2192API Keys) as the API Key. Bearer-style auth.";
    case "ipfs-web3storage":
      return "web3.storage\u2019s legacy upload API is deprecated. Use Pinata or 4everland for IPFS pinning instead.";
    case "spheron":
      return "Use a Spheron access token (Dashboard\u2192Settings\u2192Tokens) as the API Key.";
    case "4everland":
      return "Use a 4EVERLAND Hosting API token as the API Key.";
    default:
      return null;
  }
}

function apiKeyLabelFor(platformId: string): string {
  switch (platformId) {
    case "fleek":
      return "Personal Access Token";
    case "ipfs-pinata":
      return "Pinata JWT";
    case "arweave":
      return "API Key (unused for Arweave \u2014 leave blank)";
    default:
      return "API Key";
  }
}

function apiKeyPlaceholderFor(platformId: string): string {
  switch (platformId) {
    case "fleek":
      return "pat_...";
    case "ipfs-pinata":
      return "eyJhbGciOi...";
    default:
      return "Enter your API key";
  }
}

function accessTokenLabelFor(platformId: string): string {
  if (platformId === "arweave") return "Wallet JWK (JSON)";
  return "Access Token (optional)";
}

function projectIdLabelFor(platformId: string): string {
  if (platformId === "fleek") return "Site ID (required)";
  return "Project ID (optional)";
}

function projectIdPlaceholderFor(platformId: string): string {
  if (platformId === "fleek") return "site_...";
  return "Enter project ID";
}
