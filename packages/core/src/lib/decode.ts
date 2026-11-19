import protobuf from "protobufjs";
import descriptor from "../generated/pp.descriptor.json";
import protoVersion from "../generated/proto-version.json";

export const PROTO_VERSION = protoVersion;

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);
const PlaylistDocument = root.lookupType("rv.data.PlaylistDocument");

/**
 * The playlist kinds a tool can ask for.
 *
 * `PlaylistDocument` is one message serving all of them, distinguished only by
 * its `type` field -- so every tool decodes through the same path and states
 * which kind it expects.
 */
export type PlaylistKind = "presentation" | "media" | "audio";

const KIND_TYPE: Record<PlaylistKind, number> = {
  presentation: 1,
  media: 2,
  audio: 3,
};

export type RawDoc = protobuf.Message<{}> & Record<string, any>;

export type DecodeErrorCode = "empty" | "notProtobuf" | "wrongPlaylistType";

/**
 * A decode failure, carrying a code rather than a sentence.
 *
 * The library must not decide what language the reader sees, so the message is
 * assembled in the interface layer from `code` and `params`. The `message`
 * field holds the code purely so stack traces stay readable.
 */
export class DecodeError extends Error {
  readonly code: DecodeErrorCode;
  readonly params: Record<string, string>;

  constructor(code: DecodeErrorCode, params: Record<string, string> = {}) {
    super(code);
    this.name = "DecodeError";
    this.code = code;
    this.params = params;
  }
}

/**
 * Decode a playlist document, rejecting it unless it is the expected kind.
 *
 * The error names both the expected and the actual kind, so the interface can
 * say what was wanted rather than hardcoding one tool's advice.
 */
export function decodeDocument(bytes: Uint8Array, expected: PlaylistKind): RawDoc {
  let doc: RawDoc;
  try {
    doc = PlaylistDocument.decode(bytes) as RawDoc;
  } catch (e) {
    throw new DecodeError("notProtobuf", { reason: (e as Error).message });
  }
  if (doc.type !== KIND_TYPE[expected]) {
    throw new DecodeError("wrongPlaylistType", {
      expected,
      actual: playlistTypeKey(doc.type),
    });
  }
  return doc;
}

/** Which `PlaylistDocument.Type` this is, as a key the interface can translate. */
export type PlaylistTypeKey = "unknown" | "presentation" | "media" | "audio";

function playlistTypeKey(t: unknown): PlaylistTypeKey {
  const byValue: Record<number, PlaylistTypeKey> = {
    0: "unknown",
    1: "presentation",
    2: "media",
    3: "audio",
  };
  return byValue[t as number] ?? "unknown";
}

/** Resolve a numeric enum value to its schema name, e.g. 2 -> "WIN32". */
export function enumLabel(fullyQualifiedEnum: string, value: unknown): string {
  if (typeof value === "string") return value.replace(/^[A-Z]+_/, "");
  try {
    const e = root.lookupEnum(fullyQualifiedEnum);
    const name = Object.keys(e.values).find((k) => e.values[k] === value);
    if (name) return name.replace(/^[A-Z]+_/, "");
  } catch {
    /* fall through to the raw value */
  }
  return String(value ?? "unknown");
}

/** Look up a message type from the vendored schema, for code that builds messages. */
export function messageType(fullyQualifiedName: string): protobuf.Type {
  return root.lookupType(fullyQualifiedName);
}

export function encodeDocument(doc: RawDoc): Uint8Array {
  return PlaylistDocument.encode(doc).finish();
}

/**
 * Decode a playlist document of whatever kind.
 *
 * For code that edits one it has already checked, such as a clone made for
 * editing: the media bin and the presentation playlists share one tree.
 */
export function decodeAnyDocument(bytes: Uint8Array): RawDoc {
  return PlaylistDocument.decode(bytes) as RawDoc;
}

/**
 * Deep-copy a message through the wire format.
 *
 * Anything copied out of one document into another must not be shared by
 * reference, or a later edit to either would reach into both.
 */
export function wireCopy<T = any>(type: protobuf.Type, message: unknown): T {
  return type.decode(type.encode(message as never).finish()) as T;
}

/** A fresh identity, upper-case as ProPresenter writes them. */
export function newUuid(): { string: string } {
  return { string: crypto.randomUUID().toUpperCase() };
}

/**
 * How faithfully a file survives being written back out.
 *
 * - `identical`  bytes match exactly. Safest possible result.
 * - `equivalent` bytes differ but the decoded content is the same, i.e. the
 *                original was encoded non-canonically (redundant default
 *                values, unusual field ordering). Nothing is lost, so export
 *                is still safe.
 * - `lossy`      the original carries a field the schema does not cover, or
 *                decoded content differs. Something would be dropped. Export
 *                must be refused.
 */
export type Fidelity = "identical" | "equivalent" | "lossy";

export interface FidelityReport {
  fidelity: Fidelity;
  originalSize: number;
  reEncodedSize: number;
  /** Whether writing this file back out preserves everything it contains. */
  exportSafe: boolean;
}

const TO_OBJECT: protobuf.IConversionOptions = {
  defaults: false,
  arrays: true,
  objects: true,
  enums: Number,
  longs: String,
  bytes: String,
};

function canonical(type: protobuf.Type, bytes: Uint8Array): string {
  return canonicalObject(type, type.decode(bytes));
}

/**
 * A decoded message as comparable text, the way the fidelity gate compares.
 *
 * `strip` edits the plain object first, for a comparison that is meant to
 * ignore one part of the message.
 */
export function canonicalObject(
  type: protobuf.Type,
  message: unknown,
  strip?: (plain: any) => void
): string {
  const plain = type.toObject(message as never, TO_OBJECT);
  strip?.(plain);
  return JSON.stringify(plain);
}

/** Wire types, as the low three bits of a tag. */
const WIRE_LENGTH_DELIMITED = 2;

/** protobuf.js's own wire type for each scalar, and for those it reads packed. */
const BASIC_WIRE_TYPES: Record<string, number> = protobuf.types.basic;
const PACKABLE_WIRE_TYPES: Record<string, number> = protobuf.types.packed;

/**
 * Whether protobuf.js reads every field on the wire, at every depth.
 *
 * Comparing two decodes cannot answer this: protobuf.js drops an undeclared
 * field from both, so a file carrying one decodes the same as its re-encoding
 * and would pass as merely non-canonical. Only the bytes still hold it. So this
 * walks them beside the schema and fails on anything protobuf.js would not keep:
 *
 * - a field number the message does not declare
 * - a declared field on a wire type its decoder does not read that way, which
 *   protobuf.js skips
 * - a map or a group: the schema declares neither, so this does not walk their
 *   contents and refuses them rather than vouch for what is inside
 *
 * Reads from `reader.pos` to `end` and leaves the reader at `end` on success.
 */
function wireCoveredBySchema(type: protobuf.Type, reader: protobuf.Reader, end: number): boolean {
  while (reader.pos < end) {
    const tag = reader.uint32();
    const id = tag >>> 3;
    const wireType = tag & 7;
    const field = type.fieldsById[id]?.resolve();
    if (!field || field.map) return false;

    if (field.resolvedType instanceof protobuf.Type) {
      if (wireType !== WIRE_LENGTH_DELIMITED) return false;
      const length = reader.uint32();
      const subEnd = reader.pos + length;
      if (subEnd > end || !wireCoveredBySchema(field.resolvedType, reader, subEnd)) return false;
      continue;
    }

    const isEnum = field.resolvedType instanceof protobuf.Enum;
    const expected = isEnum ? 0 : (BASIC_WIRE_TYPES[field.type] as number | undefined);
    const packed =
      field.repeated &&
      wireType === WIRE_LENGTH_DELIMITED &&
      (isEnum || PACKABLE_WIRE_TYPES[field.type] !== undefined);
    if (wireType !== expected && !packed) return false;
    reader.skipType(wireType);
  }
  return reader.pos === end;
}

/** Whether every field in `bytes` is one the schema declares and protobuf.js keeps. */
function coveredBySchema(type: protobuf.Type, bytes: Uint8Array): boolean {
  try {
    const reader = protobuf.Reader.create(bytes);
    return wireCoveredBySchema(type, reader, reader.len);
  } catch {
    return false;
  }
}

/**
 * The safety gate on every path that writes a file.
 *
 * protobuf.js discards fields the schema does not declare. Since the schema is
 * reverse-engineered from the application, a field ProPresenter writes but the
 * protos omit would silently vanish on re-encode and corrupt the library. This
 * decodes, re-encodes, and when the bytes differ checks both that the original
 * carries nothing the schema leaves out and that the decoded content matches,
 * so a merely non-canonical original is not mistaken for data loss and a lossy
 * one is not mistaken for merely non-canonical.
 *
 * Byte-identical output needs neither check: anything protobuf.js dropped would
 * be missing from it.
 *
 * Takes the message type rather than assuming one: a presentation is a
 * different root message from a playlist, and needs exactly the same gate
 * before anything is written back.
 */
export function checkTypeFidelity(type: protobuf.Type, bytes: Uint8Array): FidelityReport {
  const reEncoded = type.encode(type.decode(bytes)).finish();

  const sameBytes =
    reEncoded.length === bytes.length && reEncoded.every((b, i) => b === bytes[i]);

  const fidelity: Fidelity = sameBytes
    ? "identical"
    : coveredBySchema(type, bytes) && canonical(type, bytes) === canonical(type, reEncoded)
      ? "equivalent"
      : "lossy";

  return {
    fidelity,
    originalSize: bytes.length,
    reEncodedSize: reEncoded.length,
    exportSafe: fidelity !== "lossy",
  };
}

/** The gate for a playlist document, which is what the export feature writes. */
export function checkFidelity(bytes: Uint8Array): FidelityReport {
  return checkTypeFidelity(PlaylistDocument, bytes);
}
