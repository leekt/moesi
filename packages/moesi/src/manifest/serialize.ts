import { stringify } from "yaml";
import { MoesiManifestError } from "../errors.js";
import { type ParsedManifest, parseManifest } from "./parse.js";
import { MAX_MANIFEST_TEXT_BYTES } from "./text.js";
import type { MoesiManifest } from "./types.js";

export type ManifestTextFormat = "json" | "yaml";

export interface SerializeManifestOptions {
  readonly format: ManifestTextFormat;
}

/**
 * Validate a manifest once and write its canonical current-version text.
 * The output is the resolved form: resource references become exact bytes,
 * contracts are sorted by ID, and identical manifests yield identical text,
 * so `parseManifestText(serializeManifest(x))` reproduces `x`'s manifestHash.
 */
export function serializeManifest(
  manifest: MoesiManifest | ParsedManifest,
  options: SerializeManifestOptions,
): string {
  const format = parseFormat(options);
  const parsed = parseManifest(manifest);
  // Only the current source fields: manifestHash is derived, never authored.
  const source = { version: parsed.version, contracts: parsed.contracts };
  const text =
    format === "json"
      ? `${JSON.stringify(source, null, 2)}\n`
      : stringify(source, {
          version: "1.2",
          schema: "core",
          aliasDuplicateObjects: false,
          lineWidth: 0,
          minContentWidth: 0,
          directives: true,
        });
  if (new TextEncoder().encode(text).length > MAX_MANIFEST_TEXT_BYTES) {
    throw new MoesiManifestError(
      "manifest_source_too_large",
      "manifest",
      "serialized manifest exceeds the byte limit",
    );
  }
  return text;
}

function parseFormat(options: unknown): ManifestTextFormat {
  let format: unknown;
  try {
    if (typeof options !== "object" || options === null || Array.isArray(options)) throw null;
    const prototype = Object.getPrototypeOf(options);
    if (prototype !== null && prototype !== Object.prototype) throw null;
    if (Object.keys(options).some((key) => key !== "format")) throw null;
    format = Reflect.get(options, "format");
  } catch {
    format = undefined;
  }
  if (format !== "json" && format !== "yaml") {
    throw new MoesiManifestError(
      "invalid_manifest",
      "options.format",
      'serialization format must be "json" or "yaml"',
    );
  }
  return format;
}
