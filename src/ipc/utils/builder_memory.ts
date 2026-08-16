import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("builder_memory");

// ── Builder file memory (.joy/memory/) ───────────────────────────────────────
// Deterministic, code-maintained per-app memory that keeps the builder anchored
// to what has been built across many turns — independent of whether the model
// remembers to update PROJECT.md.
//
// Files:
//   progress.md  — append-only per-turn ledger, written BY CODE after every turn
//   decisions.md — design decision log, written by the MODEL via <joy-write>
//   todo.md      — open items, written by the MODEL via <joy-write>
//   state.json   — internal counters (turn count, spec-write enforcement)

export const BUILDER_MEMORY_DIR = path.join(".joy", "memory");
const PROGRESS_FILE = "progress.md";
const DECISIONS_FILE = "decisions.md";
const TODO_FILE = "todo.md";
const STATE_FILE = "state.json";

// Caps for the injected memory block (chars). Combined they stay well under
// ~8k chars (~2.9k tokens) so the prefix remains cheap.
const MAX_PROGRESS_TAIL_CHARS = 3_500;
const MAX_DECISIONS_CHARS = 2_500;
const MAX_TODO_CHARS = 1_500;

// Keep progress.md itself from growing unboundedly on disk.
const MAX_PROGRESS_FILE_CHARS = 64_000;
const TRIMMED_PROGRESS_FILE_CHARS = 48_000;

interface BuilderMemoryState {
  turnCount: number;
  turnsSinceSpecWrite: number;
  lastUpdatedIso: string;
}

const DEFAULT_STATE: BuilderMemoryState = {
  turnCount: 0,
  turnsSinceSpecWrite: 0,
  lastUpdatedIso: "",
};

export interface TurnRecord {
  userPrompt?: string;
  chatSummary?: string;
  writtenFiles: string[];
  renamedFiles: string[];
  deletedFiles: string[];
  addedDependencies: string[];
}

export interface BuilderMemory {
  progressTail: string | null;
  decisions: string | null;
  todos: string | null;
  turnCount: number;
  turnsSinceSpecWrite: number;
}

function memoryDirPath(appPath: string): string {
  return path.join(appPath, BUILDER_MEMORY_DIR);
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

async function readState(appPath: string): Promise<BuilderMemoryState> {
  try {
    const raw = await fs.promises.readFile(
      path.join(memoryDirPath(appPath), STATE_FILE),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    return {
      turnCount: typeof parsed.turnCount === "number" ? parsed.turnCount : 0,
      turnsSinceSpecWrite:
        typeof parsed.turnsSinceSpecWrite === "number"
          ? parsed.turnsSinceSpecWrite
          : 0,
      lastUpdatedIso:
        typeof parsed.lastUpdatedIso === "string" ? parsed.lastUpdatedIso : "",
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/** Take the tail of `content`, starting at the first "## " heading within the tail window. */
function tailAtHeading(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const tail = content.slice(-maxChars);
  const headingIndex = tail.indexOf("\n## ");
  return headingIndex >= 0
    ? tail.slice(headingIndex + 1)
    : tail;
}

function firstMeaningfulLine(text: string, maxChars = 200): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip code fences / tags — we want the human intent.
    if (trimmed.startsWith("```") || trimmed.startsWith("<")) continue;
    return trimmed.length > maxChars
      ? trimmed.slice(0, maxChars) + "…"
      : trimmed;
  }
  return "";
}

function isProjectSpecPath(filePath: string): boolean {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase() ===
    "project.md";
}

/**
 * Deterministically record a completed builder turn in .joy/memory/.
 * Called from the response processor after every build turn — this NEVER
 * depends on the model remembering to write its own memory.
 *
 * Returns the repo-relative paths of memory files written (so callers can
 * stage them into the turn's git commit).
 */
export async function recordTurnInBuilderMemory(
  appPath: string,
  record: TurnRecord,
): Promise<string[]> {
  const dir = memoryDirPath(appPath);
  await fs.promises.mkdir(dir, { recursive: true });

  const state = await readState(appPath);
  const specWasUpdated = record.writtenFiles.some(isProjectSpecPath);
  const nowIso = new Date().toISOString();
  const newState: BuilderMemoryState = {
    turnCount: state.turnCount + 1,
    turnsSinceSpecWrite: specWasUpdated ? 0 : state.turnsSinceSpecWrite + 1,
    lastUpdatedIso: nowIso,
  };

  // Build the progress entry
  const lines: string[] = [`## Turn ${newState.turnCount} — ${nowIso}`];
  const intent =
    record.chatSummary?.trim() ||
    (record.userPrompt ? firstMeaningfulLine(record.userPrompt) : "");
  if (intent) lines.push(`Intent: ${intent}`);
  const actions: string[] = [];
  const nonMemoryWrites = record.writtenFiles.filter(
    (f) => !f.replace(/\\/g, "/").startsWith(".joy/"),
  );
  if (nonMemoryWrites.length > 0)
    actions.push(`Wrote: ${nonMemoryWrites.join(", ")}`);
  if (record.renamedFiles.length > 0)
    actions.push(`Renamed: ${record.renamedFiles.join(", ")}`);
  if (record.deletedFiles.length > 0)
    actions.push(`Deleted: ${record.deletedFiles.join(", ")}`);
  if (record.addedDependencies.length > 0)
    actions.push(`Deps added: ${record.addedDependencies.join(", ")}`);
  if (actions.length > 0) {
    lines.push(...actions.map((a) => `- ${a}`));
  } else {
    lines.push("- (no file changes this turn)");
  }
  if (!specWasUpdated && newState.turnsSinceSpecWrite >= 2) {
    lines.push(
      `- NOTE: PROJECT.md not updated for ${newState.turnsSinceSpecWrite} turns`,
    );
  }
  const entry = lines.join("\n") + "\n\n";

  // Append to progress.md, trimming from the top if the file got too large.
  const progressPath = path.join(dir, PROGRESS_FILE);
  const existing = (await readFileOrNull(progressPath)) ?? "";
  let updated = existing ? existing + "\n" + entry : entry;
  if (updated.length > MAX_PROGRESS_FILE_CHARS) {
    updated =
      "[Older progress entries trimmed]\n\n" +
      tailAtHeading(updated, TRIMMED_PROGRESS_FILE_CHARS);
  }
  await fs.promises.writeFile(progressPath, updated, "utf8");

  await fs.promises.writeFile(
    path.join(dir, STATE_FILE),
    JSON.stringify(newState, null, 2),
    "utf8",
  );

  logger.log(
    `Recorded turn ${newState.turnCount} in builder memory (specUpdated=${specWasUpdated}, turnsSinceSpecWrite=${newState.turnsSinceSpecWrite})`,
  );

  const relDir = BUILDER_MEMORY_DIR.replace(/\\/g, "/");
  return [`${relDir}/${PROGRESS_FILE}`, `${relDir}/${STATE_FILE}`];
}

/**
 * Read the builder memory for injection into the chat context. Returns null
 * when no memory exists yet (new app or pre-memory app).
 */
export async function readBuilderMemory(
  appPath: string,
): Promise<BuilderMemory | null> {
  const dir = memoryDirPath(appPath);
  const [progress, decisions, todos, state] = await Promise.all([
    readFileOrNull(path.join(dir, PROGRESS_FILE)),
    readFileOrNull(path.join(dir, DECISIONS_FILE)),
    readFileOrNull(path.join(dir, TODO_FILE)),
    readState(appPath),
  ]);
  if (!progress && !decisions && !todos) return null;
  return {
    progressTail: progress ? tailAtHeading(progress, MAX_PROGRESS_TAIL_CHARS) : null,
    decisions: decisions ? tailAtHeading(decisions, MAX_DECISIONS_CHARS) : null,
    todos:
      todos && todos.length > MAX_TODO_CHARS
        ? todos.slice(0, MAX_TODO_CHARS) + "\n[todo.md truncated]"
        : todos,
    turnCount: state.turnCount,
    turnsSinceSpecWrite: state.turnsSinceSpecWrite,
  };
}

/**
 * Format the builder memory as a text block for the context prefix.
 */
export function buildBuilderMemoryBlock(memory: BuilderMemory): string {
  const sections: string[] = [
    "--- BUILDER MEMORY (.joy/memory/) ---",
    `This project has been built over ${memory.turnCount} turn(s). The following is the app's persistent build memory.`,
  ];
  if (memory.progressTail) {
    sections.push(
      `## Recent build progress (auto-maintained — do NOT write this file)\n${memory.progressTail}`,
    );
  }
  if (memory.decisions) {
    sections.push(`## Design decisions (.joy/memory/decisions.md)\n${memory.decisions}`);
  }
  if (memory.todos) {
    sections.push(`## Open TODOs (.joy/memory/todo.md)\n${memory.todos}`);
  }
  sections.push("--- END BUILDER MEMORY ---");
  return sections.join("\n\n");
}
