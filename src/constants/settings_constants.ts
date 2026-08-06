export const MAX_CHAT_TURNS_IN_CONTEXT = 10;

/**
 * Default token budget for the chat-history portion of an AI request.
 * Users can override via settings.contextTokenBudget. Rate-limit retries
 * step this down proportionally, never below MIN_CONTEXT_TOKEN_BUDGET.
 */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 24_000;
export const MIN_CONTEXT_TOKEN_BUDGET = 6_000;
