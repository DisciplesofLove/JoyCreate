/**
 * SSICredentialsPanel — body of the former /ssi-credentials page,
 * reused inside /identity?tab=ssi.
 *
 * Phase 2 nav consolidation: see briefs/nav-consolidation-audit.md (Cluster 5).
 *
 * This panel used to be a mockup: four hardcoded credentials, form fields bound
 * to nothing, and two buttons that raised "Credential issued!" and "Credential
 * verified ✅" without calling anything. The claim was the problem — a panel
 * that tells you a credential verified when it never looked at one is worse
 * than a panel that admits it cannot. The whole backend was already there
 * (`ssi:credential:issue|verify|list|revoke`, `ssi:identity:list`), so this now
 * talks to it and reports exactly what comes back, failures included.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Shield,
  CheckCircle2,
  XCircle,
  Key,
  FileText,
  Search,
  Download,
  Eye,
  Clock,
  Stamp,
  Loader2,
  Ban,
  RefreshCw,
} from "lucide-react";

import { SsiClient } from "@/ipc/ssi_client";
import type {
  CredentialType,
  DIDString,
  SSICredentialVerifyResult,
  SSIIdentity,
  StoredCredential,
  VerifiableCredential,
} from "@/types/ssi_types";

/** The credential types the issuer actually accepts. */
const CREDENTIAL_TYPES: Array<{ value: CredentialType; label: string }> = [
  { value: "IdentityCredential", label: "Identity" },
  { value: "ProvenanceCredential", label: "Provenance" },
  { value: "ReputationCredential", label: "Reputation" },
  { value: "DomainVerificationCredential", label: "Domain verification" },
  { value: "SocialProofCredential", label: "Social proof" },
  { value: "VerifiableCredential", label: "Generic" },
];

const STATUS_CONFIG = {
  active: {
    label: "Active",
    color: "bg-green-500/20 text-green-400",
    icon: <CheckCircle2 className="w-3 h-3" />,
  },
  revoked: {
    label: "Revoked",
    color: "bg-red-500/20 text-red-400",
    icon: <XCircle className="w-3 h-3" />,
  },
  expired: {
    label: "Expired",
    color: "bg-amber-500/20 text-amber-400",
    icon: <Clock className="w-3 h-3" />,
  },
  suspended: {
    label: "Suspended",
    color: "bg-slate-500/20 text-slate-400",
    icon: <Ban className="w-3 h-3" />,
  },
} as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Save a credential to disk through the browser, as a .jsonld file. */
function downloadCredential(id: string, credential: unknown) {
  const blob = new Blob([JSON.stringify(credential, null, 2)], {
    type: "application/ld+json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${id}.jsonld`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── My credentials ───────────────────────────────────────────────────────────

function MyCredentialsTab({
  identities,
}: {
  identities: SSIIdentity[];
}) {
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCredentials(await SsiClient.getInstance().listCredentials());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onView = async (cred: StoredCredential) => {
    setBusyId(cred.id);
    try {
      const vc = await SsiClient.getInstance().getCredential(cred.id);
      // The stored JSON is the credential; showing it beats a modal that
      // paraphrases it, because a credential is only meaningful in full.
      console.info("credential", vc);
      toast.success("Credential written to the console", {
        description: cred.id,
      });
    } catch (err) {
      toast.error(`Could not read credential: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onExport = async (cred: StoredCredential) => {
    setBusyId(cred.id);
    try {
      const vc = await SsiClient.getInstance().exportCredential(cred.id);
      downloadCredential(cred.id, vc);
      toast.success("Credential exported");
    } catch (err) {
      toast.error(`Export failed: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const onRevoke = async (cred: StoredCredential) => {
    // Revocation is permanent and visible to every verifier, so it asks first.
    if (
      !window.confirm(
        `Revoke ${cred.type} ${cred.id}?\n\nThis cannot be undone, and any verifier checking this credential will see it as revoked.`,
      )
    ) {
      return;
    }
    setBusyId(cred.id);
    try {
      await SsiClient.getInstance().revokeCredential(cred.id, cred.issuerDid);
      toast.success("Credential revoked");
      await load();
    } catch (err) {
      toast.error(`Revoke failed: ${errorMessage(err)}`);
    } finally {
      setBusyId(null);
    }
  };

  const issuerDids = useMemo(
    () => new Set(identities.map((i) => i.did)),
    [identities],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-6">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading credentials…
      </div>
    );
  }

  if (error) {
    return (
      <Card className="bg-red-500/5 border-red-500/20">
        <CardContent className="p-4 space-y-2">
          <p className="text-sm text-red-400">Could not load credentials</p>
          <p className="text-xs text-muted-foreground font-mono">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (credentials.length === 0) {
    return (
      <Card className="bg-muted/10 border-border/30">
        <CardContent className="p-6 text-center space-y-1">
          <Stamp className="w-6 h-6 mx-auto text-muted-foreground/40" />
          <p className="text-sm">No credentials yet</p>
          <p className="text-xs text-muted-foreground">
            Issue one from the Issue tab, or import a credential someone else
            issued to you.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {credentials.length} credential{credentials.length === 1 ? "" : "s"}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      {credentials.map((cred) => {
        const status = STATUS_CONFIG[cred.status] ?? STATUS_CONFIG.active;
        const mine = issuerDids.has(cred.issuerDid);
        return (
          <Card key={cred.id} className="bg-muted/10 border-border/30">
            <CardContent className="p-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
                <Stamp className="w-5 h-5 text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{cred.type}</span>
                  <Badge className={`${status.color} text-[9px]`}>
                    {status.icon}
                    <span className="ml-0.5">{status.label}</span>
                  </Badge>
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  <span className="text-[10px] text-muted-foreground/50 font-mono truncate max-w-[220px]">
                    {cred.subjectDid}
                  </span>
                  <span className="text-[10px] text-muted-foreground/40">
                    Issued {new Date(cred.issuedAt).toLocaleDateString()}
                  </span>
                  {cred.expiresAt && (
                    <span className="text-[10px] text-muted-foreground/40">
                      Expires {new Date(cred.expiresAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[10px]"
                  disabled={busyId === cred.id}
                  onClick={() => void onView(cred)}
                >
                  <Eye className="w-3 h-3 mr-0.5" /> View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-[10px]"
                  disabled={busyId === cred.id}
                  onClick={() => void onExport(cred)}
                >
                  <Download className="w-3 h-3 mr-0.5" /> Export
                </Button>
                {/* Only the issuer can revoke, so the button is hidden rather
                    than shown-and-failing for credentials issued elsewhere. */}
                {mine && cred.status === "active" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-[10px] text-red-400 hover:text-red-300"
                    disabled={busyId === cred.id}
                    onClick={() => void onRevoke(cred)}
                  >
                    <Ban className="w-3 h-3 mr-0.5" /> Revoke
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ── Issue ────────────────────────────────────────────────────────────────────

function IssueCredentialTab({ identities }: { identities: SSIIdentity[] }) {
  const [issuerDid, setIssuerDid] = useState<string>("");
  const [subjectDid, setSubjectDid] = useState("");
  const [type, setType] = useState<CredentialType>("IdentityCredential");
  const [claimsText, setClaimsText] = useState("");
  const [expiration, setExpiration] = useState("");
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<VerifiableCredential | null>(null);

  useEffect(() => {
    if (!issuerDid && identities.length > 0) setIssuerDid(identities[0].did);
  }, [identities, issuerDid]);

  const onIssue = async () => {
    if (!issuerDid) {
      toast.error("No issuing identity available. Create one on the Identity tab first.");
      return;
    }
    if (!subjectDid.trim()) {
      toast.error("Subject DID is required");
      return;
    }

    // Claims are free-form JSON, so a typo here would otherwise surface as an
    // opaque failure from the issuer. Parse first and say which it was.
    let claims: Record<string, unknown> = {};
    if (claimsText.trim()) {
      try {
        const parsed = JSON.parse(claimsText);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new Error("claims must be a JSON object");
        }
        claims = parsed as Record<string, unknown>;
      } catch (err) {
        toast.error(`Claims are not valid JSON: ${errorMessage(err)}`);
        return;
      }
    }

    setBusy(true);
    setIssued(null);
    try {
      const credential = await SsiClient.getInstance().issueCredential({
        issuerDid: issuerDid as DIDString,
        subjectDid: subjectDid.trim() as DIDString,
        type,
        claims,
        expirationDate: expiration
          ? new Date(expiration).toISOString()
          : undefined,
      });
      setIssued(credential);
      toast.success("Credential issued", { description: credential.id });
    } catch (err) {
      // The common cause is a locked issuer key; the handler says so and that
      // message is more useful than anything this component could invent.
      toast.error(`Issue failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="bg-muted/10 border-border/30">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm">Issue New Credential</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div>
            <Label className="text-xs">Issuing identity</Label>
            {identities.length === 0 ? (
              <p className="text-xs text-amber-400 mt-1">
                No local identity. Create one on the Identity tab — issuing needs
                a private key this machine holds.
              </p>
            ) : (
              <Select value={issuerDid} onValueChange={setIssuerDid}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {identities.map((i) => (
                    <SelectItem key={i.did} value={i.did}>
                      {i.did}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div>
            <Label className="text-xs">Credential type</Label>
            <Select
              value={type}
              onValueChange={(v) => setType(v as CredentialType)}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CREDENTIAL_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Subject DID</Label>
            <Input
              placeholder="did:key:z6Mk..."
              className="mt-1"
              value={subjectDid}
              onChange={(e) => setSubjectDid(e.target.value)}
            />
          </div>

          <div>
            <Label className="text-xs">Claims (JSON)</Label>
            <Textarea
              placeholder='{"name": "Terry", "level": "expert", "skills": ["agents", "apps"]}'
              className="mt-1 font-mono text-xs"
              rows={4}
              value={claimsText}
              onChange={(e) => setClaimsText(e.target.value)}
            />
          </div>

          <div>
            <Label className="text-xs">Expiration (optional)</Label>
            <Input
              type="date"
              className="mt-1"
              value={expiration}
              onChange={(e) => setExpiration(e.target.value)}
            />
          </div>

          <Button onClick={() => void onIssue()} disabled={busy || !issuerDid}>
            {busy ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Stamp className="w-4 h-4 mr-1" />
            )}
            Issue Credential
          </Button>

          {issued && (
            <Card className="bg-green-500/5 border-green-500/20">
              <CardContent className="p-3 space-y-2">
                <p className="text-xs text-green-400">
                  Issued and anchored — id {issued.id}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => downloadCredential(issued.id, issued)}
                >
                  <Download className="w-3.5 h-3.5 mr-1" /> Download .jsonld
                </Button>
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Verify ───────────────────────────────────────────────────────────────────

function VerifyCredentialTab() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SSICredentialVerifyResult | null>(null);

  const onVerify = async () => {
    if (!text.trim()) {
      toast.error("Paste a credential first");
      return;
    }
    let credential: VerifiableCredential;
    try {
      credential = JSON.parse(text) as VerifiableCredential;
    } catch (err) {
      toast.error(`Not valid JSON: ${errorMessage(err)}`);
      return;
    }

    setBusy(true);
    setResult(null);
    try {
      const verdict = await SsiClient.getInstance().verifyCredential(credential);
      setResult(verdict);
      // An invalid credential is a successful verification with a negative
      // answer. Reporting it as success — which this panel used to do
      // unconditionally — is the one outcome that makes verification useless.
      if (verdict.valid) toast.success("Credential is valid");
      else toast.error("Credential is NOT valid");
    } catch (err) {
      toast.error(`Verification failed: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const onUpload = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.jsonld,application/json,application/ld+json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      setText(await file.text());
      toast.success(`Loaded ${file.name}`);
    };
    input.click();
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="bg-muted/10 border-border/30">
        <CardHeader className="py-3 px-4">
          <CardTitle className="text-sm">Verify a Credential</CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4 space-y-3">
          <div>
            <Label className="text-xs">
              Paste Verifiable Credential (JSON-LD)
            </Label>
            <Textarea
              placeholder='{"@context": ["https://www.w3.org/2018/credentials/v1"], "type": ["VerifiableCredential"], ...}'
              className="mt-1 font-mono text-xs"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={() => void onVerify()} disabled={busy}>
              {busy ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Shield className="w-4 h-4 mr-1" />
              )}
              Verify
            </Button>
            <Button variant="outline" onClick={() => void onUpload()}>
              <FileText className="w-4 h-4 mr-1" /> Load File
            </Button>
          </div>

          {result && (
            <Card
              className={
                result.valid
                  ? "bg-green-500/5 border-green-500/20"
                  : "bg-red-500/5 border-red-500/20"
              }
            >
              <CardContent className="p-3 space-y-1">
                <p
                  className={`text-sm ${result.valid ? "text-green-400" : "text-red-400"}`}
                >
                  {result.valid ? "Valid" : "Not valid"}
                </p>
                {result.errors?.map((e, i) => (
                  <p key={i} className="text-xs font-mono text-muted-foreground">
                    {e}
                  </p>
                ))}
              </CardContent>
            </Card>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Types in use ─────────────────────────────────────────────────────────────

/**
 * Replaces the old "Schemas" tab, which listed five invented schemas with
 * invented issue counts. The credential types the issuer accepts are a fixed
 * union in `ssi_types`, so this shows those and how many of each you actually
 * hold — numbers that come from the store rather than from a designer.
 */
function TypesTab() {
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        setCredentials(await SsiClient.getInstance().listCredentials());
      } catch {
        setCredentials([]);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of credentials) m.set(c.type, (m.get(c.type) ?? 0) + 1);
    return m;
  }, [credentials]);

  const shown = CREDENTIAL_TYPES.filter((t) =>
    t.label.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="space-y-3">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/50" />
        <Input
          placeholder="Search types..."
          className="pl-10 h-8 text-xs"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {shown.map((t) => (
        <Card key={t.value} className="bg-muted/10 border-border/30">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center">
              <FileText className="w-5 h-5 text-blue-400" />
            </div>
            <div className="flex-1">
              <span className="text-sm font-medium">{t.label}</span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-muted-foreground/50 font-mono">
                  {t.value}
                </span>
                <Badge variant="outline" className="text-[9px]">
                  {loading ? "…" : `${counts.get(t.value) ?? 0} held`}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/**
 * SSI credentials body, scoped for use inside the unified /identity tabs.
 * Provides its own inner sub-tabs (Credentials / Issue / Verify / Types).
 */
export function SSICredentialsPanel() {
  const [activeTab, setActiveTab] = useState("credentials");
  const [identities, setIdentities] = useState<SSIIdentity[]>([]);

  // Issuing needs a DID this machine holds the key for, and revocation needs to
  // know which credentials are ours, so both tabs share one identity load.
  useEffect(() => {
    void (async () => {
      try {
        setIdentities(await SsiClient.getInstance().listIdentities());
      } catch {
        setIdentities([]);
      }
    })();
  }, []);

  return (
    <Tabs
      value={activeTab}
      onValueChange={setActiveTab}
      className="flex flex-col"
    >
      <TabsList className="bg-transparent">
        <TabsTrigger value="credentials" className="gap-1.5">
          <Key className="w-3.5 h-3.5" /> My Credentials
        </TabsTrigger>
        <TabsTrigger value="issue" className="gap-1.5">
          <Stamp className="w-3.5 h-3.5" /> Issue
        </TabsTrigger>
        <TabsTrigger value="verify" className="gap-1.5">
          <Shield className="w-3.5 h-3.5" /> Verify
        </TabsTrigger>
        <TabsTrigger value="types" className="gap-1.5">
          <FileText className="w-3.5 h-3.5" /> Types
        </TabsTrigger>
      </TabsList>
      <div className="pt-4">
        <TabsContent value="credentials" className="mt-0">
          <MyCredentialsTab identities={identities} />
        </TabsContent>
        <TabsContent value="issue" className="mt-0">
          <IssueCredentialTab identities={identities} />
        </TabsContent>
        <TabsContent value="verify" className="mt-0">
          <VerifyCredentialTab />
        </TabsContent>
        <TabsContent value="types" className="mt-0">
          <TypesTab />
        </TabsContent>
      </div>
    </Tabs>
  );
}

export default SSICredentialsPanel;
