/**
 * Onboarding wizard — Phase 3 of the JoyCreate completion plan.
 *
 * A lightweight 5-step setup walkthrough that links out to existing
 * surfaces (Identity, Wallet, Local models, Agents, Deploy) rather than
 * reimplementing them. Each step has a "Done" button that advances the
 * stepper plus a global "Skip onboarding" escape hatch. Both pathways
 * persist `onboardingComplete = true` so the gate in `RootLayout` won't
 * redirect again.
 */

import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/hooks/useSettings";
import { showError } from "@/lib/toast";
import {
  Check,
  ChevronRight,
  Fingerprint,
  Wallet,
  Cpu,
  Bot,
  Rocket,
} from "lucide-react";

interface Step {
  id: string;
  title: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Where the "Open" button takes the user, if defined. */
  openTo?: string;
}

const STEPS: Step[] = [
  {
    id: "identity",
    title: "Create your JCN identity",
    description:
      "JoyCreate Network keypair signs everything you publish. Generated locally and stored in your secrets vault.",
    icon: Fingerprint,
    openTo: "/unified-identity",
  },
  {
    id: "wallet",
    title: "Connect a wallet",
    description:
      "Used for marketplace mints and Data Market leases. Start with an Arbitrum Sepolia burner; rotate before mainnet.",
    icon: Wallet,
    openTo: "/data-market",
  },
  {
    id: "model",
    title: "Pull your first local model",
    description:
      "Run an Ollama model fully offline for chats and agents. Pick anything from the local models gallery.",
    icon: Cpu,
    openTo: "/local-models",
  },
  {
    id: "agent",
    title: "Spin up your first agent",
    description:
      "Choose a template, set a system prompt, and you have an autonomous worker. Edit later anytime.",
    icon: Bot,
    openTo: "/agents",
  },
  {
    id: "deploy",
    title: "Ship your first deploy",
    description:
      "Publish to the marketplace, expose an API endpoint, or push to a decentralized chain — your call.",
    icon: Rocket,
    openTo: "/deploy",
  },
];

export default function OnboardingPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const { updateSettings } = useSettings();
  const [currentStep, setCurrentStep] = useState(0);
  const [completed, setCompleted] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const finish = async () => {
    setSubmitting(true);
    try {
      await updateSettings({ onboardingComplete: true });
      navigate({ to: "/" });
    } catch (err) {
      showError(err);
      setSubmitting(false);
    }
  };

  const handleDone = (idx: number) => {
    const step = STEPS[idx];
    setCompleted((prev) => new Set(prev).add(step.id));
    if (idx + 1 < STEPS.length) {
      setCurrentStep(idx + 1);
    } else {
      void finish();
    }
  };

  const handleOpen = (idx: number) => {
    const step = STEPS[idx];
    if (!step.openTo) return;
    // Mark the step done optimistically — the user can come back to /onboarding
    // and we'll resume on the next incomplete step.
    setCompleted((prev) => new Set(prev).add(step.id));
    router.navigate({ to: step.openTo });
  };

  return (
    <div className="flex min-h-full w-full flex-col items-center bg-background py-10 px-4">
      <div className="w-full max-w-3xl">
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Welcome to JoyCreate
            </h1>
            <p className="mt-2 text-muted-foreground">
              Five quick steps to set up your sovereign AI stack. Skip any step
              you don&rsquo;t need — you can revisit from settings.
            </p>
          </div>
          <Button
            variant="ghost"
            disabled={submitting}
            onClick={() => void finish()}
          >
            Skip onboarding
          </Button>
        </div>

        {/* Stepper */}
        <ol className="mb-8 flex items-center justify-between gap-2">
          {STEPS.map((step, idx) => {
            const isDone = completed.has(step.id);
            const isActive = idx === currentStep;
            return (
              <li
                key={step.id}
                className={`flex flex-1 items-center gap-2 ${
                  idx < STEPS.length - 1
                    ? "after:flex-1 after:border-t after:border-border after:content-['']"
                    : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => setCurrentStep(idx)}
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-sm font-medium transition-colors ${
                    isDone
                      ? "border-emerald-500 bg-emerald-500 text-white"
                      : isActive
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground"
                  }`}
                  aria-label={`Step ${idx + 1}: ${step.title}`}
                >
                  {isDone ? <Check className="h-4 w-4" /> : idx + 1}
                </button>
              </li>
            );
          })}
        </ol>

        {/* Active step card */}
        {STEPS.map((step, idx) => {
          if (idx !== currentStep) return null;
          const Icon = step.icon;
          const isLast = idx === STEPS.length - 1;
          return (
            <Card key={step.id}>
              <CardHeader className="flex flex-row items-start gap-4 space-y-0">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-6 w-6" />
                </div>
                <div className="space-y-1">
                  <CardTitle>{step.title}</CardTitle>
                  <CardDescription>{step.description}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {step.openTo ? (
                  <Button onClick={() => handleOpen(idx)} variant="default">
                    Open {step.title.split(" ").slice(-2).join(" ")}
                    <ChevronRight className="ml-1 h-4 w-4" />
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={submitting}
                  onClick={() => handleDone(idx)}
                >
                  {isLast ? "Finish setup" : "Mark done & continue"}
                </Button>
                {!isLast && (
                  <Button
                    variant="ghost"
                    onClick={() => setCurrentStep(idx + 1)}
                  >
                    Skip this step
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
