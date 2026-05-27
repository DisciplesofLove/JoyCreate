/**
 * Aggregates deploy-provider readiness so the one-click UI knows which
 * targets are fully configured (token present + integration installed)
 * versus which need the user to visit `/decentralized-deploy?provider=...`
 * before they can deploy.
 */

import { useQuery } from "@tanstack/react-query";
import { useSettings } from "./useSettings";
import { IpcClient } from "@/ipc/ipc_client";

export interface ProviderReadiness {
  /** Token / credentials stored locally. */
  configured: boolean;
  /** Configured AND any required integrations (e.g. Vercel GitHub App) are installed. */
  ready: boolean;
  /** Short human-readable reason when not ready. */
  reason?: string;
  /** Optional URL the user can open to finish setup. */
  installUrl?: string;
}

export interface DeployProviderStatus {
  github: ProviderReadiness;
  vercel: ProviderReadiness;
  // Web3 providers fall through to a generic record so callers can lookup by id.
  [providerId: string]: ProviderReadiness;
}

export function useDeployProviderStatus(): {
  status: DeployProviderStatus;
  isLoading: boolean;
} {
  const { settings, loading: settingsLoading } = useSettings();

  const ipc = IpcClient.getInstance();

  // Vercel readiness needs both token validity AND the GitHub App being installed
  // for the user's account. Both checks are cheap (cached on the main side).
  const vercelTokenPresent = Boolean(settings?.vercelAccessToken?.value);
  const vercelGithubQuery = useQuery({
    queryKey: ["vercel:check-github-app", vercelTokenPresent],
    queryFn: () => ipc.checkVercelGithubApp(),
    enabled: vercelTokenPresent,
    staleTime: 60_000,
    retry: false,
  });

  const githubConfigured = Boolean(settings?.githubAccessToken?.value);
  const github: ProviderReadiness = githubConfigured
    ? { configured: true, ready: true }
    : {
        configured: false,
        ready: false,
        reason: "Connect GitHub to enable deployments.",
      };

  let vercel: ProviderReadiness;
  if (!vercelTokenPresent) {
    vercel = {
      configured: false,
      ready: false,
      reason: "Add your Vercel token to enable one-click deploys.",
    };
  } else if (vercelGithubQuery.isPending) {
    vercel = {
      configured: true,
      ready: false,
      reason: "Checking Vercel GitHub App…",
    };
  } else if (vercelGithubQuery.isError) {
    vercel = {
      configured: true,
      ready: true, // optimistic — let the deploy attempt surface the real error
    };
  } else if (vercelGithubQuery.data && !vercelGithubQuery.data.installed) {
    vercel = {
      configured: true,
      ready: false,
      reason: "Install the Vercel GitHub App to allow repo linking.",
      installUrl: vercelGithubQuery.data.installUrl,
    };
  } else {
    vercel = { configured: true, ready: true };
  }

  // Web3 providers: treat as "configured" iff the user has stored credentials.
  // The all-providers page is the authoritative configuration surface, so we
  // just expose the local flag and let callers decide whether to surface it.
  const web3: Record<string, ProviderReadiness> = {};
  const dpc = (settings as any)?.decentralizedPlatformCredentials;
  if (dpc && typeof dpc === "object") {
    for (const id of Object.keys(dpc)) {
      web3[id] = { configured: true, ready: true };
    }
  }

  return {
    status: { github, vercel, ...web3 },
    isLoading: settingsLoading,
  };
}
