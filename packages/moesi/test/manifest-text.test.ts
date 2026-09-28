import { describe, expect, it } from "vitest";
import { MAX_MANIFEST_TEXT_BYTES, parseManifest, parseManifestText } from "../src/index.js";

const address = `0x${"ab".repeat(20)}` as const;
const hash = `0x${"cd".repeat(32)}` as const;
const object = {
  version: "moesi.manifest/v4",
  contracts: [
    {
      kind: "external",
      id: "registry",
      address,
      expectedRuntimeCodeHash: hash,
      checks: [],
      storageChecks: [],
    },
  ],
} as const;
const yaml = `# one exact external deployment\nversion: moesi.manifest/v4
contracts:
  - kind: external
    id: registry
    address: "${address}"
    expectedRuntimeCodeHash: "${hash}"
    checks: []
    storageChecks: []
`;

describe("manifest document boundary", () => {
  it("normalizes JSON and YAML to the same owned immutable manifest", () => {
    const expected = parseManifest(object);
    const fromYaml = parseManifestText(yaml);
    expect(fromYaml).toEqual(expected);
    expect(parseManifestText(JSON.stringify(object))).toEqual(expected);
    expect(parseManifest(fromYaml)).toBe(fromYaml);
    expect(Object.isFrozen(fromYaml.contracts[0])).toBe(true);
    expect(() => parseManifest(JSON.parse(JSON.stringify(fromYaml)))).toThrowError(
      expect.objectContaining({ code: "unknown_field" }),
    );
  });

  it.each([
    "{",
    '{"version":"a","version":"b","contracts":[]}',
    "version: a\nversion: b\ncontracts: []",
    "---\na: 1\n---\nb: 2",
    "a: &shared [1, 2]\nb: *shared",
    "a: &loop [*loop]",
    "a: !custom secret",
    "a: !!str 10",
    "[a, b]: 1",
    "a: .nan",
    "%YAML 1.1\n---\na: yes",
    `a: ${"[".repeat(65)}1${"]".repeat(65)}`,
  ])("rejects ambiguous/non-data syntax without reflecting source", (source) => {
    expect(() => parseManifestText(source)).toThrowError(
      expect.objectContaining({
        code: "invalid_manifest_document",
        message: "manifest must be one unambiguous JSON or YAML 1.2 data document",
      }),
    );
  });

  it("bounds both ASCII length and UTF-8 bytes", () => {
    for (const source of [
      "x".repeat(MAX_MANIFEST_TEXT_BYTES + 1),
      "한".repeat(Math.floor(MAX_MANIFEST_TEXT_BYTES / 3) + 1),
    ]) {
      expect(() => parseManifestText(source)).toThrowError(
        expect.objectContaining({ code: "manifest_source_too_large" }),
      );
    }
  });

  it("rejects forbidden source characters even in comments", () => {
    for (const value of [0, 1, 8, 11, 12, 31, 127, 132, 134, 159, 0xd800, 0xdfff, 0xfffe, 0xffff]) {
      const character = String.fromCharCode(value);
      for (const source of [`${yaml}# ${character}\n`, `${yaml}extra: "${character}"\n`]) {
        expect(() => parseManifestText(source)).toThrowError(
          expect.objectContaining({ code: "invalid_manifest_document" }),
        );
      }
    }
    expect(parseManifestText(`${yaml}# 한글 😀\n`)).toEqual(parseManifest(object));
    expect(parseManifestText(JSON.stringify(object).replace("registry", "\\u0072egistry"))).toEqual(
      parseManifest(object),
    );
  });

  it("keeps document errors separate from current manifest schema errors", () => {
    expect(() => parseManifestText("version: moesi.manifest/v0\ncontracts: []")).toThrowError(
      expect.objectContaining({ code: "unsupported_manifest_version" }),
    );
    expect(() => parseManifestText(yaml.replace(`"${address}"`, address))).toThrowError(
      expect.objectContaining({ code: "invalid_resource" }),
    );
    expect(() => parseManifestText("")).toThrowError(
      expect.objectContaining({ code: "invalid_manifest_document" }),
    );
    expect(() => parseManifestText(42 as never)).toThrowError(
      expect.objectContaining({ code: "invalid_manifest_document" }),
    );
  });
});
