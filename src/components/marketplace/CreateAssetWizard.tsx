/**
 * Create Asset — publish to Joy Marketplace.
 *
 * Rebuilt against the canonical publish pipeline.
 *
 * What this replaces
 * ------------------
 * The previous wizard was 5,768 lines carrying the *marketplace web app's*
 * stack into the desktop app: direct Supabase calls, wagmi hooks, thirdweb
 * contracts, `MarketplaceListingService`, `nftCreationFlowService` and a
 * post-mint Web3 pipeline. None of it went through JoyCreate's own publish
 * path, so it duplicated — and drifted from — the encryption, pinning and
 * minting rules that path enforces. Three of its buttons did nothing but raise
 * a toast, including "Asset details saved!".
 *
 * There is one publish path in JoyCreate and this drives it:
 * `joybridge:publish-asset` → `publishAndForget` → `publishToMarketplace`.
 * Everything that made a CLI publish correct therefore applies here too:
 *
 *   - content is encrypted (AES-256-GCM, key wrapped by Lit) before any byte
 *     leaves the machine;
 *   - chunks, envelope and metadata are pinned through the marketplace's own
 *     `ipfs-upload`, so the CIDs match a CLI publish byte for byte;
 *   - metadata lands in a tokenId-named directory, because `uri(N)` is
 *     `baseURI + N` and `_batchURI` is write-once with no setter;
 *   - `nextTokenIdToMint` is re-read immediately before minting and the publish
 *     aborts on drift.
 *
 * Why the store step comes first
 * ------------------------------
 * `lazyMint` is `onlyStoreOwner`, so a publish to a store whose ENS name the
 * signing wallet does not own fails after encrypting and pinning everything —
 * the expensive half — for nothing. `joybridge:check-store` resolves the drop
 * with plain RPC reads, so the wizard refuses to go on until the store is known
 * to be real.
 *
 * Why a dry run is a step rather than a checkbox
 * ----------------------------------------------
 * A dry run walks the whole pipeline and reports the token id it would take,
 * without spending gas or pinning. It costs nothing and it is the only way to
 * find out that a signer is missing before the irreversible part starts.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  FileUp,
  Image as ImageIcon,
  Loader2,
  Lock,
  Rocket,
  Store,
  XCircle,
} from "lucide-react";

import { IpcClient } from "@/ipc/ipc_client";
import type {
  PublishAssetRequest,
  PublishAssetResult,
  PublishAssetType,
  PublishOutcomeSummary,
  StoreCheck,
} from "@/ipc/ipc_client";

// ── constants ────────────────────────────────────────────────────────────────

const ASSET_TYPES: Array<{ value: PublishAssetType; label: string }> = [
  { value: "model", label: "Model" },
  { value: "dataset", label: "Dataset" },
  { value: "agent", label: "Agent" },
  { value: "app", label: "App" },
  { value: "document", label: "Document" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "workflow", label: "Workflow" },
  { value: "blueprint", label: "Blueprint" },
];

const LICENSES = [
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "CC0-1.0",
  "MIT",
  "Apache-2.0",
  "Proprietary",
];

/**
 * Mirrors `pickChunkSize` in the encryption module. Shown so the size of the
 * job is visible before it starts — a 2 GB model is hundreds of chunks, each
 * one an encrypt and a pin.
 */
function chunkSizeFor(bytes: number): number {
  const MB = 1024 * 1024;
  if (bytes <= 64 * MB) return MB;
  if (bytes <= 512 * MB) return 4 * MB;
  return 8 * MB;
}

function formatBytes(n: number): string {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Read a File as base64 without blowing the stack on a large buffer. */
async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

const STEPS = ["Store", "Content", "Details", "Review", "Publish"] as const;
type StepIndex = 0 | 1 | 2 | 3 | 4;

// ── component ────────────────────────────────────────────────────────────────

export function CreateAssetWizard() {
  const ipc = IpcClient.getInstance();

  const [step, setStep] = useState<StepIndex>(0);

  // Step 1 — store
  const [storeSlug, setStoreSlug] = useState("");
  const [checking, setChecking] = useState(false);
  const [store, setStore] = useState<StoreCheck | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);

  // Step 2 — content
  const [file, setFile] = useState<File | null>(null);
  const [cover, setCover] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);

  // Step 3 — details
  const [assetType, setAssetType] = useState<PublishAssetType>("model");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [priceUsdc, setPriceUsdc] = useState("");
  const [royaltyPct, setRoyaltyPct] = useState("5");
  const [quantity, setQuantity] = useState("1");
  const [license, setLicense] = useState("CC-BY-4.0");

  // Steps 4 & 5 — dry run and publish
  const [dryRunning, setDryRunning] = useState(false);
  const [dryRun, setDryRun] = useState<PublishOutcomeSummary | null>(null);
  const [dryRunError, setDryRunError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [result, setResult] = useState<PublishAssetResult | null>(null);

  const chunkCount = useMemo(() => {
    if (!file) return 0;
    return Math.ceil(file.size / chunkSizeFor(file.size));
  }, [file]);

  // ── actions ───────────────────────────────────────────────────────────────

  const onCheckStore = useCallback(async () => {
    const label = storeSlug.trim().toLowerCase();
    if (!label) {
      setStoreError("Enter the store's ENS label, e.g. acme-models");
      return;
    }
    setChecking(true);
    setStoreError(null);
    setStore(null);
    try {
      const check = await ipc.checkStore(label);
      setStore(check);
    } catch (err) {
      // The usual causes are a name that was never registered and a name whose
      // resolver has no addr() record. Both surface from the chain with a
      // useful message; inventing a friendlier one would hide which it was.
      setStoreError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }, [ipc, storeSlug]);

  const buildRequest = useCallback(
    async (asDryRun: boolean): Promise<PublishAssetRequest> => {
      const req: PublishAssetRequest = {
        assetType,
        name: name.trim(),
        description: description.trim() || undefined,
        license,
        quantity: Math.max(1, Number(quantity) || 1),
        royaltyBps: Math.round((Number(royaltyPct) || 0) * 100),
        dryRun: asDryRun,
        storeId: store?.store,
        properties: { storeSlug: store?.store },
      };

      const price = Number(priceUsdc);
      if (Number.isFinite(price) && price > 0) req.priceUsdc = price;

      // A dry run deliberately does not carry the payload. Encoding a
      // multi-gigabyte file to base64 to send across IPC for a run that will
      // not pin it wastes minutes and a lot of memory to learn nothing extra.
      if (!asDryRun && file) {
        req.contentBase64 = await fileToBase64(file);
        req.contentMimeType = file.type || "application/octet-stream";
      }
      if (!asDryRun && cover) {
        req.coverImageBase64 = await fileToBase64(cover);
        req.coverImageMimeType = cover.type || "image/png";
        req.coverImageFileName = cover.name;
      }
      return req;
    },
    [
      assetType,
      cover,
      description,
      file,
      license,
      name,
      priceUsdc,
      quantity,
      royaltyPct,
      store,
    ],
  );

  const onDryRun = useCallback(async () => {
    setDryRunning(true);
    setDryRunError(null);
    setDryRun(null);
    try {
      const res = await ipc.publishAsset(await buildRequest(true));
      if (!res.ok) {
        setDryRunError(res.error ?? "dry run failed");
        setDryRun(res.outcome ?? null);
        return;
      }
      setDryRun(res.outcome ?? null);
    } catch (err) {
      setDryRunError(errorMessage(err));
    } finally {
      setDryRunning(false);
    }
  }, [buildRequest, ipc]);

  const onPublish = useCallback(async () => {
    setPublishing(true);
    setResult(null);
    setStep(4);
    try {
      const res = await ipc.publishAsset(await buildRequest(false));
      setResult(res);
      if (res.ok) {
        toast.success(`Published — token #${res.outcome?.tokenId ?? "?"}`);
      } else {
        toast.error(res.error ?? "Publish failed");
      }
    } catch (err) {
      // A throw here means the pipeline never returned an outcome — worth
      // showing as its own failure rather than folding into an empty result.
      setResult({ ok: false, error: errorMessage(err) });
      toast.error(errorMessage(err));
    } finally {
      setPublishing(false);
    }
  }, [buildRequest, ipc]);

  // ── step gating ───────────────────────────────────────────────────────────

  const canLeaveStore = !!store?.publishable;
  const canLeaveContent = !!file;
  const canLeaveDetails = name.trim().length > 0;

  const canAdvance =
    step === 0
      ? canLeaveStore
      : step === 1
        ? canLeaveContent
        : step === 2
          ? canLeaveDetails
          : false;

  const reset = () => {
    setStep(0);
    setStore(null);
    setStoreSlug("");
    setFile(null);
    setCover(null);
    setName("");
    setDescription("");
    setPriceUsdc("");
    setDryRun(null);
    setDryRunError(null);
    setResult(null);
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Publish to Joy Marketplace</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your file is encrypted on this machine before anything is uploaded. The
          decryption key is wrapped by Lit and only released to a buyer who holds
          the edition.
        </p>
      </div>

      {/* Step rail */}
      <div className="flex items-center gap-2">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center gap-2 flex-1">
            <div
              className={`flex items-center gap-1.5 text-xs ${
                i === step
                  ? "text-foreground font-medium"
                  : i < step
                    ? "text-green-400"
                    : "text-muted-foreground/50"
              }`}
            >
              {i < step ? (
                <CheckCircle2 className="w-3.5 h-3.5" />
              ) : (
                <span className="w-3.5 h-3.5 rounded-full border grid place-items-center text-[9px]">
                  {i + 1}
                </span>
              )}
              {label}
            </div>
            {i < STEPS.length - 1 && (
              <div className="flex-1 h-px bg-border/60" />
            )}
          </div>
        ))}
      </div>

      {/* ── 1. Store ───────────────────────────────────────────────────── */}
      {step === 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Store className="w-4 h-4" /> Which store?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Store ENS label</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  placeholder="acme-models"
                  value={storeSlug}
                  onChange={(e) => setStoreSlug(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void onCheckStore()}
                />
                <Button onClick={() => void onCheckStore()} disabled={checking}>
                  {checking ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    "Check"
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                The label of{" "}
                <span className="font-mono">
                  {storeSlug.trim().toLowerCase() || "your-store"}
                  .joymarketplace.io
                </span>
                . The signing wallet must own this name — minting is
                owner-only.
              </p>
            </div>

            {storeError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm text-red-400">Store not reachable</p>
                  <p className="text-xs font-mono text-muted-foreground break-all">
                    {storeError}
                  </p>
                </div>
              </div>
            )}

            {store && (
              <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20 space-y-1">
                <p className="text-sm text-green-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" /> {store.storeDomain} is
                  publishable
                </p>
                <p className="text-xs text-muted-foreground font-mono break-all">
                  drop {store.dropAddress}
                </p>
                <p className="text-xs text-muted-foreground">
                  Next token id: <strong>{store.nextTokenId}</strong>
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── 2. Content ─────────────────────────────────────────────────── */}
      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="w-4 h-4" /> What are you selling?
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs">Asset file</Label>
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="outline"
                className="w-full mt-1 justify-start"
                onClick={() => fileInput.current?.click()}
              >
                <FileUp className="w-4 h-4 mr-2" />
                {file ? file.name : "Choose a file…"}
              </Button>
              {file && (
                <div className="mt-2 text-xs text-muted-foreground space-y-0.5">
                  <p>
                    {formatBytes(file.size)} · {file.type || "unknown type"}
                  </p>
                  <p>
                    Will be encrypted into <strong>{chunkCount}</strong> chunk
                    {chunkCount === 1 ? "" : "s"} of{" "}
                    {formatBytes(chunkSizeFor(file.size))}, each pinned
                    separately.
                  </p>
                </div>
              )}
            </div>

            <div>
              <Label className="text-xs">Cover image (optional)</Label>
              <input
                ref={coverInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setCover(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="outline"
                className="w-full mt-1 justify-start"
                onClick={() => coverInput.current?.click()}
              >
                <ImageIcon className="w-4 h-4 mr-2" />
                {cover ? cover.name : "Choose an image…"}
              </Button>
              <p className="text-[11px] text-muted-foreground mt-1">
                Pinned unencrypted — it is the public thumbnail, visible before
                anyone buys.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 3. Details ─────────────────────────────────────────────────── */}
      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Listing details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Type</Label>
                <Select
                  value={assetType}
                  onValueChange={(v) => setAssetType(v as PublishAssetType)}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ASSET_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">License</Label>
                <Select value={license} onValueChange={setLicense}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LICENSES.map((l) => (
                      <SelectItem key={l} value={l}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs">Name</Label>
              <Input
                className="mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Sentiment classifier v2"
              />
            </div>

            <div>
              <Label className="text-xs">Description</Label>
              <Textarea
                className="mt-1"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What it does, what it was trained on, how to run it."
              />
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Price (USDC)</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min="0"
                  step="0.01"
                  value={priceUsdc}
                  onChange={(e) => setPriceUsdc(e.target.value)}
                  placeholder="0 = free"
                />
              </div>
              <div>
                <Label className="text-xs">Royalty %</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={royaltyPct}
                  onChange={(e) => setRoyaltyPct(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs">Editions</Label>
                <Input
                  className="mt-1"
                  type="number"
                  min="1"
                  step="1"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── 4. Review + dry run ────────────────────────────────────────── */}
      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Store</dt>
              <dd className="font-mono text-xs">{store?.storeDomain}</dd>
              <dt className="text-muted-foreground">Token id</dt>
              <dd>{store?.nextTokenId}</dd>
              <dt className="text-muted-foreground">Name</dt>
              <dd>{name}</dd>
              <dt className="text-muted-foreground">Type</dt>
              <dd className="capitalize">{assetType}</dd>
              <dt className="text-muted-foreground">File</dt>
              <dd>
                {file ? `${file.name} (${formatBytes(file.size)})` : "—"}
              </dd>
              <dt className="text-muted-foreground">Chunks</dt>
              <dd>{chunkCount}</dd>
              <dt className="text-muted-foreground">Price</dt>
              <dd>{Number(priceUsdc) > 0 ? `${priceUsdc} USDC` : "Free"}</dd>
              <dt className="text-muted-foreground">Editions</dt>
              <dd>{quantity}</dd>
            </dl>

            <div className="p-3 rounded-lg bg-muted/20 border border-border/40">
              <p className="text-xs text-muted-foreground">
                A dry run walks the whole pipeline — store, signer, gate, token
                id — without spending gas or pinning anything. Run it before
                publishing; it is the only cheap way to find a missing signer.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void onDryRun()}
                disabled={dryRunning}
              >
                {dryRunning ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                )}
                Run dry run
              </Button>
            </div>

            {dryRunError && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm text-red-400">Dry run failed</p>
                  <p className="text-xs font-mono text-muted-foreground break-all">
                    {dryRunError}
                  </p>
                </div>
              </div>
            )}

            {dryRun && !dryRunError && (
              <div className="p-3 rounded-lg bg-green-500/5 border border-green-500/20">
                <p className="text-sm text-green-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" /> Dry run passed
                </p>
                {dryRun.tokenId && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Would mint token <strong>#{dryRun.tokenId}</strong>
                    {dryRun.dropAddress ? ` on ${dryRun.dropAddress}` : ""}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── 5. Publish ─────────────────────────────────────────────────── */}
      {step === 4 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Rocket className="w-4 h-4" /> Publishing
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {publishing && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Encrypting, pinning {chunkCount} chunk
                  {chunkCount === 1 ? "" : "s"}, then minting…
                </div>
                {/* Indeterminate on purpose. The pipeline does not report
                    per-chunk progress, and a bar that invents one would be
                    guessing at exactly the moment the user is deciding whether
                    something has hung. */}
                <Progress value={undefined} />
                <p className="text-xs text-muted-foreground">
                  Do not close JoyCreate. Large files take a while — the mint is
                  the last step.
                </p>
              </div>
            )}

            {result?.ok && result.outcome && (
              <div className="space-y-3">
                <p className="text-sm text-green-400 flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" /> Published
                </p>
                <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">Token</dt>
                  <dd>#{result.outcome.tokenId}</dd>
                  <dt className="text-muted-foreground">Chunks</dt>
                  <dd>{result.outcome.chunkCount ?? "—"}</dd>
                  <dt className="text-muted-foreground">Content CID</dt>
                  <dd className="font-mono break-all">
                    {result.outcome.contentCid ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Envelope CID</dt>
                  <dd className="font-mono break-all">
                    {result.outcome.envelopeCid ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Metadata</dt>
                  <dd className="font-mono break-all">
                    {result.outcome.metadataUri ?? "—"}
                  </dd>
                  <dt className="text-muted-foreground">Mint tx</dt>
                  <dd className="font-mono break-all">
                    {result.outcome.mintTxHash ?? "—"}
                  </dd>
                </dl>
                <div className="flex gap-2">
                  {result.outcome.marketplaceUrl && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        window.open(result.outcome!.marketplaceUrl, "_blank")
                      }
                    >
                      <ExternalLink className="w-3.5 h-3.5 mr-1" /> View listing
                    </Button>
                  )}
                  <Button size="sm" onClick={reset}>
                    Publish another
                  </Button>
                </div>
              </div>
            )}

            {result && !result.ok && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                  <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm text-red-400">Publish failed</p>
                    <p className="text-xs font-mono text-muted-foreground break-all">
                      {result.error}
                    </p>
                    {result.outcome?.blockedAt && (
                      <p className="text-xs text-muted-foreground mt-1">
                        Blocked at: {result.outcome.blockedAt}
                      </p>
                    )}
                  </div>
                </div>
                {/* Anything already pinned stays pinned and costs nothing to
                    keep, so retrying is safe — the token id is re-read before
                    the mint either way. */}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setStep(3)}>
                    <ArrowLeft className="w-3.5 h-3.5 mr-1" /> Back to review
                  </Button>
                  <Button size="sm" onClick={() => void onPublish()}>
                    Try again
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Nav */}
      {step < 4 && (
        <div className="flex items-center justify-between">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1) as StepIndex)}
            disabled={step === 0}
          >
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>

          {step < 3 ? (
            <Button
              onClick={() => setStep((s) => (s + 1) as StepIndex)}
              disabled={!canAdvance}
            >
              Next <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              {!dryRun && (
                <Badge variant="outline" className="text-[10px]">
                  dry run recommended
                </Badge>
              )}
              <Button onClick={() => void onPublish()} disabled={publishing}>
                <Rocket className="w-4 h-4 mr-1" /> Publish
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default CreateAssetWizard;
