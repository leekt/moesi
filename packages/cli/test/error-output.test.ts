import { MoesiManifestError } from "moesi";
import { describe, expect, it, vi } from "vitest";
import { renderErrorHuman } from "../src/error-output.js";
import { CliError } from "../src/errors.js";

describe("safe actionable errors", () => {
  it("identifies the manifest field while excluding arbitrary unknown keys and raw diagnostics", () => {
    const error = new MoesiManifestError(
      "unknown_field",
      "manifest.contracts[2].secret-token",
      "raw credential-bearing body",
    );
    const output = renderErrorHuman("unknown_field", error);
    expect(output).toContain("unsupported field");
    expect(output).toContain("Location: manifest.contracts[2]\n");
    expect(output).not.toContain("secret-token");
    expect(output).not.toContain("raw credential-bearing body");
  });

  it("gives a specific recovery for missing option values without echoing input", () => {
    expect(
      renderErrorHuman(
        "invalid_arguments",
        new CliError("invalid_arguments", "manifest path is invalid"),
      ),
    ).toContain("Provide a value after --manifest");
    const output = renderErrorHuman(
      "invalid_arguments",
      new CliError("invalid_arguments", "secret arbitrary message"),
    );
    expect(output).toContain("moesi <command> --help");
    expect(output).not.toContain("secret");
  });

  it("never invokes error message or path accessors", () => {
    const read = vi.fn(() => {
      throw new Error("secret");
    });
    const argumentError = new CliError("invalid_arguments", "unknown argument");
    Object.defineProperty(argumentError, "message", { get: read });
    expect(renderErrorHuman("invalid_arguments", argumentError)).toContain("--help");
    const manifestError = new MoesiManifestError(
      "invalid_resource",
      "manifest.contracts",
      "secret",
    );
    Object.defineProperty(manifestError, "path", { get: read });
    expect(renderErrorHuman("invalid_resource", manifestError)).not.toContain("secret");
    expect(read).not.toHaveBeenCalled();
  });
});
