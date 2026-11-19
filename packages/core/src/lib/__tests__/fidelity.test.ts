import protobuf from "protobufjs";
import { describe, expect, it } from "vitest";
import { checkFidelity, checkTypeFidelity, messageType } from "../decode";
import { checkPresentationFidelity } from "../presentation";
import { syntheticMediaFile, syntheticTextPresentation } from "./synthetic";

/**
 * The gate against fields the schema does not declare.
 *
 * protobuf.js drops such a field when it decodes, so comparing the decoded
 * original against the decoded re-encoding sees nothing missing from either:
 * the gate once rated a file carrying one `equivalent`, and every write surface
 * would have written it back without it. These build such files on purpose.
 */

const Presentation = messageType("rv.data.Presentation");
const Timestamp = messageType("rv.data.Timestamp");

/** Field 9999, varint 1: a number no message in the schema declares. */
const UNKNOWN_FIELD = new Uint8Array([0xf8, 0xf0, 0x04, 0x01]);

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Re-encode `message` with the submessage at `path` moved to the end of its
 * parent and `extra` appended inside it.
 *
 * Each step names a message field; a repeated one takes its last element, so
 * moving it to the end keeps the elements in order. With no `extra` the result
 * is complete but laid out differently from how protobuf.js writes it.
 */
function withTrailing(
  type: protobuf.Type,
  message: Record<string, any>,
  path: string[],
  extra: Uint8Array
): Uint8Array {
  if (path.length === 0) return concat(type.encode(message).finish(), extra);
  const [name, ...rest] = path;
  const field = type.fields[name]!.resolve();
  const value = message[name];
  let child: Record<string, any>;
  if (field.repeated) {
    expect(value?.length, `${name} has an element to move`).toBeGreaterThan(0);
    child = value.pop();
  } else {
    expect(value, `${name} is set`).toBeTruthy();
    child = value;
    message[name] = null;
  }
  const inner = withTrailing(field.resolvedType as protobuf.Type, child, rest, extra);
  const writer = type.encode(message);
  writer.uint32((field.id << 3) | 2).bytes(inner);
  return writer.finish();
}

const presentation = () => Presentation.decode(syntheticTextPresentation()) as any;

describe("fields the schema does not declare", () => {
  it("rates a top-level unknown field lossy", () => {
    const bytes = concat(syntheticTextPresentation(), UNKNOWN_FIELD);
    const report = checkPresentationFidelity(bytes);
    expect(report.fidelity).toBe("lossy");
    expect(report.exportSafe).toBe(false);
  });

  it("rates an unknown field inside a singular submessage lossy", () => {
    const bytes = withTrailing(Presentation, presentation(), ["uuid"], UNKNOWN_FIELD);
    expect(checkPresentationFidelity(bytes).fidelity).toBe("lossy");
  });

  it("rates an unknown field two levels down a repeated submessage lossy", () => {
    const bytes = withTrailing(Presentation, presentation(), ["cues", "uuid"], UNKNOWN_FIELD);
    expect(checkPresentationFidelity(bytes).fidelity).toBe("lossy");
  });

  it("rates an unknown field in a playlist document lossy", () => {
    const report = checkFidelity(concat(syntheticMediaFile(), UNKNOWN_FIELD));
    expect(report.fidelity).toBe("lossy");
    expect(report.exportSafe).toBe(false);
  });

  it("rates a declared field on the wrong wire type lossy", () => {
    // Field 3 is `name`, a string. Written as a varint, protobuf.js skips it,
    // so the value would be lost.
    const bytes = concat(syntheticTextPresentation(), new Uint8Array([0x18, 0x01]));
    expect(checkPresentationFidelity(bytes).fidelity).toBe("lossy");
  });
});

describe("files that are only laid out differently", () => {
  it("rates a reordered but complete presentation equivalent", () => {
    const bytes = withTrailing(Presentation, presentation(), ["uuid"], new Uint8Array());
    expect(bytes).not.toEqual(syntheticTextPresentation());
    const report = checkPresentationFidelity(bytes);
    expect(report.fidelity).toBe("equivalent");
    expect(report.exportSafe).toBe(true);
  });

  it("rates a reordered repeated element equivalent", () => {
    const bytes = withTrailing(Presentation, presentation(), ["cues", "uuid"], new Uint8Array());
    expect(checkTypeFidelity(Presentation, bytes).fidelity).toBe("equivalent");
  });

  it("rates a singular submessage written in two parts equivalent", () => {
    // The spec merges the two, and so does protobuf.js: nothing is lost.
    const lastUsed = Presentation.fields.last_date_used!.id;
    const writer = Presentation.encode({ ...presentation(), last_date_used: null });
    writer.uint32((lastUsed << 3) | 2).bytes(Timestamp.encode({ seconds: 5 }).finish());
    writer.uint32((lastUsed << 3) | 2).bytes(Timestamp.encode({ nanos: 7 }).finish());
    expect(checkPresentationFidelity(writer.finish()).fidelity).toBe("equivalent");
  });

  it("rates a repeated scalar written unpacked equivalent", () => {
    // protobuf.js writes `pattern` packed, and reads it either way.
    const Stroke = messageType("rv.data.Graphics.Stroke");
    const pattern = Stroke.fields.pattern!.id;
    const writer = protobuf.Writer.create();
    for (const dash of [1.5, 2.5]) writer.uint32((pattern << 3) | 1).double(dash);
    const bytes = writer.finish();
    expect(Stroke.toObject(Stroke.decode(bytes)).pattern).toEqual([1.5, 2.5]);
    expect(checkTypeFidelity(Stroke, bytes).fidelity).toBe("equivalent");
  });

  it("rates the synthetic files identical", () => {
    expect(checkPresentationFidelity(syntheticTextPresentation()).fidelity).toBe("identical");
    expect(checkFidelity(syntheticMediaFile()).fidelity).toBe("identical");
  });
});
