import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { absoluteFolder, writeOut } from "./commands/out-folder";
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
 * files are replaced as the review goes on -- `choices.json`, `runs.json`
 * and the snapshot `review.html` -- each written whole beside itself and
 * renamed over the last, so a reader never finds half of one, and each read, changed and
 * written in one turn of the review's queue, so two saves never build on
 * the same old copy. Nothing else in the folder, or outside it, is ever
 * replaced.
 *
 * `plan.json` is written once. Its hash is recorded at plan time in the
 * server's own `Reviews` folder, outside `out`, with the folder it was
 * written into, so a plan changed since -- by hand, by a tool, by mistake --
 * or one copied into another review is refused whole: what is applied must
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
  /** When the page first showed the review: nothing is applied from a review nobody has opened. */
  shown?: string;
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
/** A read-only page of the review as it stands, to open from the disk. */
export const SNAPSHOT = "review.html";
/** The only files a review ever replaces. */
type ReplacedFile = typeof CHOICES | typeof RUNS | typeof SNAPSHOT;

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

/** A review folder named by a model or a person, as its real path. */
async function reviewFolder(given: string): Promise<string> {
  try {
    return await fs.realpath(absoluteFolder(given, "the review"));
  } catch (e) {
    if (e instanceof LibraryError) throw e;
    throw new LibraryError(`There is no review folder at ${given}.`);
  }
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
 * Read a review folder once every write to it already asked for has landed,
 * refusing a `plan.json` whose hash this server did not record when it
 * wrote it into this very folder, and a `choices.json` about any other plan.
 */
export async function readReview(given: string, reviewsDir: string): Promise<Review> {
  const folder = await reviewFolder(given);
  return inTurn(folder, () => readNow(folder, reviewsDir));
}

/** The read itself, for a caller already in the folder's turn. */
async function readNow(folder: string, reviewsDir: string): Promise<Review> {
  const planned = await readJson(path.join(folder, PLAN), PLAN);
  const hash = sha256(planned.bytes);
  const record = await fs.readFile(path.join(reviewsDir, hash), "utf8").then(
    (text) => (JSON.parse(text) as { folder?: unknown }).folder,
    () => undefined
  );
  if (record !== folder) {
    throw new LibraryError(
      `${path.join(folder, PLAN)} is not a plan this server wrote into this folder: it has changed since, was moved or ` +
        "copied here from another review, or was made on another computer. " +
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

/**
 * The presentations a run of this review has written. The rest of their
 * changes cannot be applied from it: the file's hash changed when it was
 * written, so they need a new plan.
 */
export const closedIn = (review: Pick<Review, "runs">) =>
  new Set(review.runs.flatMap((run) => run.files.filter((file) => file.written).map((file) => file.path)));

/** Each change's number, with the presentation it is in. */
const changesByFile = (plan: Plan) => plan.files.flatMap((file) => [...file.lines, ...file.changes].map(({ n }) => ({ n, path: file.path })));

/** The changes an apply would write now: left ticked, in a presentation no earlier run wrote. */
export function chosenNow(review: Review): Set<number> {
  const closed = closedIn(review);
  return new Set(changesByFile(review.plan).filter(({ n, path: p }) => review.choices.changes[n]?.ticked === true && !closed.has(p)).map(({ n }) => n));
}

/** Changes not written, in a presentation a run wrote: the ones only a new plan can make. */
export function needNewPlan(review: Review): number[] {
  const closed = closedIn(review);
  const written = writtenIn(review);
  return changesByFile(review.plan).filter(({ n, path: p }) => closed.has(p) && !written.has(n)).map(({ n }) => n);
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
  return { ...review.choices, changes: merged };
}

/** Writes to one review folder, one at a time: two renames racing could land the older last. */
const queues = new Map<string, Promise<unknown>>();

/** Run `work` once everything asked of this folder before it has finished. */
function inTurn<T>(folder: string, work: () => Promise<T>): Promise<T> {
  const run = (queues.get(folder) ?? Promise.resolve()).then(work);
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
 * link left in the file's place rather than following it. Called in the
 * folder's turn.
 */
async function replace(folder: string, name: ReplacedFile, content: string): Promise<void> {
  const temp = path.join(folder, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  await fs.writeFile(temp, content, { flag: "wx" });
  try {
    // The folder itself checked again: a folder swapped for a link would put the file elsewhere.
    if ((await fs.realpath(folder)) !== folder) throw new LibraryError(`${folder} has moved, so the review was not saved.`);
    await fs.rename(temp, path.join(folder, name));
  } catch (e) {
    await fs.rm(temp, { force: true });
    throw e;
  }
}

/** Read the review, change it, and write what changed, all in one turn, so no other save lands in between. */
async function update(given: string, reviewsDir: string, change: (review: Review) => Partial<Pick<Review, "choices" | "runs">>): Promise<Review> {
  const folder = await reviewFolder(given);
  return inTurn(folder, async () => {
    const review = await readNow(folder, reviewsDir);
    const { choices, runs } = change(review);
    if (choices) await replace(folder, CHOICES, JSON.stringify(choices));
    if (runs) await replace(folder, RUNS, JSON.stringify(runs, null, 1));
    return { ...review, ...(choices && { choices }), ...(runs && { runs }) };
  });
}

/** Save the choices the page sent, checked against the plan as it is on disk now. */
export const saveChoices = (given: string, reviewsDir: string, sent: unknown) =>
  update(given, reviewsDir, (review) => ({ choices: mergeChoices(review, sent) }));

/** Record that the page has shown the review, the first time it does. */
export const markShown = (given: string, reviewsDir: string) =>
  update(given, reviewsDir, (review) => (review.choices.shown ? {} : { choices: { ...review.choices, shown: new Date().toISOString() } }));

/** Record an apply's outcome, so the page can show it and a later apply writes nothing twice. */
export const recordRun = (given: string, reviewsDir: string, run: ReviewRun) =>
  update(given, reviewsDir, (review) => ({ runs: [...review.runs, run] }));

/** Write the review's read-only snapshot as `render` draws it from the review as it is now. Returns the file. */
export async function writeSnapshot(given: string, reviewsDir: string, render: (review: Review) => string): Promise<string> {
  const folder = await reviewFolder(given);
  return inTurn(folder, async () => {
    await replace(folder, SNAPSHOT, render(await readNow(folder, reviewsDir)));
    return path.join(folder, SNAPSHOT);
  });
}
