import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DeepLinkProvider } from "../contexts/DeepLinkContext";
import { Toaster } from "sonner";
import { TitleBar } from "./TitleBar";
import { useEffect, type ReactNode } from "react";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import { AssistantContextProvider } from "@/components/joy-assistant/AssistantContextProvider";
import { JoyAssistantPanel } from "@/components/joy-assistant/JoyAssistantPanel";
import { JoyAssistantBoundary } from "@/components/joy-assistant/JoyAssistantBoundary";
import { VoiceCommandOverlay } from "@/components/voice-command/VoiceCommandOverlay";
import { WhitehatMcpApprovalDialog } from "@/components/mcp/WhitehatMcpApprovalDialog";
import { useRunApp } from "@/hooks/useRunApp";
import { useAtomValue, useSetAtom } from "jotai";
import {
  appConsoleEntriesAtom,
  previewModeAtom,
  selectedAppIdAtom,
} from "@/atoms/appAtoms";
import { useSettings } from "@/hooks/useSettings";
import type { ZoomLevel } from "@/lib/schemas";
import { selectedComponentsPreviewAtom } from "@/atoms/previewAtoms";
import { chatInputValueAtom } from "@/atoms/chatAtoms";

const DEFAULT_ZOOM_LEVEL: ZoomLevel = "100";

export default function RootLayout({ children }: { children: ReactNode }) {
  const { refreshAppIframe } = useRunApp();
  const previewMode = useAtomValue(previewModeAtom);
  const { settings } = useSettings();
  const setSelectedComponentsPreview = useSetAtom(
    selectedComponentsPreviewAtom,
  );
  const setChatInput = useSetAtom(chatInputValueAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setConsoleEntries = useSetAtom(appConsoleEntriesAtom);

  useEffect(() => {
    const zoomLevel = settings?.zoomLevel ?? DEFAULT_ZOOM_LEVEL;
    const zoomFactor = Number(zoomLevel) / 100;

    const electronApi = (
      window as Window & {
        electron?: {
          webFrame?: {
            setZoomFactor: (factor: number) => void;
          };
        };
      }
    ).electron;

    if (electronApi?.webFrame?.setZoomFactor) {
      electronApi.webFrame.setZoomFactor(zoomFactor);

      return () => {
        electronApi.webFrame?.setZoomFactor(Number(DEFAULT_ZOOM_LEVEL) / 100);
      };
    }

    return () => {};
  }, [settings?.zoomLevel]);
  // Global keyboard listener for refresh events
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+R (Windows/Linux) or Cmd+R (macOS)
      if (event.key === "r" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); // Prevent default browser refresh
        if (previewMode === "preview") {
          refreshAppIframe(); // Use our custom refresh function instead
        }
      }
    };

    // Add event listener to document
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup function to remove event listener
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [refreshAppIframe, previewMode]);

  useEffect(() => {
    setChatInput("");
    setSelectedComponentsPreview([]);
    setConsoleEntries([]);
  }, [selectedAppId]);

  // Phase 3: soft onboarding gate. Only redirect truly-fresh installs
  // (no `hasRunBefore`, no `onboardingComplete`) and only when they land
  // on `/`. Existing users are never disturbed because both flags will be
  // either explicitly set or undefined-on-an-old-install (where
  // `hasRunBefore` is set as part of the legacy first-run handler).
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    if (!settings) return;
    if (settings.onboardingComplete) return;
    if (settings.hasRunBefore) return;
    if (pathname !== "/") return;
    navigate({ to: "/onboarding" });
  }, [settings, pathname, navigate]);

  return (
    <>
      <ThemeProvider>
        <DeepLinkProvider>
          <SidebarProvider>
            <TitleBar />
            <AppSidebar />
            <AssistantContextProvider>
              <div
                id="layout-main-content-container"
                className="flex h-screenish w-full overflow-x-hidden overflow-y-auto mt-12 mb-4 mr-4 border border-border/40 rounded-xl bg-background/80 backdrop-blur-sm shadow-sm"
              >
                {children}
              </div>
              <JoyAssistantBoundary>
                <JoyAssistantPanel />
              </JoyAssistantBoundary>
              <VoiceCommandOverlay />
            </AssistantContextProvider>
            <Toaster richColors />
            <WhitehatMcpApprovalDialog />
          </SidebarProvider>
        </DeepLinkProvider>
      </ThemeProvider>
    </>
  );
}
