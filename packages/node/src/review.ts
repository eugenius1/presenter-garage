import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeOut } from "./commands/out-folder";
import { isInside, LibraryError } from "./library";
import type { AppliedFile } from "./apply";
import type { Plan } from "./plans";
import { appDataDir, sha256 } from "./write";

/**
 * A review folder: a plan kept on disk, beside the person's choices about
 * it, so they can choose on a page of its own, come back after a break, and
 * have exactly what they chose applied. See docs/design/guard3-review-file.md.
 *
 * The folder is made inside an `out` folder by `writeOut()`, so it is never
 * inside, nor holding, a library. Unlike the rest of `out`, three of its
 * files are replaced as the review goes on -- `choices.json`, `runs.json`,
 * and the page's snapshot -- each written whole beside itself and renamed
 * over the last, so a reader never finds half of one. Nothing else in the
 * folder, or outside it, is ever replaced.
 *
 * `plan.json` is written once. Its hash is recorded at plan time in the
 * server's own `Reviews` folder, outside `out`, so a plan changed since --
 * by hand, by a tool, by mistake -- is refused whole: what is applied must
 * be what the page showed. That is not proof against somebody determined;
 * the design note says why that was weighed and accepted.
 */

/** What `plan.json` holds: the plan, and the library it was made in, which `refuseUnlessOpen()` compares. */
interface PlanFile {
  version: 1;
  root: string;
  backupDir: string;
  plan: Plan;
}

/** One change as the person left it: ticked or not, and why, in a line. */
export interface Choice {
  ticked: boolean;
  note?: string;
}

/** What `choices.json` holds, bound to the plan it is about by that plan's hash. */
export interface Choices {
  plan: string;
  changes: Record<string, Choice>;
}

/** One apply of the review, as `runs.json` keeps it. */
export interface ReviewRun {
  at: string;
  /** The changes this run wrote, by number. */
  written: number[];
  files: Omit<AppliedFile, "rangeReason">[];
}

export interface Review {
  /** The review folder, as its real path. */
  folder: string;
  /** Of `plan.json`'s bytes, as recorded when it was written. */
  hash: string;
  root: string;
  backupDir: string;
  plan: Plan;
  choices: Choices;
  runs: ReviewRun[];
}

/** The longest note kept: one line, said in a sentence or two. */
export const MAX_NOTE = 500;

const PLAN = "plan.json";
const CHOICES = "choices.json";
const RUNS = "runs.json";
/** The only files a review ever replaces. */
export type ReplacedFile = typeof CHOICES | typeof RUNS | "review.html";

/** Where plans' hashes are recorded when nobody says: the app's own data folder, beside its backups. */
export const defaultReviewsDir = () => appDataDir("Reviews");

/** A workspace's document id is bytes, which JSON has no word for. */
const replacer = (_key: string, value: unknown) =>
  value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value;
const reviver = (_key: string, value: unknown) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const bytes = (value as { $bytes?: unknown }).$bytes;
    if (typeof bytes === "string" && Object.keys(value).length === 1) return new Uint8Array(Buffer.from(bytes, "base64"));
  }
  return value;
};

/** Every change a plan names, by number. */
export const changeNumbers = (plan: Plan) => plan.files.flatMap((file) => [...file.lines, ...file.changes].map(({ n }) => n));

/**
 * Make a review folder for `plan` inside `out`, every change ticked, and
 * record the plan's hash in `reviewsDir`. Returns the folder.
 */
export async function createReview(
  out: string,
  roots: readonly string[],
  plan: Plan,
  made: { root: string; backupDir: string },
  reviewsDir: string
): Promise<Review> {
  const recorded = await openReviewsDir(reviewsDir, roots);
  const body: PlanFile = { version: 1, root: made.root, backupDir: made.backupDir, plan };
  const bytes = JSON.stringify(body, replacer, 1);
  const hash = sha256(new TextEncoder().encode(bytes));
  const choices: Choices = { plan: hash, changes: Object.fromEntries(changeNumbers(plan).map((n) => [n, { ticked: true }])) };
  return writeOut(out, "review", roots, async (folder) => {
    await folder.put(PLAN, bytes);
    await folder.put(CHOICES, JSON.stringify(choices));
    await folder.put(RUNS, "[]");
    const real = await fs.realpath(folder.dir);
    // Last, so a hash is never recorded for a folder that was not finished.
    await fs.writeFile(path.join(recorded, hash), JSON.stringify({ folder: real }), { flag: "wx", mode: 0o600 });
    return { folder: real, hash, root: made.root, backupDir: made.backupDir, plan, choices, runs: [] };
  });
}

/** The folder plans' hashes are recorded in, made if need be, refused inside a library: there it would be a write to it. */
async function openReviewsDir(dir: string, roots: readonly string[]): Promise<string> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const real = await fs.realpath(dir);
  if (roots.some((root) => root === real || isInside(root, real))) {
    throw new LibraryError(`The folder reviews are recorded in, ${real}, is inside a library folder.`);
  }
  return real;
}

/** A review folder named by a model or a person, as an absolute path. */
function reviewFolder(given: string): string {
  const dir = given.startsWith("file:") ? fileURLToPath(given) : given;
  if (!path.isAbsolute(dir)) throw new LibraryError(`Give the review folder as an absolute path, not ${given}.`);
  return dir;
}

async function readJson(file: string, what: string): Promise<{ bytes: Uint8Array; value: unknown }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await fs.readFile(file));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") throw new LibraryError(`${path.dirname(file)} is not a review folder: it has no ${what}.`);
    throw e;
  }
  try {
    return { bytes, value: JSON.parse(new TextDecoder().decode(bytes), reviver) };
  } catch {
    throw new LibraryError(`${file} is not JSON, so the review cannot be read. Plan the edits again.`);
  }
}

/**
 * Read a review folder, refusing a `plan.json` whose hash this server did not
 * record when it wrote it, and a `choices.json` about any other plan.
 */
export async function readReview(given: string, reviewsDir: string): Promise<Review> {
  let folder: string;
  try {
    folder = await fs.realpath(reviewFolder(given));
  } catch {
    throw new LibraryError(`There is no review folder at ${given}.`);
  }
  const planned = await readJson(path.join(folder, PLAN), PLAN);
  const hash = sha256(planned.bytes);
  const recorded = await fs.stat(path.join(reviewsDir, hash)).then((s) => s.isFile(), () => false);
  if (!recorded) {
    throw new LibraryError(
      `${path.join(folder, PLAN)} is not a plan this server wrote: it has changed since, or was made on another computer. ` +
        "Nothing was read from it. Plan the edits again."
    );
  }
  const body = planned.value as PlanFile;
  const choices = (await readJson(path.join(folder, CHOICES), CHOICES)).value as Choices;
  if (!choices || typeof choices !== "object" || choices.plan !== hash || !choices.changes || typeof choices.changes !== "object") {
    throw new LibraryError(`${path.join(folder, CHOICES)} is not about the plan beside it, so nothing was read from it.`);
  }
  const runs = (await readJson(path.join(folder, RUNS), RUNS)).value;
  if (!Array.isArray(runs)) throw new LibraryError(`${path.join(folder, RUNS)} is not a list of runs, so the review cannot be read.`);
  return { folder, hash, root: body.root, backupDir: body.backupDir, plan: body.plan, choices, runs: runs as ReviewRun[] };
}

/** Every change a run of this review has written. */
export const writtenIn = (review: Pick<Review, "runs">) => new Set(review.runs.flatMap((run) => run.written));

/** The changes an apply would write now: left ticked, and not written by an earlier run. */
export function chosenNow(review: Review): Set<number> {
  const written = writtenIn(review);
  return new Set(changeNumbers(review.plan).filter((n) => review.choices.changes[n]?.ticked === true && !written.has(n)));
}

/**
 * The person's choices as the page sent them, checked against the plan:
 * every change named is one the plan has, every tick a boolean, every note
 * one line of text. A change left out keeps its last choice.
 */
export function mergeChoices(review: Review, sent: unknown): Choices {
  const changes = (sent as { changes?: unknown } | null)?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) throw new LibraryError("No choices were sent.");
  const known = new Set(changeNumbers(review.plan).map(String));
  const merged: Record<string, Choice> = { ...review.choices.changes };
  for (const [key, value] of Object.entries(changes)) {
    if (!known.has(key)) throw new LibraryError(`The plan has no change ${key}.`);
    const { ticked, note } = (value ?? {}) as { ticked?: unknown; note?: unknown };
    if (typeof ticked !== "boolean") throw new LibraryError(`Change ${key} is neither ticked nor unticked.`);
    if (note !== undefined && typeof note !== "string") throw new LibraryError(`Change ${key}'s note is not text.`);
    const line = note?.replace(/[\r\n\u2028\u2029]+/g, " ").trim().slice(0, MAX_NOTE);
    merged[key] = { ticked, ...(line ? { note: line } : {}) };
  }
  return { plan: review.hash, changes: merged };
}

/** Writes to one review folder, one at a time: two renames racing could land the older last. */
const queues = new Map<string, Promise<unknown>>();

/** Run `write` once every earlier write to this folder has finished. */
function inTurn<T>(folder: string, write: () => Promise<T>): Promise<T> {
  const run = (queues.get(folder) ?? Promise.resolve()).then(write);
  const settled = run.catch(() => undefined);
  queues.set(folder, settled);
  void settled.then(() => {
    if (queues.get(folder) === settled) queues.delete(folder);
  });
  return run;
}

/**
 * Replace one of the files a review keeps up to date: written whole beside
 * it under a name nothing else uses, then renamed over it, so a reader finds
 * the old file or the new one and never half of either. A rename replaces a
 * link left in the file's place rather than following it.
 */
export function replaceInReview(folder: string, name: ReplacedFile, content: string): Promise<void> {
  return inTurn(folder, async () => {
    const target = path.join(folder, name);
    const temp = path.join(folder, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
    await fs.writeFile(temp, content, { flag: "wx" });
    try {
      // The folder itself checked again: a folder swapped for a link would put the file elsewhere.
      if ((await fs.realpath(folder)) !== folder) throw new LibraryError(`${folder} has moved, so the review was not saved.`);
      await fs.rename(temp, target);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  });
}

/** Save the person's choices, as `mergeChoices` checked them. */
export async function saveChoices(review: Review, choices: Choices): Promise<void> {
  await replaceInReview(review.folder, CHOICES, JSON.stringify(choices));
  review.choices = choices;
}

/** Record an apply's outcome, so the page can show it and a later apply writes nothing twice. */
export async function recordRun(review: Review, run: ReviewRun): Promise<void> {
  const runs = [...review.runs, run];
  await replaceInReview(review.folder, RUNS, JSON.stringify(runs, null, 1));
  review.runs = runs;
}
