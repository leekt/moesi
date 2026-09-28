import { isAlias, isNode, isPair, isScalar, parseAllDocuments, visit } from "yaml";
import { MoesiManifestError } from "../errors.js";
import { type ParsedManifest, parseManifest } from "./parse.js";

export const MAX_MANIFEST_TEXT_BYTES = 1_048_576;

// YAML 1.2 c-printable. The Unicode flag preserves valid surrogate pairs.
const FORBIDDEN_SOURCE_CHARACTER =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject YAML's forbidden raw control characters.
  /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x84\x86-\x9f\ud800-\udfff\ufffe\uffff]/u;

/** JSON and YAML 1.2 share one bounded, data-only input boundary. */
export function parseManifestText(source: string): ParsedManifest {
  if (typeof source !== "string") return invalid();
  if (
    source.length > MAX_MANIFEST_TEXT_BYTES ||
    new TextEncoder().encode(source).length > MAX_MANIFEST_TEXT_BYTES
  ) {
    throw new MoesiManifestError(
      "manifest_source_too_large",
      "manifest",
      "manifest source exceeds the byte limit",
    );
  }
  // The YAML parser does not reject every forbidden character inside comments.
  if (FORBIDDEN_SOURCE_CHARACTER.test(source)) return invalid();
  let value: unknown;
  try {
    const documents = parseAllDocuments(source, {
      version: "1.2",
      schema: "core",
      uniqueKeys: true,
      strict: true,
      prettyErrors: false,
      logLevel: "silent",
      customTags: [],
      merge: false,
    });
    if (documents.length !== 1) return invalid();
    const document = documents[0];
    if (!document) return invalid();
    if (
      document.errors.length > 0 ||
      document.warnings.length > 0 ||
      document.directives?.yaml.version !== "1.2"
    )
      return invalid();
    let nodes = 0;
    visit(document, (_key, node, path) => {
      nodes += 1;
      if (nodes > 65_536 || path.length > 64 || isAlias(node)) return invalid();
      if (isNode(node) && (node.anchor !== undefined || node.tag !== undefined)) return invalid();
      if (isPair(node) && (!isScalar(node.key) || typeof node.key.value !== "string"))
        return invalid();
      if (isScalar(node) && typeof node.value === "number" && !Number.isFinite(node.value))
        return invalid();
    });
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return invalid();
  }
  return parseManifest(value as never);
}

function invalid(): never {
  throw new MoesiManifestError(
    "invalid_manifest_document",
    "manifest",
    "manifest must be one unambiguous JSON or YAML 1.2 data document",
  );
}
