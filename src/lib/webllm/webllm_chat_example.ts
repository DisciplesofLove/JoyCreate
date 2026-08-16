/**
 * Minimal streaming chat example for a WebLLM engine created by
 * {@link initWebLLMEngine}. This shows the completion call in isolation; it does
 * not manage conversation state, UI or storage — that's the caller's job.
 *
 * Renderer-only (the engine holds WebGPU resources).
 */

import type {
  MLCEngine,
  ChatCompletionMessageParam,
} from "@mlc-ai/web-llm";

export interface StreamChatOptions {
  temperature?: number;
  /** Abort mid-generation (e.g. a "stop" button or unmount). */
  signal?: AbortSignal;
}

/**
 * Stream a chat completion, invoking `onDelta` for each incremental token and
 * returning the fully-assembled text.
 *
 * The engine passed in has already loaded its model from cache or a fresh
 * download — this function neither knows nor cares which path was taken; that
 * distinction lives entirely in the init module.
 *
 * @example
 * const engine = await initWebLLMEngine({ onProgress: setLoadState });
 * const reply = await streamChatCompletion(
 *   engine,
 *   [
 *     { role: "system", content: "You are a concise assistant." },
 *     { role: "user", content: "Explain WebGPU in one sentence." },
 *   ],
 *   (delta) => appendToUI(delta),
 * );
 */
export async function streamChatCompletion(
  engine: MLCEngine,
  messages: ChatCompletionMessageParam[],
  onDelta: (delta: string) => void,
  opts: StreamChatOptions = {},
): Promise<string> {
  const chunks = await engine.chat.completions.create({
    messages,
    stream: true,
    // Ask WebLLM to include final token-usage stats in the last chunk.
    stream_options: { include_usage: true },
    temperature: opts.temperature ?? 0.7,
  });

  let full = "";
  try {
    for await (const chunk of chunks) {
      if (opts.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        full += delta;
        onDelta(delta);
      }
    }
  } catch (err) {
    // If the caller aborted, stop the in-flight decode on the engine so GPU
    // work doesn't keep running in the background, then return what we have.
    if (opts.signal?.aborted) {
      await engine.interruptGenerate();
      return full;
    }
    throw err;
  }

  return full;
}
