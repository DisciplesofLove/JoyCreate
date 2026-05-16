/**
 * Smoke tests for UnifiedModelPicker — verifies that the picker:
 *  - Renders every provider regardless of `configured` state.
 *  - Surfaces the right status badge for each provider kind/state.
 *  - Disables `comingSoon` rows.
 *  - Calls `onSelect` for configured cloud providers.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import type { ImageStudioProvider } from "@/ipc/ipc_types";
import { UnifiedModelPicker } from "../UnifiedModelPicker";

function withQueryClient(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

const providers: ImageStudioProvider[] = [
  {
    id: "openai",
    label: "DALL-E (OpenAI)",
    kind: "cloud",
    configured: true,
    apiKeyEnvVars: ["OPENAI_API_KEY"],
    website: "https://platform.openai.com/api-keys",
    models: [{ id: "dall-e-3", label: "DALL-E 3" }],
  },
  {
    id: "google",
    label: "Imagen / Gemini (Google)",
    kind: "cloud",
    configured: false,
    apiKeyEnvVars: ["GEMINI_API_KEY"],
    models: [{ id: "imagen-4.0-generate-001", label: "Imagen 4" }],
  },
  {
    id: "comfyui",
    label: "ComfyUI (Local)",
    kind: "local",
    configured: false,
    health: "unreachable",
    models: [{ id: "default", label: "Start the local server" }],
  },
  {
    id: "meta",
    label: "Meta Imagine",
    kind: "cloud",
    configured: false,
    comingSoon: true,
    models: [{ id: "meta-imagine", label: "Meta Imagine", comingSoon: true }],
  },
];

describe("UnifiedModelPicker", () => {
  it("renders all providers with appropriate status badges", () => {
    const onSelect = vi.fn();
    render(
      withQueryClient(
        <UnifiedModelPicker
          mode="image"
          providers={providers}
          selectedProvider=""
          selectedModel=""
          onSelect={onSelect}
        />,
      ),
    );

    // Open the popover.
    fireEvent.click(screen.getByRole("combobox"));

    expect(screen.getByText("DALL-E (OpenAI)")).toBeTruthy();
    expect(screen.getByText("Imagen / Gemini (Google)")).toBeTruthy();
    expect(screen.getByText("ComfyUI (Local)")).toBeTruthy();
    expect(screen.getAllByText("Meta Imagine").length).toBeGreaterThan(0);

    expect(screen.getByText("Configured")).toBeTruthy();
    expect(screen.getByText("Needs API key")).toBeTruthy();
    expect(screen.getByText("Local: offline")).toBeTruthy();
    expect(screen.getByText("Coming soon")).toBeTruthy();
  });

  it("calls onSelect when a configured cloud model row is clicked", () => {
    const onSelect = vi.fn();
    render(
      withQueryClient(
        <UnifiedModelPicker
          mode="image"
          providers={providers}
          selectedProvider=""
          selectedModel=""
          onSelect={onSelect}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByText("DALL-E 3"));

    expect(onSelect).toHaveBeenCalledWith("openai", "dall-e-3");
  });

  it("does NOT call onSelect when a comingSoon row is clicked", () => {
    const onSelect = vi.fn();
    render(
      withQueryClient(
        <UnifiedModelPicker
          mode="image"
          providers={providers}
          selectedProvider=""
          selectedModel=""
          onSelect={onSelect}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("combobox"));
    const metaRow = screen.getByText("Meta Imagine", { selector: "span.truncate" });
    fireEvent.click(metaRow);

    expect(onSelect).not.toHaveBeenCalled();
  });
});
