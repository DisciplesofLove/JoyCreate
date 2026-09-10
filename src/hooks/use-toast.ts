import { toast as sonnerToast } from "sonner";

interface ToastOptions {
  title?: string;
  description?: string;
  variant?: "default" | "destructive";
  /** Milliseconds to keep the toast up. Forwarded to sonner. */
  duration?: number;
}

/**
 * shadcn/ui-style toast adapter wrapping sonner.
 * The CreateAssetWizard calls `toast({ title, description, variant })`.
 */
export function toast(opts: ToastOptions) {
  const message = opts.title
    ? opts.description
      ? `${opts.title}: ${opts.description}`
      : opts.title
    : opts.description ?? "";

  const options = opts.duration != null ? { duration: opts.duration } : undefined;
  if (opts.variant === "destructive") {
    sonnerToast.error(message, options);
  } else {
    sonnerToast.success(message, options);
  }
}

export function useToast() {
  return { toast };
}
