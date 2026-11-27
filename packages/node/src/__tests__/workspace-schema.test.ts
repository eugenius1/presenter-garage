import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA as READ_SCHEMA, sqlite } from "./workspace-db";
import { SCHEMA as WRITE_SCHEMA } from "./workspace-writable";

/**
 * The test stores' columns, held to the ones ProPresenter makes, as
 * docs/propresenter-22-workspaces.md lists them from a real store. A column
 * misnamed in a fixture and in the code alike passes every other test while
 * the real store has no such column, so the names are checked here, once.
 */

const doc = fs.readFileSync(new URL("../../../../docs/propresenter-22-workspaces.md", import.meta.url), "utf8");

/** The columns in ProPresenter's order, from the sentence that gives them. */
function documentedOrder(): string[] {
  const sentence = doc.match(/In ProPresenter's order: ([^(]*)\(/)?.[1];
  if (!sentence) throw new Error("docs/propresenter-22-workspaces.md no longer lists the columns in order");
  return [...sentence.matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]);
}

/** Every column the table describes, in its first column. */
function documentedInTable(): Set<string> {
  const table = doc.slice(doc.indexOf("`workspace_streams` has one row per document"), doc.indexOf("In ProPresenter's order"));
  return new Set(
    table
      .split("\n")
      .filter((line) => line.startsWith("| `"))
      .flatMap((line) => [...line.split("|")[1].matchAll(/`([a-z_0-9]+)`/g)].map((m) => m[1]))
  );
}

function columnsOf(schema: string): string[] {
  const db = new sqlite!.DatabaseSync(":memory:");
  db.exec(schema);
  const names = (db.prepare("PRAGMA table_info(workspace_streams)").all() as { name: string }[]).map((c) => c.name);
  db.close();
  return names;
}

describe.skipIf(!sqlite)("the test stores' columns", () => {
  it("are documented, each described in the table", () => {
    expect(documentedOrder()).toContain("last_shared_version_vector_absence_reason");
    expect(new Set(documentedOrder())).toEqual(documentedInTable());
  });

  it("are ProPresenter's, in its order, in the store the write path is tested on", () => {
    expect(columnsOf(WRITE_SCHEMA)).toEqual(documentedOrder());
  });

  it("are among ProPresenter's, in its order, in the store the read path is tested on", () => {
    const order = documentedOrder();
    const read = columnsOf(READ_SCHEMA);
    expect(read.every((name) => order.includes(name))).toBe(true);
    expect(read).toEqual(order.filter((name) => read.includes(name)));
  });
});
