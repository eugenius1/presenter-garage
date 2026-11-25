import { type Fidelity } from "@presenter-garage/core/lib/decode";

/**
 * Whether writing a file back would keep everything in it.
 *
 * A document of a ProPresenter 22 workspace is always `lossy`, whatever the
 * gate says of the bytes: they are a conversion of the document, made here,
 * so of course they round-trip. What the answer is for is whether the thing
 * can be written back as a file, and that one cannot. Its slide text is
 * written another way, into the document itself, and `plan_slide_edits`
 * makes its own check of the document for that. `converted` is the read's
 * own word for it, on the `FoundFile` the bytes came in.
 */
export const fidelityOf = (converted: true | undefined, measured: Fidelity): Fidelity => (converted ? "lossy" : measured);
