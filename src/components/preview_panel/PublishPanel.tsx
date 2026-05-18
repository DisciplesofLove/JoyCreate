import { useState } from "react";
import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { Rocket, CheckCircle2, XCircle, Loader2, ChevronDown, ExternalLink } from "lucide-react";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApp } from "@/hooks/useLoadApp";
import { PortalMigrate } from "@/components/PortalMigrate";
import { IpcClient } from "@/ipc/ipc_client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAutoDeploy, type AutoDeployStep } from "@/hooks/useAutoDeploy";

type DeployTarget = "vercel" | "4everland" | "fleek" | "ipfs-pinata" | "ipfs-web3storage" | "arweave" | "spheron";

const DEPLOY_TARGETS: Array<{ id: DeployTarget; label: string; description: string }> = [
  { id: "vercel", label: "Vercel", description: "Fast global CDN, automatic HTTPS" },
  { id: "4everland", label: "4everland", description: "Decentralized hosting on IPFS" },
  { id: "fleek", label: "Fleek", description: "Web3 native deployment" },
  { id: "ipfs-pinata", label: "IPFS (Pinata)", description: "Pinned IPFS hosting" },
  { id: "arweave", label: "Arweave", description: "Permanent on-chain storage" },
  { id: "spheron", label: "Spheron", description: "Decentralized cloud" },
];

function StepIndicator({ step }: { step: AutoDeployStep }) {
  const icon =
    step.status === "running" ? (
      <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
    ) : step.status === "success" ? (
      <CheckCircle2 className="w-4 h-4 text-green-500" />
    ) : step.status === "error" ? (
      <XCircle className="w-4 h-4 text-red-500" />
    ) : step.status === "skipped" ? (
      <CheckCircle2 className="w-4 h-4 text-gray-400" />
    ) : (
      <div className="w-4 h-4 rounded-full border-2 border-gray-300" />
    );

  return (
    <div className="flex items-start gap-2 py-1">
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm ${step.status === "error" ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}>
          {step.message}
        </p>
        {step.details && (
          <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">{step.details}</p>
        )}
      </div>
    </div>
  );
}

function OneClickDeployCard({ appId }: { appId: number }) {
  const [target, setTarget] = useState<DeployTarget>("vercel");
  const [showTargets, setShowTargets] = useState(false);
  const { deploy, isDeploying, steps, deployResult, error } = useAutoDeploy(appId);

  const selectedTarget = DEPLOY_TARGETS.find((t) => t.id === target)!;

  return (
    <Card className="border-2 border-blue-200 dark:border-blue-800">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Rocket className="w-5 h-5 text-blue-500" />
          One-Click Deploy
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Verify completeness, push to GitHub, and deploy — all in one step.
        </p>

        {/* Target selector */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowTargets(!showTargets)}
            disabled={isDeploying}
            className="w-full flex items-center justify-between px-3 py-2 border rounded-lg bg-white dark:bg-gray-800 disabled:opacity-50"
          >
            <span className="text-sm font-medium">{selectedTarget.label}</span>
            <ChevronDown className={`w-4 h-4 transition-transform ${showTargets ? "rotate-180" : ""}`} />
          </button>
          {showTargets && (
            <div className="absolute z-10 mt-1 w-full bg-white dark:bg-gray-800 border rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {DEPLOY_TARGETS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => { setTarget(t.id); setShowTargets(false); }}
                  className="w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 first:rounded-t-lg last:rounded-b-lg"
                >
                  <span className="text-sm font-medium">{t.label}</span>
                  <span className="block text-xs text-gray-500">{t.description}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Deploy button */}
        <Button
          className="w-full bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600"
          disabled={isDeploying}
          onClick={() => deploy(target)}
        >
          {isDeploying ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Deploying...
            </>
          ) : (
            <>
              <Rocket className="w-4 h-4 mr-2" />
              Deploy to {selectedTarget.label}
            </>
          )}
        </Button>

        {/* Progress steps */}
        {steps.length > 0 && (
          <div className="border rounded-lg p-3 space-y-1 bg-gray-50 dark:bg-gray-900/50">
            {steps.map((step, i) => (
              <StepIndicator key={i} step={step} />
            ))}
          </div>
        )}

        {/* Result */}
        {deployResult?.deploymentUrl && (
          <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <CheckCircle2 className="w-5 h-5 text-green-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-green-800 dark:text-green-200">Deployed!</p>
              <button
                type="button"
                onClick={() => IpcClient.getInstance().openExternalUrl(deployResult.deploymentUrl!)}
                className="text-xs text-green-600 dark:text-green-400 underline truncate block"
              >
                {deployResult.deploymentUrl}
              </button>
            </div>
            <ExternalLink className="w-4 h-4 text-green-500 flex-shrink-0" />
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export const PublishPanel = () => {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { app, loading } = useLoadApp(selectedAppId);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-blue-600 dark:text-blue-400 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="m4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 0 1 4 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          Loading...
        </h2>
      </div>
    );
  }

  if (!selectedAppId || !app) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-900/30 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-gray-600 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          No App Selected
        </h2>
        <p className="text-gray-600 dark:text-gray-400 max-w-md">
          Select an app to view publishing options.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-4 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Publish App
          </h1>
        </div>

        {/* One-Click Deploy Section */}
        <OneClickDeployCard appId={selectedAppId} />

        {/* Portal Section - Show only if app has neon project */}
        {app.neonProjectId && <PortalMigrate appId={selectedAppId} />}

        {/* Unified Publish & Deploy entry point */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Rocket className="w-5 h-5 text-indigo-500" />
              All Providers
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Configure credentials and deploy to any provider — Vercel, GitHub,
              4everland, Fleek, IPFS (Pinata / web3.storage), Arweave, Spheron,
              and more — all from one page. Choose whichever host you want for
              this particular deployment.
            </p>
            <Link to="/decentralized-deploy" className="block">
              <Button className="w-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 hover:from-blue-600 hover:via-indigo-600 hover:to-purple-600">
                <Rocket className="w-4 h-4 mr-2" />
                Open Publish &amp; Deploy
                <ExternalLink className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
