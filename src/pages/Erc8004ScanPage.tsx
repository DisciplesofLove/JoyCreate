/**
 * 8004scan — explorer dashboard for the on-chain agent economy.
 *
 * Browse the ERC-8004 Identity / Reputation registries, inspect ERC-1144
 * interface blueprints (store / drop / agent), and cross-reference the local
 * (off-chain) reputation rollup. This is the discovery surface that ties the
 * marketplace pipeline together.
 */

import React, { useState } from "react";

import {
  useErc8004Status,
  useErc8004AgentCount,
  useErc8004Agent,
  useErc8004ResolveByAddress,
  useErc8004Reputation,
} from "@/hooks/useErc8004";
import {
  useDropBlueprint,
  useStoreBlueprint,
  useAgentBlueprint,
} from "@/hooks/useBroker";
import { useReputationScores } from "@/hooks/use_agent_provenance";
import type {
  Erc8004ChainId,
  InterfaceBlueprint,
  X402ChainId,
} from "@/ipc/ipc_client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const SUPPORTED_CHAINS: { value: Erc8004ChainId; label: string }[] = [
  { value: "arbitrumSepolia", label: "Arbitrum Sepolia (testnet)" },
  { value: "arbitrumOne", label: "Arbitrum One (mainnet)" },
];

function shortHash(value: string, head = 6, tail = 4): string {
  if (!value) return "";
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

// ---------------------------------------------------------------------------
// Identity explorer
// ---------------------------------------------------------------------------

function IdentityExplorer({ chain }: { chain: Erc8004ChainId }) {
  const [agentIdInput, setAgentIdInput] = useState("");
  const [addressInput, setAddressInput] = useState("");
  const [resolvedFromAddress, setResolvedFromAddress] = useState<string | undefined>();

  const activeAgentId = resolvedFromAddress || agentIdInput || undefined;
  const agent = useErc8004Agent(activeAgentId, chain);
  const reputation = useErc8004Reputation(activeAgentId, chain);
  const resolve = useErc8004ResolveByAddress(
    addressInput.trim() ? addressInput.trim() : undefined,
    chain,
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Look up an agent</CardTitle>
          <CardDescription>
            By ERC-8004 agent id, or resolve an id from a wallet address.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="agent-id">Agent id</Label>
              <Input
                id="agent-id"
                placeholder="e.g. 1"
                value={agentIdInput}
                onChange={(e) => {
                  setAgentIdInput(e.target.value.replace(/[^0-9]/g, ""));
                  setResolvedFromAddress(undefined);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="agent-address">Resolve by address</Label>
              <div className="flex gap-2">
                <Input
                  id="agent-address"
                  placeholder="0x…"
                  value={addressInput}
                  onChange={(e) => setAddressInput(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={!addressInput.trim() || resolve.isFetching}
                  onClick={() => {
                    resolve.refetch().then((r) => {
                      if (r.data?.agentId && r.data.agentId !== "0") {
                        setResolvedFromAddress(r.data.agentId);
                        setAgentIdInput(r.data.agentId);
                      }
                    });
                  }}
                >
                  Resolve
                </Button>
              </div>
            </div>
          </div>

          {agent.isLoading && activeAgentId && (
            <p className="text-sm text-muted-foreground">Loading agent {activeAgentId}…</p>
          )}
          {agent.data && (
            <div className="rounded-lg border p-4 space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">#{agent.data.agentId}</Badge>
                <span className="font-medium">{agent.data.agentDomain || "—"}</span>
              </div>
              <div className="font-mono text-muted-foreground">
                {agent.data.agentAddress}
              </div>
              {reputation.data && (
                <div className="flex items-center gap-4 pt-2">
                  <span>
                    <span className="text-muted-foreground">Avg score:</span>{" "}
                    <strong>{reputation.data.average}</strong>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Feedback count:</span>{" "}
                    {reputation.data.count}
                  </span>
                </div>
              )}
            </div>
          )}
          {agent.isError && activeAgentId && (
            <p className="text-sm text-destructive">
              No agent found for id {activeAgentId}.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Blueprint inspector (ERC-1144)
// ---------------------------------------------------------------------------

type BlueprintKindChoice = "drop" | "store" | "agent";

function BlueprintField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 border-b last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-right break-all">{value}</span>
    </div>
  );
}

function BlueprintView({ bp }: { bp: InterfaceBlueprint }) {
  return (
    <div className="rounded-lg border p-4 space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <Badge>{bp.kind}</Badge>
        <Badge variant="outline">{bp.version}</Badge>
        {bp.ready ? (
          <Badge variant="default">ready</Badge>
        ) : (
          <Badge variant="destructive">not deployed</Badge>
        )}
        <span className="ml-auto text-muted-foreground">id {bp.resourceId}</span>
      </div>

      {bp.identity && (
        <div>
          <h4 className="font-semibold mb-1">Identity (ERC-8004)</h4>
          <BlueprintField label="Agent id" value={`#${bp.identity.agentId}`} />
          <BlueprintField label="Domain" value={bp.identity.agentDomain || "—"} />
          <BlueprintField label="Address" value={shortHash(bp.identity.agentAddress)} />
          {bp.identity.ensName && (
            <BlueprintField label="ENS" value={bp.identity.ensName} />
          )}
        </div>
      )}

      {bp.reputation && (
        <div>
          <h4 className="font-semibold mb-1">Reputation</h4>
          <BlueprintField label="Average" value={bp.reputation.average} />
          <BlueprintField label="Count" value={bp.reputation.count} />
        </div>
      )}

      {bp.store && (
        <div>
          <h4 className="font-semibold mb-1">Store</h4>
          <BlueprintField label="Store id" value={bp.store.storeId} />
          <BlueprintField label="Slug" value={bp.store.slug || "—"} />
          <BlueprintField label="Owner" value={shortHash(bp.store.owner)} />
          {bp.store.ensName && (
            <BlueprintField label="ENS" value={bp.store.ensName} />
          )}
        </div>
      )}

      {bp.capabilities.length > 0 && (
        <div>
          <h4 className="font-semibold mb-1">Capabilities</h4>
          {bp.capabilities.map((cap) => (
            <div key={cap.id} className="rounded border p-3 mb-2 space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{cap.id}</Badge>
                <span>{cap.name}</span>
                <span className="ml-auto font-mono">{cap.priceUsdc} USDC</span>
              </div>
              <BlueprintField
                label="Requires proof"
                value={cap.requiresProof ? "yes" : "no"}
              />
              <BlueprintField label="Pay to" value={shortHash(cap.payment.payTo)} />
              <BlueprintField label="Asset" value={shortHash(cap.payment.asset)} />
              <BlueprintField label="Invoke" value={cap.invocation.ipcChannel} />
            </div>
          ))}
        </div>
      )}

      <div>
        <h4 className="font-semibold mb-1">Contracts</h4>
        <BlueprintField
          label="RevenueSplitter"
          value={shortHash(bp.contracts.revenueSplitter)}
        />
        <BlueprintField label="USDC" value={shortHash(bp.contracts.usdc)} />
      </div>
    </div>
  );
}

function BlueprintInspector({ chain }: { chain: X402ChainId }) {
  const [kind, setKind] = useState<BlueprintKindChoice>("drop");
  const [id, setId] = useState("");
  const [submittedId, setSubmittedId] = useState<string | undefined>();

  const drop = useDropBlueprint(kind === "drop" ? submittedId : undefined, chain);
  const store = useStoreBlueprint(kind === "store" ? submittedId : undefined, chain);
  const agent = useAgentBlueprint(kind === "agent" ? submittedId : undefined, chain);

  const query = kind === "drop" ? drop : kind === "store" ? store : agent;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interface blueprint (ERC-1144)</CardTitle>
        <CardDescription>
          Resolve a machine-readable blueprint a consuming agent can pay and invoke.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          {(["drop", "store", "agent"] as BlueprintKindChoice[]).map((k) => (
            <Button
              key={k}
              size="sm"
              variant={kind === k ? "default" : "outline"}
              onClick={() => {
                setKind(k);
                setSubmittedId(undefined);
              }}
            >
              {k}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            placeholder={`${kind} id (e.g. 1)`}
            value={id}
            onChange={(e) => setId(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <Button disabled={!id} onClick={() => setSubmittedId(id)}>
            Resolve
          </Button>
        </div>

        {query.isLoading && submittedId && (
          <p className="text-sm text-muted-foreground">Building blueprint…</p>
        )}
        {query.isError && submittedId && (
          <p className="text-sm text-destructive">
            Failed to build blueprint for {kind} {submittedId}.
          </p>
        )}
        {query.data && <BlueprintView bp={query.data} />}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Local reputation bridge (off-chain rollup)
// ---------------------------------------------------------------------------

function LocalReputationPanel() {
  const scores = useReputationScores();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Local reputation (off-chain)</CardTitle>
        <CardDescription>
          The desktop rollup of A2A contracts and invocations, per principal DID.
          These feed the on-chain ReputationRegistry as feedback is submitted.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {scores.isLoading && (
          <p className="text-sm text-muted-foreground">Loading local scores…</p>
        )}
        {scores.data && scores.data.length === 0 && (
          <p className="text-sm text-muted-foreground">No local reputation yet.</p>
        )}
        {scores.data && scores.data.length > 0 && (
          <div className="space-y-2 text-sm">
            {scores.data.map((row) => (
              <div
                key={row.principalDid}
                className="rounded border p-3 flex items-center gap-4"
              >
                <span className="font-mono break-all flex-1">{row.principalDid}</span>
                <Badge variant="secondary">
                  {(row.successRate / 10).toFixed(1)}%
                </Badge>
                <span className="text-muted-foreground">
                  {row.settledContracts}/{row.totalContracts} settled
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function Erc8004ScanPage() {
  const [chain, setChain] = useState<Erc8004ChainId>("arbitrumSepolia");
  const status = useErc8004Status(chain);
  const count = useErc8004AgentCount(chain);

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold">8004scan</h1>
          <p className="text-muted-foreground">
            Explorer for the on-chain agent economy — identities, reputation and
            interface blueprints.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Chain</CardTitle>
            <CardDescription>Select the registry deployment to browse.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              {SUPPORTED_CHAINS.map((c) => (
                <Button
                  key={c.value}
                  variant={chain === c.value ? "default" : "outline"}
                  onClick={() => setChain(c.value)}
                  size="sm"
                >
                  {c.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-4 text-sm">
              {status.data?.ready ? (
                <Badge variant="default">registries live</Badge>
              ) : (
                <Badge variant="destructive">not deployed</Badge>
              )}
              {count.data && (
                <span className="text-muted-foreground">
                  {count.data.total} registered agents
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <Tabs defaultValue="identity">
          <TabsList>
            <TabsTrigger value="identity">Identity</TabsTrigger>
            <TabsTrigger value="blueprint">Blueprint</TabsTrigger>
            <TabsTrigger value="local">Local reputation</TabsTrigger>
          </TabsList>
          <TabsContent value="identity" className="mt-4">
            <IdentityExplorer chain={chain} />
          </TabsContent>
          <TabsContent value="blueprint" className="mt-4">
            <BlueprintInspector chain={chain as X402ChainId} />
          </TabsContent>
          <TabsContent value="local" className="mt-4">
            <LocalReputationPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
