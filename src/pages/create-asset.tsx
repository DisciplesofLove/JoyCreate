import React from "react";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { CreateAssetWizard } from "@/components/marketplace/CreateAssetWizard";

// Wagmi / Thirdweb / Privy are now mounted globally via <JoyWalletProviders>
// in src/renderer.tsx — no need to wrap here.
export default function CreateAssetPage() {
  return (
    <AuthProvider>
      <CreateAssetWizard />
    </AuthProvider>
  );
}
