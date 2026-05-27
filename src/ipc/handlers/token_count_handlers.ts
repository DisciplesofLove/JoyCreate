import { db } from "../../db";
import { chats } from "../../db/schema";
import { eq } from "drizzle-orm";
import {
  constructSystemPrompt,
  readAiRules,
} from "../../prompts/system_prompt";
import {
  SUPABASE_AVAILABLE_SYSTEM_PROMPT,
  SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT,
} from "../../prompts/supabase_prompt";
import { getDataLayerPrompts } from "../../prompts/data_layer";
import {
  deriveLegacyDataLayerConfig,
  type DataLayerConfig,
} from "../../shared/data_layer_types";
import { getJoyAppPath } from "../../paths/paths";
import log from "electron-log";
import { extractCodebase } from "../../utils/codebase";
import { getSupabaseContext } from "../../supabase_admin/supabase_context";

import { TokenCountParams } from "../ipc_types";
import { TokenCountResult } from "../ipc_types";
import { estimateTokens, getContextWindow } from "../utils/token_utils";
import { createLoggedHandler } from "./safe_handle";
import { validateChatContext } from "../utils/context_paths_utils";
import { readSettings } from "@/main/settings";
import { extractMentionedAppsCodebases } from "../utils/mention_apps";
import { parseAppMentions } from "@/shared/parse_mention_apps";
import { ChatModeSchema, isTurboEditsV2Enabled } from "@/lib/schemas";

const logger = log.scope("token_count_handlers");

const handle = createLoggedHandler(logger);

export function registerTokenCountHandlers() {
  handle(
    "chat:count-tokens",
    async (event, req: TokenCountParams): Promise<TokenCountResult> => {
      const chat = await db.query.chats.findFirst({
        where: eq(chats.id, req.chatId),
        with: {
          messages: {
            orderBy: (messages, { asc }) => [asc(messages.createdAt)],
          },
          app: true,
        },
      });

      if (!chat) {
        throw new Error(`Chat not found: ${req.chatId}`);
      }

      // Prepare message history for token counting
      const messageHistory = chat.messages
        .map((message) => message.content)
        .join("");
      const messageHistoryTokens = estimateTokens(messageHistory);

      // Count input tokens
      const inputTokens = estimateTokens(req.input);

      const settings = readSettings();

      // Parse app mentions from the input
      const mentionedAppNames = parseAppMentions(req.input);

      // Count system prompt tokens.
      // Mirror chat_stream_handlers: per-chat chatMode overrides settings.
      const chatModeParsed = ChatModeSchema.safeParse(chat.chatMode);
      const effectiveChatMode = chatModeParsed.success
        ? chatModeParsed.data
        : (settings.selectedChatMode ?? "build");
      let systemPrompt = constructSystemPrompt({
        aiRules: await readAiRules(getJoyAppPath(chat.app.path)),
        chatMode:
          effectiveChatMode === "agent" || effectiveChatMode === "local-agent"
            ? "build"
            : effectiveChatMode,
        enableTurboEditsV2: isTurboEditsV2Enabled(settings),
      });
      let supabaseContext = "";

      // Mirror chat_stream_handlers: prefer per-app dataLayerConfig,
      // fall back to deriving from legacy columns so token estimates
      // match the prompt we actually stream.
      const dataLayerConfig: DataLayerConfig | null =
        (chat.app?.dataLayerConfig as DataLayerConfig | null) ??
        (chat.app
          ? deriveLegacyDataLayerConfig({
              supabaseProjectId: chat.app.supabaseProjectId,
              neonProjectId: chat.app.neonProjectId,
            })
          : null);
      const isLegacyConfig = !chat.app?.dataLayerConfig;

      if (isLegacyConfig) {
        if (chat.app?.supabaseProjectId) {
          systemPrompt += "\n\n" + SUPABASE_AVAILABLE_SYSTEM_PROMPT;
          supabaseContext = await getSupabaseContext({
            supabaseProjectId: chat.app.supabaseProjectId,
            organizationSlug: chat.app.supabaseOrganizationSlug ?? null,
          });
        } else if (!chat.app?.neonProjectId) {
          systemPrompt += "\n\n" + SUPABASE_NOT_AVAILABLE_SYSTEM_PROMPT;
        }
      } else if (dataLayerConfig) {
        const primaryConfigured =
          dataLayerConfig.primaryStore === "none" ||
          (dataLayerConfig.primaryStore === "supabase" &&
            !!chat.app?.supabaseProjectId);
        const serverConfigured =
          dataLayerConfig.serverRuntime === "none" ||
          (dataLayerConfig.serverRuntime === "supabase-edge" &&
            !!chat.app?.supabaseProjectId);
        systemPrompt +=
          "\n\n" +
          getDataLayerPrompts(dataLayerConfig, {
            primaryConfigured,
            serverConfigured,
            indexConfigured: false,
            blobConfigured: false,
          });
        if (
          dataLayerConfig.primaryStore === "supabase" &&
          chat.app?.supabaseProjectId
        ) {
          supabaseContext = await getSupabaseContext({
            supabaseProjectId: chat.app.supabaseProjectId,
            organizationSlug: chat.app.supabaseOrganizationSlug ?? null,
          });
        }
      }

      const systemPromptTokens = estimateTokens(systemPrompt + supabaseContext);

      // Extract codebase information if app is associated with the chat
      let codebaseInfo = "";
      let codebaseTokens = 0;

      if (chat.app) {
        const appPath = getJoyAppPath(chat.app.path);
        const { formattedOutput, files } = await extractCodebase({
          appPath,
          chatContext: validateChatContext(chat.app.chatContext),
        });
        codebaseInfo = formattedOutput;
        // Smart files context is now always enabled in JoyCreate (was Pro-only)
        if (settings.enableProSmartFilesContextMode ?? true) {
          codebaseTokens = estimateTokens(
            files
              // It doesn't need to be the exact format but it's just to get a token estimate
              .map(
                (file) => `<joy-file=${file.path}>${file.content}</joy-file>`,
              )
              .join("\n\n"),
          );
        } else {
          codebaseTokens = estimateTokens(codebaseInfo);
        }
        logger.log(
          `Extracted codebase information from ${appPath}, tokens: ${codebaseTokens}`,
        );
      }

      // Extract codebases for mentioned apps
      const mentionedAppsCodebases = await extractMentionedAppsCodebases(
        mentionedAppNames,
        chat.app?.id, // Exclude current app
      );

      // Calculate tokens for mentioned apps
      let mentionedAppsTokens = 0;
      if (mentionedAppsCodebases.length > 0) {
        const mentionedAppsContent = mentionedAppsCodebases
          .map(
            ({ appName, codebaseInfo }) =>
              `\n\n=== Referenced App: ${appName} ===\n${codebaseInfo}`,
          )
          .join("");

        mentionedAppsTokens = estimateTokens(mentionedAppsContent);

        logger.log(
          `Extracted ${mentionedAppsCodebases.length} mentioned app codebases, tokens: ${mentionedAppsTokens}`,
        );
      }

      // Calculate total tokens
      const totalTokens =
        messageHistoryTokens +
        inputTokens +
        systemPromptTokens +
        codebaseTokens +
        mentionedAppsTokens;

      // Find the last assistant message since totalTokens is only set on assistant messages
      const lastAssistantMessage = [...chat.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const actualMaxTokens = lastAssistantMessage?.maxTokensUsed ?? null;

      return {
        estimatedTotalTokens: totalTokens,
        actualMaxTokens,
        messageHistoryTokens,
        codebaseTokens,
        mentionedAppsTokens,
        inputTokens,
        systemPromptTokens,
        contextWindow: await getContextWindow(),
      };
    },
  );
}
