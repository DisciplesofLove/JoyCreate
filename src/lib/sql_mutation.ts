/**
 * SQL mutation classifier.
 *
 * Used to decide whether an agent-issued SQL statement is *destructive* (can
 * drop tables/columns or delete/overwrite existing rows) and therefore must
 * force explicit user approval — even when the `execute_sql` tool is otherwise
 * set to auto-approve. Mirrors Dyad's "require approval for destructive SQL"
 * safety gate.
 *
 * This is intentionally a lightweight lexical classifier, not a full SQL
 * parser. It errs on the side of caution: when in doubt, it marks a statement
 * destructive so the user is asked. Comments and string literals are stripped
 * first so keywords inside them don't trigger false positives.
 */

export type SqlMutationKind =
  | "drop" // DROP TABLE/SCHEMA/DATABASE/COLUMN
  | "truncate" // TRUNCATE
  | "delete" // DELETE
  | "update" // UPDATE (overwrites existing rows)
  | "alter-destructive" // ALTER TABLE ... DROP COLUMN/CONSTRAINT
  | "safe"; // SELECT/INSERT/CREATE/etc. — no existing data at risk

export interface SqlStatementClassification {
  statement: string;
  destructive: boolean;
  kind: SqlMutationKind;
  /** Human-readable reason, suitable for a consent prompt. */
  reason: string;
}

export interface SqlMutationReport {
  destructive: boolean;
  /** Only the statements that were flagged destructive. */
  destructiveStatements: SqlStatementClassification[];
  /** Every parsed statement, in order. */
  statements: SqlStatementClassification[];
  /** One-line summary suitable for a consent preview. */
  summary: string;
}

/**
 * Remove SQL comments and string/identifier literals so that keyword matching
 * only sees actual SQL tokens (avoids matching "delete" inside a string value).
 */
function stripCommentsAndLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Line comment: -- ... EOL
    if (ch === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    // Single-quoted string literal (handles '' escape)
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += " '' ";
      continue;
    }
    // Dollar-quoted string ($$...$$ or $tag$...$tag$) — common in PL/pgSQL
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) {
          // Unterminated — consume the rest defensively.
          i = n;
        } else {
          i = end + tag.length;
        }
        out += " '' ";
        continue;
      }
    }
    // Double-quoted identifier — keep a placeholder token so structure survives.
    if (ch === '"') {
      i++;
      while (i < n && sql[i] !== '"') i++;
      i++;
      out += " id ";
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/** Split a (comment/literal-stripped) SQL blob into individual statements. */
function splitStatements(strippedSql: string): string[] {
  return strippedSql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function classifyStatement(stripped: string): {
  destructive: boolean;
  kind: SqlMutationKind;
  reason: string;
} {
  const s = stripped.replace(/\s+/g, " ").trim().toLowerCase();

  if (!s) return { destructive: false, kind: "safe", reason: "empty statement" };

  // DROP TABLE / SCHEMA / DATABASE / VIEW / COLUMN / TYPE ...
  if (/^drop\s+/.test(s)) {
    return {
      destructive: true,
      kind: "drop",
      reason: "DROP removes a database object and its data",
    };
  }

  // TRUNCATE — empties a table.
  if (/^truncate\b/.test(s)) {
    return {
      destructive: true,
      kind: "truncate",
      reason: "TRUNCATE deletes all rows in the table",
    };
  }

  // DELETE — destructive; a missing WHERE clause is especially dangerous.
  if (/^delete\s+from\b/.test(s) || /^delete\b/.test(s)) {
    const hasWhere = /\bwhere\b/.test(s);
    return {
      destructive: true,
      kind: "delete",
      reason: hasWhere
        ? "DELETE removes matching rows"
        : "DELETE with no WHERE clause removes ALL rows",
    };
  }

  // UPDATE — overwrites existing data; no-WHERE overwrites every row.
  if (/^update\s+/.test(s)) {
    const hasWhere = /\bwhere\b/.test(s);
    return {
      destructive: true,
      kind: "update",
      reason: hasWhere
        ? "UPDATE overwrites matching rows"
        : "UPDATE with no WHERE clause overwrites ALL rows",
    };
  }

  // ALTER TABLE ... DROP COLUMN / DROP CONSTRAINT — destructive schema change.
  if (/^alter\s+table\b/.test(s) && /\bdrop\b/.test(s)) {
    return {
      destructive: true,
      kind: "alter-destructive",
      reason: "ALTER TABLE ... DROP removes a column or constraint",
    };
  }

  // Everything else (SELECT, INSERT, CREATE, ALTER ... ADD, GRANT, etc.) does
  // not put existing data at risk.
  return { destructive: false, kind: "safe", reason: "no existing data at risk" };
}

/**
 * Classify a SQL blob (which may contain multiple `;`-separated statements).
 */
export function classifySqlMutation(sql: string): SqlMutationReport {
  const stripped = stripCommentsAndLiterals(sql ?? "");
  const rawStatements = splitStatements(stripped);
  // Keep original (non-stripped) text alignment loosely by re-splitting source
  // on the same boundaries for display; fall back to stripped text.
  const originalStatements = (sql ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const statements: SqlStatementClassification[] = rawStatements.map(
    (strippedStmt, idx) => {
      const { destructive, kind, reason } = classifyStatement(strippedStmt);
      return {
        statement: originalStatements[idx] ?? strippedStmt,
        destructive,
        kind,
        reason,
      };
    },
  );

  const destructiveStatements = statements.filter((s) => s.destructive);
  const destructive = destructiveStatements.length > 0;

  let summary: string;
  if (!destructive) {
    summary = "No destructive statements detected.";
  } else {
    const kinds = Array.from(
      new Set(destructiveStatements.map((s) => s.kind.toUpperCase())),
    ).join(", ");
    summary = `Destructive SQL detected (${kinds}): ${destructiveStatements[0].reason}.`;
  }

  return { destructive, destructiveStatements, statements, summary };
}

/**
 * Convenience predicate: does this SQL delete or overwrite existing data, or
 * drop schema objects? Returns true for DROP/TRUNCATE/DELETE/UPDATE/ALTER-DROP.
 */
export function doesSqlDeleteData(sql: string): boolean {
  return classifySqlMutation(sql).destructive;
}
