import { useState } from "react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  GitFork,
  Globe,
  Network,
  Pin,
  PinOff,
  Plug,
  RefreshCw,
  Shield,
  Trash2,
  UploadCloud,
  Users,
} from "lucide-react";

import {
  useAddTrustedDid,
  useConnectSeed,
  useCreateRadicleIdentity,
  useDeleteSovereignModel,
  useDisconnectSeed,
  useForkLineage,
  useForkRoots,
  useHasRadicleIdentity,
  usePinSovereignModel,
  usePublishSovereignModel,
  useRadicleNodeStatus,
  useRadicleRepos,
  useRadicleSelf,
  useRegisterFork,
  useRemoveTrustedDid,
  useSeedPresets,
  useSeedRepo,
  useSeedSessions,
  useSetBaseToken,
  useSovereignModels,
  useSyncRadicleRepo,
  useTrustedDids,
  useUnpinSovereignModel,
  useUnseedRepo,
  useVerifySovereignModelAnchor,
} from "@/hooks/useSovereignForge";

export default function SovereignForgePage() {
  return (
    <div className="h-full flex flex-col p-6 gap-4 overflow-auto">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Network className="h-6 w-6" /> Sovereign Forge
          </h1>
          <p className="text-sm text-muted-foreground">
            Radicle P2P repos · Whitehat audit · Trusted DIDs
          </p>
        </div>
      </header>

      <Tabs defaultValue="node" className="flex-1 flex flex-col">
        <TabsList>
          <TabsTrigger value="node">Node</TabsTrigger>
          <TabsTrigger value="identity">Identity</TabsTrigger>
          <TabsTrigger value="repos">Repos</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="forks">Forks</TabsTrigger>
          <TabsTrigger value="seeds">Seeds</TabsTrigger>
          <TabsTrigger value="trust">Trust List</TabsTrigger>
        </TabsList>

        <TabsContent value="node" className="mt-4">
          <NodeTab />
        </TabsContent>
        <TabsContent value="identity" className="mt-4">
          <IdentityTab />
        </TabsContent>
        <TabsContent value="repos" className="mt-4">
          <ReposTab />
        </TabsContent>
        <TabsContent value="models" className="mt-4">
          <ModelsTab />
        </TabsContent>
        <TabsContent value="forks" className="mt-4">
          <ForksTab />
        </TabsContent>
        <TabsContent value="seeds" className="mt-4">
          <SeedsTab />
        </TabsContent>
        <TabsContent value="trust" className="mt-4">
          <TrustTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// =============================================================================
// NODE TAB
// =============================================================================

function NodeTab() {
  const status = useRadicleNodeStatus();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Radicle Node</CardTitle>
        <CardDescription>
          Heartwood (`rad node`) — local P2P daemon, ~/.radicle/.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status.isLoading && <p className="text-sm">Checking…</p>}
        {status.isError && (
          <p className="text-sm text-destructive">
            {(status.error as Error).message}
          </p>
        )}
        {status.data && (
          <div className="flex items-center gap-3">
            {status.data.running ? (
              <Badge className="bg-emerald-600">
                <CheckCircle2 className="h-3 w-3 mr-1" /> Running
              </Badge>
            ) : (
              <Badge variant="destructive">
                <AlertCircle className="h-3 w-3 mr-1" /> Stopped
              </Badge>
            )}
            {status.data.alias && (
              <span className="text-sm">alias: {status.data.alias}</span>
            )}
            {typeof status.data.peers === "number" && (
              <span className="text-sm text-muted-foreground">
                peers: {status.data.peers}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => status.refetch()}
              className="ml-auto"
            >
              <RefreshCw className="h-3 w-3 mr-1" /> Refresh
            </Button>
          </div>
        )}
        {status.data?.raw && (
          <pre className="text-xs bg-muted p-3 rounded max-h-64 overflow-auto whitespace-pre-wrap">
            {status.data.raw}
          </pre>
        )}
        <p className="text-xs text-muted-foreground">
          Use the System Services panel (or the tray menu) to start/stop the
          radicle service. The node listens for gossip on port 8776 and exposes
          its HTTP API on 8080.
        </p>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// IDENTITY TAB
// =============================================================================

function IdentityTab() {
  const has = useHasRadicleIdentity();
  const self = useRadicleSelf();
  const create = useCreateRadicleIdentity();
  const [alias, setAlias] = useState("");
  const [passphrase, setPassphrase] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Radicle Identity</CardTitle>
        <CardDescription>
          A `did:key` keypair stored in ~/.radicle/keys. The NID is your
          permanent peer address on the Sovereign Network.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {has.data === true && self.data ? (
          <div className="space-y-2">
            <div>
              <Label className="text-xs text-muted-foreground">DID</Label>
              <p className="font-mono text-xs break-all">{self.data.did}</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">NID</Label>
              <p className="font-mono text-xs break-all">{self.data.nid}</p>
            </div>
            {self.data.alias && (
              <div>
                <Label className="text-xs text-muted-foreground">Alias</Label>
                <p className="text-sm">{self.data.alias}</p>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="rad-alias">Alias</Label>
              <Input
                id="rad-alias"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="my-handle"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="rad-pass">Passphrase</Label>
              <Input
                id="rad-pass"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder="Used to encrypt the local key"
              />
            </div>
            <Button
              onClick={() => create.mutate({ alias, passphrase })}
              disabled={
                !alias.trim() || !passphrase || create.isPending
              }
            >
              {create.isPending ? "Creating…" : "Create Identity"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// REPOS TAB
// =============================================================================

function ReposTab() {
  const repos = useRadicleRepos();
  const sync = useSyncRadicleRepo();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sovereign Repos</CardTitle>
        <CardDescription>
          JoyCreate apps published to the Radicle network, plus repos this node
          is seeding.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {repos.isLoading && <p className="text-sm">Loading…</p>}
        {repos.isError && (
          <p className="text-sm text-destructive">
            {(repos.error as Error).message}
          </p>
        )}
        {repos.data && (
          <div className="space-y-2">
            {repos.data.registered.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No JoyCreate apps published yet. Use the Publish action on an
                app to push it to Radicle.
              </p>
            )}
            {repos.data.registered.map((r) => (
              <div
                key={r.rid}
                className="flex items-center gap-3 p-3 border rounded"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.name}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {r.visibility}
                    </Badge>
                    {r.whitehatPolicyHash && (
                      <Badge className="bg-emerald-600 text-[10px]">
                        <Shield className="h-3 w-3 mr-1" /> whitehat
                      </Badge>
                    )}
                  </div>
                  <p className="font-mono text-xs text-muted-foreground truncate">
                    {r.rid}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {r.peerCount} peer{r.peerCount === 1 ? "" : "s"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!r.appId || sync.isPending}
                  onClick={() =>
                    r.appId && sync.mutate({ appId: r.appId })
                  }
                >
                  <UploadCloud className="h-3 w-3 mr-1" /> Sync
                </Button>
              </div>
            ))}
            {repos.data.node.length > 0 && (
              <details className="mt-4">
                <summary className="text-sm cursor-pointer text-muted-foreground">
                  Node-tracked repos ({repos.data.node.length})
                </summary>
                <div className="mt-2 space-y-1">
                  {repos.data.node.map((r) => (
                    <div
                      key={r.rid}
                      className="flex items-center gap-2 text-xs"
                    >
                      <span className="font-mono">{r.rid}</span>
                      <span>{r.name}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =============================================================================
// TRUST TAB
// =============================================================================

function TrustTab() {
  const trust = useTrustedDids();
  const add = useAddTrustedDid();
  const remove = useRemoveTrustedDid();
  const [did, setDid] = useState("");
  const [label, setLabel] = useState("");
  const [level, setLevel] = useState<"full" | "manual-review" | "blocked">(
    "manual-review",
  );
  const [notes, setNotes] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" /> Trusted DIDs
        </CardTitle>
        <CardDescription>
          Pulls from `full` DIDs skip the LLM audit tier. `manual-review` always
          runs both tiers. `blocked` rejects the pull immediately. Paste the
          signer&apos;s ed25519 public key (hex) into &quot;notes&quot; to enable
          signature verification on whitehat audits.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="did:key:z…"
            value={did}
            onChange={(e) => setDid(e.target.value)}
          />
          <Input
            placeholder="Label (e.g. Alice)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <select
            value={level}
            onChange={(e) =>
              setLevel(e.target.value as typeof level)
            }
            className="border rounded px-3 py-2 text-sm bg-background"
          >
            <option value="full">full</option>
            <option value="manual-review">manual-review</option>
            <option value="blocked">blocked</option>
          </select>
          <Input
            placeholder="Public key hex (notes)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <Button
          onClick={() => {
            add.mutate({
              did: did.trim(),
              label: label.trim() || undefined,
              trustLevel: level,
              notes: notes.trim() || undefined,
            });
            setDid("");
            setLabel("");
            setNotes("");
          }}
          disabled={!did.trim() || add.isPending}
        >
          Add
        </Button>

        <div className="space-y-2 mt-4">
          {trust.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No trusted DIDs yet.
            </p>
          )}
          {trust.data?.map((t) => (
            <div
              key={t.did}
              className="flex items-center gap-3 p-3 border rounded"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {t.label ?? t.did}
                  </span>
                  <Badge
                    variant={
                      t.trustLevel === "blocked"
                        ? "destructive"
                        : t.trustLevel === "full"
                          ? "default"
                          : "secondary"
                    }
                    className="text-[10px]"
                  >
                    {t.trustLevel}
                  </Badge>
                </div>
                <p className="font-mono text-xs text-muted-foreground truncate">
                  {t.did}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove.mutate(t.did)}
                disabled={remove.isPending}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// MODELS TAB (Phase 5: IPFS-pinned + Celestia-anchored AI model weights)
// =============================================================================

function ModelsTab() {
  const models = useSovereignModels();
  const publish = usePublishSovereignModel();
  const pin = usePinSovereignModel();
  const unpin = useUnpinSovereignModel();
  const verify = useVerifySovereignModelAnchor();
  const del = useDeleteSovereignModel();

  const [filePath, setFilePath] = useState("");
  const [modelName, setModelName] = useState("");
  const [version, setVersion] = useState("");
  const [publisherDid, setPublisherDid] = useState("");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-5 w-5" /> Publish Model Weights
          </CardTitle>
          <CardDescription>
            Hash-and-pin a model weight file to the local Helia (IPFS) node and
            anchor the CID + sha256 to Celestia DA. The anchor commitment +
            block height become the model&apos;s permanent provenance.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1 col-span-2">
              <Label htmlFor="model-path">File path</Label>
              <Input
                id="model-path"
                value={filePath}
                onChange={(e) => setFilePath(e.target.value)}
                placeholder="C:\\path\\to\\model.gguf"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-name">Model name</Label>
              <Input
                id="model-name"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                placeholder="llama-3-8b-instruct-q4"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="model-version">Version</Label>
              <Input
                id="model-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
              />
            </div>
            <div className="space-y-1 col-span-2">
              <Label htmlFor="model-pub">Publisher DID (optional)</Label>
              <Input
                id="model-pub"
                value={publisherDid}
                onChange={(e) => setPublisherDid(e.target.value)}
                placeholder="did:key:z…"
              />
            </div>
          </div>
          <Button
            onClick={() => {
              publish.mutate(
                {
                  filePath: filePath.trim(),
                  modelName: modelName.trim(),
                  version: version.trim(),
                  publisherDid: publisherDid.trim() || undefined,
                  anchorToCelestia: true,
                },
                {
                  onSuccess: () => {
                    setFilePath("");
                    setModelName("");
                    setVersion("");
                  },
                },
              );
            }}
            disabled={
              !filePath.trim() ||
              !modelName.trim() ||
              !version.trim() ||
              publish.isPending
            }
          >
            <UploadCloud className="h-4 w-4 mr-1" />
            {publish.isPending ? "Publishing…" : "Publish to IPFS + Celestia"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Published Models</CardTitle>
          <CardDescription>
            All sovereign model CIDs known to this node, with their Celestia
            anchor heights.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {models.isLoading && <p className="text-sm">Loading…</p>}
          {models.isError && (
            <p className="text-sm text-destructive">
              {(models.error as Error).message}
            </p>
          )}
          {models.data && models.data.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No models published yet.
            </p>
          )}
          <div className="space-y-2">
            {models.data?.map((m) => (
              <div
                key={m.cid}
                className="flex items-start gap-3 p-3 border rounded"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">
                      {m.modelName}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      v{m.version}
                    </Badge>
                    {m.pinnedLocally ? (
                      <Badge className="bg-emerald-600 text-[10px]">
                        <Pin className="h-3 w-3 mr-1" /> pinned
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        unpinned
                      </Badge>
                    )}
                    {m.celestiaHeight ? (
                      <Badge className="bg-violet-600 text-[10px]">
                        Celestia #{m.celestiaHeight}
                      </Badge>
                    ) : (
                      <Badge variant="destructive" className="text-[10px]">
                        no anchor
                      </Badge>
                    )}
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground truncate">
                    CID: {m.cid}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground truncate">
                    sha256: {m.sha256}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {(m.sizeBytes / 1024 / 1024).toFixed(2)} MB
                    {m.publisherDid ? ` · ${m.publisherDid}` : ""}
                  </p>
                </div>
                <div className="flex flex-col gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      m.pinnedLocally
                        ? unpin.mutate(m.cid)
                        : pin.mutate(m.cid)
                    }
                    disabled={pin.isPending || unpin.isPending}
                  >
                    {m.pinnedLocally ? (
                      <PinOff className="h-3 w-3 mr-1" />
                    ) : (
                      <Pin className="h-3 w-3 mr-1" />
                    )}
                    {m.pinnedLocally ? "Unpin" : "Pin"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => verify.mutate(m.cid)}
                    disabled={verify.isPending}
                  >
                    <Shield className="h-3 w-3 mr-1" /> Verify
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (
                        confirm(
                          `Delete model ${m.modelName}@${m.version} (${m.cid.slice(0, 12)}…)?`,
                        )
                      ) {
                        del.mutate(m.cid);
                      }
                    }}
                    disabled={del.isPending}
                  >
                    <Trash2 className="h-3 w-3 mr-1" /> Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// =============================================================================
// FORKS TAB (Phase 6: ERC-1155 sovereign fork lineage)
// =============================================================================

function ForksTab() {
  const roots = useForkRoots();
  const setBase = useSetBaseToken();
  const registerFork = useRegisterFork();

  const [selectedRid, setSelectedRid] = useState<string | undefined>(undefined);
  const lineage = useForkLineage(selectedRid);

  const [baseRid, setBaseRid] = useState("");
  const [baseTokenId, setBaseTokenId] = useState("");
  const [childRid, setChildRid] = useState("");
  const [parentRid, setParentRid] = useState("");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitFork className="h-5 w-5" /> ERC-1155 Fork Lineage
          </CardTitle>
          <CardDescription>
            Link on-chain DropERC1155 base editions to sovereign repos and
            register fork relationships. The actual mint is performed by the
            standard publish workflow; this tab tracks parent/child token
            provenance for the fork graph.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Link base edition</h4>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Repo RID (rad:z…)"
                value={baseRid}
                onChange={(e) => setBaseRid(e.target.value)}
              />
              <Input
                placeholder="Base edition token id (e.g. 42)"
                value={baseTokenId}
                onChange={(e) => setBaseTokenId(e.target.value)}
              />
            </div>
            <Button
              onClick={() => {
                setBase.mutate(
                  {
                    rid: baseRid.trim(),
                    baseEditionTokenId: baseTokenId.trim(),
                  },
                  {
                    onSuccess: () => {
                      setBaseRid("");
                      setBaseTokenId("");
                    },
                  },
                );
              }}
              disabled={!baseRid.trim() || !baseTokenId.trim() || setBase.isPending}
            >
              Link Base Token
            </Button>
          </div>

          <div className="space-y-2">
            <h4 className="text-sm font-semibold">Register fork</h4>
            <div className="grid grid-cols-2 gap-2">
              <Input
                placeholder="Child RID (the new fork)"
                value={childRid}
                onChange={(e) => setChildRid(e.target.value)}
              />
              <Input
                placeholder="Parent RID (the source)"
                value={parentRid}
                onChange={(e) => setParentRid(e.target.value)}
              />
            </div>
            <Button
              onClick={() => {
                registerFork.mutate(
                  {
                    childRid: childRid.trim(),
                    parentRid: parentRid.trim(),
                  },
                  {
                    onSuccess: () => {
                      setChildRid("");
                      setParentRid("");
                    },
                  },
                );
              }}
              disabled={
                !childRid.trim() ||
                !parentRid.trim() ||
                registerFork.isPending
              }
            >
              <GitFork className="h-4 w-4 mr-1" />
              Register Fork
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Root Repos</CardTitle>
          <CardDescription>
            Repos with no parent — i.e. the top of every fork tree. Click a
            row to inspect its lineage.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {roots.isLoading && <p className="text-sm">Loading…</p>}
          {roots.isError && (
            <p className="text-sm text-destructive">
              {(roots.error as Error).message}
            </p>
          )}
          {roots.data && roots.data.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No repos registered yet.
            </p>
          )}
          <div className="space-y-2">
            {roots.data?.map((r) => (
              <button
                key={r.rid}
                type="button"
                onClick={() => setSelectedRid(r.rid)}
                className={`w-full text-left flex items-center gap-3 p-3 border rounded hover:bg-muted ${
                  selectedRid === r.rid ? "bg-muted" : ""
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{r.name}</span>
                    {r.baseEditionTokenId && (
                      <Badge className="bg-violet-600 text-[10px]">
                        token #{r.baseEditionTokenId}
                      </Badge>
                    )}
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground truncate">
                    {r.rid}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {selectedRid && (
        <Card>
          <CardHeader>
            <CardTitle>Lineage</CardTitle>
            <CardDescription>
              Root → … → selected. Each row shows the on-chain base edition
              token id that forks of that node inherit as their parent token.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {lineage.isLoading && <p className="text-sm">Loading…</p>}
            {lineage.data && (
              <ol className="space-y-2">
                {lineage.data.map((node, idx) => (
                  <li
                    key={node.rid}
                    className="flex items-center gap-3 p-3 border rounded"
                  >
                    <span className="text-xs text-muted-foreground w-6 text-right">
                      {idx + 1}.
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{node.name}</span>
                        {node.baseEditionTokenId && (
                          <Badge className="bg-violet-600 text-[10px]">
                            base #{node.baseEditionTokenId}
                          </Badge>
                        )}
                        {node.parentEditionTokenId && (
                          <Badge variant="outline" className="text-[10px]">
                            parent #{node.parentEditionTokenId}
                          </Badge>
                        )}
                      </div>
                      <p className="font-mono text-[11px] text-muted-foreground truncate">
                        {node.rid}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// =============================================================================
// SEEDS TAB — Public Radicle seed nodes + arbitrary peer connections
// =============================================================================

function SeedsTab() {
  const presets = useSeedPresets();
  const sessions = useSeedSessions();
  const repos = useRadicleRepos();
  const connect = useConnectSeed();
  const disconnect = useDisconnectSeed();
  const seedRepoMut = useSeedRepo();
  const unseedRepoMut = useUnseedRepo();

  const [customAddr, setCustomAddr] = useState("");
  const [seedRid, setSeedRid] = useState("");
  const [seedScope, setSeedScope] = useState<"all" | "trusted">("all");

  const sessionByNid = new Map(
    (sessions.data ?? []).map((s) => [s.nid, s] as const),
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" /> Public Seed Nodes
          </CardTitle>
          <CardDescription>
            Connect your local node to public Radicle seeds so your repos
            propagate across the network and you receive updates from others.
            Sourced from{" "}
            <a
              href="https://radicle.network/nodes/"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              radicle.network/nodes
            </a>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {presets.isLoading && <p className="text-sm">Loading…</p>}
          {presets.data?.map((p) => {
            const nid = p.address.split("@")[0];
            const session = sessionByNid.get(nid);
            const isConnected =
              session?.status === "connected" || session?.status === "connecting";
            return (
              <div
                key={p.id}
                className="flex items-start gap-3 p-3 border rounded"
              >
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{p.name}</span>
                    {isConnected ? (
                      <Badge className="bg-emerald-600 text-[10px]">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        {session?.status}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        not connected
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {p.description}
                  </p>
                  <p className="font-mono text-[11px] text-muted-foreground break-all">
                    {p.address}
                  </p>
                </div>
                {isConnected ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => disconnect.mutate(nid)}
                    disabled={disconnect.isPending}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => connect.mutate(p.address)}
                    disabled={connect.isPending}
                  >
                    <Plug className="h-3 w-3 mr-1" /> Connect
                  </Button>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Custom Peer</CardTitle>
          <CardDescription>
            Connect to any peer or community seed by NID + address.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            placeholder="z6Mk…@host:8776"
            value={customAddr}
            onChange={(e) => setCustomAddr(e.target.value)}
          />
          <Button
            onClick={() => {
              connect.mutate(customAddr.trim(), {
                onSuccess: () => setCustomAddr(""),
              });
            }}
            disabled={!customAddr.trim() || connect.isPending}
          >
            <Plug className="h-4 w-4 mr-1" /> Connect Peer
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Active Sessions</CardTitle>
          <CardDescription>
            Live peers reported by `rad node sessions`. Updates every 15s.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessions.isLoading && <p className="text-sm">Loading…</p>}
          {sessions.data && sessions.data.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No active sessions. Start the radicle node and connect to a seed
              above.
            </p>
          )}
          <div className="space-y-1">
            {sessions.data?.map((s) => (
              <div
                key={s.nid}
                className="flex items-center gap-2 p-2 border rounded text-xs"
              >
                <span className="font-mono break-all flex-1">{s.nid}</span>
                {s.address && (
                  <span className="text-muted-foreground">{s.address}</span>
                )}
                <Badge variant="outline" className="text-[10px]">
                  {s.status ?? "unknown"}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => disconnect.mutate(s.nid)}
                  disabled={disconnect.isPending}
                >
                  Disconnect
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Seed a Repo</CardTitle>
          <CardDescription>
            Subscribe the local node to a remote RID so it pulls and re-serves
            updates. Use scope &quot;trusted&quot; to only follow delegate refs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <Input
              className="col-span-2"
              placeholder="rad:z…"
              value={seedRid}
              onChange={(e) => setSeedRid(e.target.value)}
            />
            <select
              value={seedScope}
              onChange={(e) =>
                setSeedScope(e.target.value as "all" | "trusted")
              }
              className="border rounded px-3 py-2 text-sm bg-background"
            >
              <option value="all">scope: all</option>
              <option value="trusted">scope: trusted</option>
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => {
                seedRepoMut.mutate(
                  { rid: seedRid.trim(), scope: seedScope },
                  { onSuccess: () => setSeedRid("") },
                );
              }}
              disabled={!seedRid.trim() || seedRepoMut.isPending}
            >
              Seed
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                unseedRepoMut.mutate(seedRid.trim(), {
                  onSuccess: () => setSeedRid(""),
                })
              }
              disabled={!seedRid.trim() || unseedRepoMut.isPending}
            >
              Unseed
            </Button>
          </div>
          {repos.data && repos.data.registered.length > 0 && (
            <div className="pt-3 space-y-1 border-t">
              <p className="text-xs text-muted-foreground">
                Quick-seed your registered repos:
              </p>
              {repos.data.registered.map((r) => (
                <div
                  key={r.rid}
                  className="flex items-center gap-2 text-xs p-2 border rounded"
                >
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="font-mono text-muted-foreground truncate">
                    {r.rid}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      seedRepoMut.mutate({ rid: r.rid, scope: "all" })
                    }
                    disabled={seedRepoMut.isPending}
                  >
                    Seed
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
