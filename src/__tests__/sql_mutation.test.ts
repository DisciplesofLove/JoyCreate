import { describe, it, expect } from "vitest";
import {
  classifySqlMutation,
  doesSqlDeleteData,
} from "../lib/sql_mutation";

describe("classifySqlMutation", () => {
  it("marks DROP TABLE as destructive", () => {
    const r = classifySqlMutation("DROP TABLE users;");
    expect(r.destructive).toBe(true);
    expect(r.destructiveStatements[0].kind).toBe("drop");
  });

  it("marks TRUNCATE as destructive", () => {
    expect(doesSqlDeleteData("TRUNCATE TABLE orders")).toBe(true);
  });

  it("marks DELETE (with and without WHERE) as destructive", () => {
    expect(doesSqlDeleteData("DELETE FROM users WHERE id = 1")).toBe(true);
    const noWhere = classifySqlMutation("DELETE FROM users");
    expect(noWhere.destructive).toBe(true);
    expect(noWhere.destructiveStatements[0].reason).toMatch(/ALL rows/i);
  });

  it("marks UPDATE as destructive", () => {
    expect(doesSqlDeleteData("UPDATE users SET name = 'x' WHERE id = 1")).toBe(
      true,
    );
    const noWhere = classifySqlMutation("UPDATE users SET name = 'x'");
    expect(noWhere.destructiveStatements[0].reason).toMatch(/ALL rows/i);
  });

  it("marks ALTER TABLE ... DROP COLUMN as destructive", () => {
    expect(
      doesSqlDeleteData("ALTER TABLE users DROP COLUMN email"),
    ).toBe(true);
  });

  it("treats SELECT as safe", () => {
    expect(doesSqlDeleteData("SELECT * FROM users WHERE id = 1")).toBe(false);
  });

  it("treats INSERT as safe", () => {
    expect(
      doesSqlDeleteData("INSERT INTO users (name) VALUES ('alice')"),
    ).toBe(false);
  });

  it("treats CREATE TABLE and ALTER ... ADD as safe", () => {
    expect(doesSqlDeleteData("CREATE TABLE t (id int)")).toBe(false);
    expect(doesSqlDeleteData("ALTER TABLE users ADD COLUMN age int")).toBe(
      false,
    );
  });

  it("does not flag destructive keywords inside string literals", () => {
    expect(
      doesSqlDeleteData("INSERT INTO logs (msg) VALUES ('please delete this')"),
    ).toBe(false);
    expect(
      doesSqlDeleteData(
        "INSERT INTO notes (body) VALUES ('DROP TABLE reminder')",
      ),
    ).toBe(false);
  });

  it("ignores destructive keywords inside comments", () => {
    expect(
      doesSqlDeleteData(
        "-- TODO: drop table later\nSELECT 1",
      ),
    ).toBe(false);
    expect(
      doesSqlDeleteData("/* DELETE FROM x */ SELECT 2"),
    ).toBe(false);
  });

  it("flags a batch when any statement is destructive", () => {
    const r = classifySqlMutation(
      "SELECT 1; INSERT INTO t VALUES (1); DELETE FROM t WHERE id = 1;",
    );
    expect(r.destructive).toBe(true);
    expect(r.statements).toHaveLength(3);
    expect(r.destructiveStatements).toHaveLength(1);
    expect(r.destructiveStatements[0].kind).toBe("delete");
  });

  it("returns a non-destructive report for empty/whitespace input", () => {
    const r = classifySqlMutation("   ");
    expect(r.destructive).toBe(false);
    expect(r.statements).toHaveLength(0);
    expect(r.summary).toMatch(/no destructive/i);
  });

  it("produces a helpful summary for destructive SQL", () => {
    const r = classifySqlMutation("DROP TABLE users; TRUNCATE orders;");
    expect(r.summary).toMatch(/Destructive SQL detected/i);
    expect(r.summary).toMatch(/DROP/);
  });
});
