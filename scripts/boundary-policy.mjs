import { createHash } from "node:crypto";
import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { parse } from "@babel/parser";
import { validRange } from "semver";
import { parseAllDocuments } from "yaml";

const IGNORED = new Set([".git", "node_modules", "dist", "coverage", ".artifacts"]);
const SOURCE = /\.(?:[cm]?[jt]sx?|sol)$/;
const PACKAGES = new Map([
  ["packages/moesi", "moesi"],
  ["packages/oaath-adapter", "@moesi/oaath"],
  ["packages/cli", "@moesi/cli"],
]);
// Public SDK types/operations are fine; protocol construction is owned upstream.
const AA_SYMBOL =
  /(?:kernel|useroperation|userop(?:hash|nonce|signature)|entrypoint|paymaster|bundlerclient|sessionkey|permissionvalidator|signauthorization)/i;
const AA_RPC =
  /^(?:eth_(?:send|estimate|get).*UserOperation|pm_|pimlico_|handleOps$|handleAggregatedOps$)/;
const AA_PACKAGE =
  /^(?:@(?:zerodev|account-abstraction|pimlico|alchemy\/aa)[/]|permissionless(?:\/|$)|viem\/account-abstraction(?:\/|$))/;
const SDK_REVIEW_FIELDS = new Set(["kernelVersion", "paymasterService"]);

function isSdkReviewField(node, parent, path) {
  return (
    (/^packages\/oaath-adapter\/(?:src\/boundary\.ts$|test\/)/.test(path) ||
      (node.name === "kernelVersion" && /^scripts\/fixtures\//.test(path))) &&
    SDK_REVIEW_FIELDS.has(node.name) &&
    ((["MemberExpression", "OptionalMemberExpression"].includes(parent?.type) &&
      !parent.computed &&
      parent.property === node) ||
      (parent?.type === "ObjectProperty" &&
        !parent.computed &&
        !parent.shorthand &&
        parent.key === node))
  );
}
const GATE_FILES = new Set([
  "scripts/boundary-policy.mjs",
  "scripts/check-oaath-boundary.mjs",
  "scripts/check-no-aa-implementation.mjs",
  "scripts/boundary-policy.test.mjs",
]);

function fail(code) {
  throw new Error(code);
}
function owner(path) {
  return [...PACKAGES.keys()].find((prefix) => path.startsWith(`${prefix}/`));
}
function isOutside(path) {
  return path === ".." || path.startsWith(`..${sep}`);
}
function packageName(specifier) {
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}

async function checkTarball(root, directory, name, version) {
  if (!/^@oaath\/(?:sdk|protocol|server|testing)$/.test(name) || !version.startsWith("file:"))
    fail("boundary_tarball_path_forbidden");
  const target = await realpath(resolve(root, directory, version.slice(5)));
  const nameInVendor = relative(resolve(root, "vendor/oaath"), target);
  if (
    isOutside(nameInVendor) ||
    !/^oaath-[a-z]+-0\.\d+\.\d+\.tgz$/.test(nameInVendor) ||
    !nameInVendor.startsWith(`${name.replace("@oaath/", "oaath-")}-`)
  )
    fail("boundary_tarball_path_forbidden");
  const provenance = JSON.parse(
    await readFile(resolve(root, "vendor/oaath/provenance.json"), "utf8"),
  );
  if (
    createHash("sha256")
      .update(await readFile(target))
      .digest("hex") !== provenance.sha256?.[nameInVendor]
  )
    fail("boundary_tarball_checksum_mismatch");
}

async function checkWorkspace(root) {
  let workspace;
  try {
    const source = await readFile(resolve(root, "package.json"), "utf8");
    workspace = JSON.parse(source);
    // JSON is a YAML subset; retain duplicate-key rejection for configuration.
    const documents = parseAllDocuments(source, { uniqueKeys: true, logLevel: "silent" });
    if (documents.length !== 1 || documents[0].errors.length || documents[0].warnings.length)
      fail("boundary_workspace_layout_invalid");
  } catch {
    fail("boundary_workspace_layout_invalid");
  }
  if (
    !workspace ||
    typeof workspace !== "object" ||
    Array.isArray(workspace) ||
    workspace.resolutions !== undefined ||
    JSON.stringify(workspace.workspaces) !== JSON.stringify(["packages/*"])
  )
    fail("boundary_workspace_layout_invalid");
  if (
    workspace.overrides !== undefined &&
    (!workspace.overrides ||
      typeof workspace.overrides !== "object" ||
      Array.isArray(workspace.overrides))
  )
    fail("boundary_workspace_layout_invalid");
  for (const [name, version] of Object.entries(workspace.overrides ?? {})) {
    if (typeof version !== "string") fail("boundary_workspace_layout_invalid");
    await checkTarball(root, ".", name, version);
  }
  return workspace;
}

export async function inventory(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) fail("boundary_symlink_forbidden");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk("");
  return files.sort();
}

export function sourceFacts(source, path) {
  let ast;
  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      plugins: ["typescript", "jsx"],
      createImportExpressions: true,
    });
  } catch {
    return fail("boundary_source_parse_failed");
  }
  const imports = [];
  const symbols = [];
  const strings = [];
  function add(node, dynamic = false) {
    imports.push({ specifier: node?.type === "StringLiteral" ? node.value : null, dynamic, node });
  }
  function walk(node, parent) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent);
      return;
    }
    if (node.type === "Identifier" && !isSdkReviewField(node, parent, path))
      symbols.push(node.name);
    if (node.type === "StringLiteral") strings.push(node.value);
    if (node.type === "TemplateElement") strings.push(node.value.cooked ?? node.value.raw);
    if (
      ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type) &&
      node.source
    )
      add(node.source);
    if (node.type === "ImportExpression") add(node.source, true);
    if (node.type === "TSImportType") add(node.argument);
    if (node.type === "TSExternalModuleReference") add(node.expression);
    if (
      ["CallExpression", "OptionalCallExpression"].includes(node.type) &&
      ((node.callee?.type === "Identifier" && node.callee.name === "require") ||
        (["MemberExpression", "OptionalMemberExpression"].includes(node.callee?.type) &&
          node.callee.object?.type === "Identifier" &&
          node.callee.object.name === "module" &&
          (node.callee.computed
            ? node.callee.property?.value === "require"
            : node.callee.property?.name === "require")))
    )
      add(node.arguments[0]);
    for (const [key, value] of Object.entries(node)) {
      if (
        ![
          "loc",
          "start",
          "end",
          "extra",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
        ].includes(key)
      )
        walk(value, node);
    }
  }
  walk(ast.program);
  return { imports, symbols, strings, path };
}

// This is the one intentional caller-supplied application module boundary.
function isClientModule(node) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property?.name === "href" &&
    node.object?.type === "CallExpression" &&
    node.object.callee?.name === "pathToFileURL" &&
    node.object.arguments.length === 1 &&
    node.object.arguments[0]?.type === "CallExpression" &&
    node.object.arguments[0].callee?.name === "resolve" &&
    node.object.arguments[0].arguments.length === 1 &&
    node.object.arguments[0].arguments[0]?.name === "clientModule"
  );
}

export async function checkOaathBoundary(root) {
  root = await realpath(root);
  const files = await inventory(root);
  if (files.includes(".gitmodules")) fail("boundary_submodule_forbidden");
  const workspace = await checkWorkspace(root);
  const manifests = new Map();
  for (const path of files.filter((item) => item.endsWith("package.json"))) {
    if (path !== "package.json" && !PACKAGES.has(dirname(path)))
      fail("boundary_package_layout_invalid");
    const manifest =
      path === "package.json" ? workspace : JSON.parse(await readFile(resolve(root, path), "utf8"));
    if (
      path !== "package.json" &&
      ["workspaces", "overrides", "resolutions"].some((field) => manifest[field] !== undefined)
    )
      fail("boundary_workspace_layout_invalid");
    if (path !== "package.json" && manifest.name !== PACKAGES.get(dirname(path)))
      fail("boundary_package_identity_invalid");
    manifests.set(dirname(path), manifest);
    for (const field of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (
          typeof version !== "string" ||
          (!version.startsWith("file:") &&
            version !== "workspace:*" &&
            (!version.trim() || validRange(version) === null))
        )
          fail("boundary_dependency_source_forbidden");
        if (AA_PACKAGE.test(name)) fail("boundary_aa_dependency_forbidden");
        if (
          name.startsWith("@oaath/") &&
          !(dirname(path) === "packages/oaath-adapter" && name === "@oaath/sdk")
        )
          fail("boundary_oaath_dependency_forbidden");
        if (dirname(path) === "packages/moesi" && name.startsWith("@moesi/"))
          fail("boundary_core_dependency_forbidden");
        if (version.startsWith("workspace:") && ![...PACKAGES.values()].includes(name))
          fail("boundary_workspace_dependency_forbidden");
        if (version.startsWith("file:")) await checkTarball(root, dirname(path), name, version);
      }
    }
  }
  if ([...PACKAGES.keys()].some((path) => !manifests.has(path)))
    fail("boundary_public_package_missing");
  const cli = manifests.get("packages/cli");
  if (
    !cli.peerDependencies?.["@moesi/oaath"] ||
    cli.peerDependenciesMeta?.["@moesi/oaath"]?.optional !== true ||
    cli.dependencies?.["@moesi/oaath"]
  )
    fail("boundary_cli_adapter_not_optional");
  const adapter = manifests.get("packages/oaath-adapter");
  if (!adapter.peerDependencies?.moesi || !adapter.peerDependencies?.["@oaath/sdk"])
    fail("boundary_adapter_peers_missing");
  for (const path of files.filter((item) => SOURCE.test(item) && !item.endsWith(".sol"))) {
    const facts = sourceFacts(await readFile(resolve(root, path), "utf8"), path);
    const packageRoot = owner(path);
    const production = packageRoot && path.startsWith(`${packageRoot}/src/`);
    if (
      production &&
      facts.symbols.some((name) => ["eval", "Function", "createRequire"].includes(name))
    )
      fail("boundary_dynamic_loader_forbidden");
    for (const { specifier, dynamic, node } of facts.imports) {
      if (specifier === null) {
        if (
          production &&
          !(path === "packages/cli/src/oaath-runtime.ts" && dynamic && isClientModule(node))
        )
          fail("boundary_computed_import_forbidden");
        continue;
      }
      if (AA_PACKAGE.test(specifier)) fail("boundary_aa_import_forbidden");
      if (
        specifier.startsWith("moesi/") &&
        !["moesi/viem", "moesi/fleet", "moesi/node"].includes(specifier)
      )
        fail("boundary_moesi_internal_import");
      if (packageRoot === "packages/oaath-adapter" && specifier === "moesi/viem")
        fail("boundary_adapter_direct_provider_import");
      if (specifier.startsWith("@oaath/")) {
        const allowed =
          packageRoot === "packages/oaath-adapter"
            ? specifier === "@oaath/sdk"
            : !packageRoot &&
              /^(?:scripts\/fixtures|examples)\//.test(path) &&
              ["@oaath/sdk", "@oaath/testing/anvil"].includes(specifier);
        if (!allowed) fail("boundary_oaath_import_forbidden");
      }
      if (packageRoot === "packages/moesi" && specifier.startsWith("@moesi/"))
        fail("boundary_core_import_forbidden");
      if (
        packageRoot === "packages/cli" &&
        specifier.startsWith("@moesi/oaath") &&
        !(path === "packages/cli/src/oaath-runtime.ts" && specifier === "@moesi/oaath" && dynamic)
      )
        fail("boundary_cli_adapter_import_forbidden");
      if (specifier.startsWith(".")) {
        if (/(?:^|\/)(?:node_modules|vendor|\.git)(?:\/|$)/.test(specifier))
          fail("boundary_private_path_import_forbidden");
        const target = relative(root, resolve(root, dirname(path), specifier));
        if (target.split(sep).some((part) => IGNORED.has(part)))
          fail("boundary_ignored_source_import_forbidden");
        if (isOutside(target) || (packageRoot && owner(target) !== packageRoot))
          fail("boundary_source_escape_forbidden");
        if (!packageRoot && /^(?:packages|vendor)\//.test(target))
          fail("boundary_consumer_source_import_forbidden");
      } else if (!specifier.startsWith("node:")) {
        if (/^(?:\/|[A-Za-z]:|file:|https?:)/.test(specifier))
          fail("boundary_absolute_import_forbidden");
        const declared = manifests.get(packageRoot ?? ".");
        const name = packageName(specifier);
        const consumer = !packageRoot && /^(?:scripts\/fixtures|examples)\//.test(path);
        if (
          !consumer &&
          !["dependencies", "devDependencies", "peerDependencies"].some(
            (field) => declared?.[field]?.[name],
          )
        )
          fail("boundary_undeclared_import");
      }
    }
  }
}

export async function checkNoAaImplementation(root) {
  for (const path of await inventory(root)) {
    if (!SOURCE.test(path) || GATE_FILES.has(path)) continue;
    const source = await readFile(resolve(root, path), "utf8");
    if (path.endsWith(".sol")) {
      if (AA_SYMBOL.test(source)) fail("boundary_aa_contract_forbidden");
      continue;
    }
    const { symbols, strings } = sourceFacts(source, path);
    if (
      symbols.some((symbol) => AA_SYMBOL.test(symbol)) ||
      strings.some(
        (value) =>
          AA_RPC.test(value) ||
          (/\b(?:class|function|import|const|let|var)\b|=>/.test(value) && AA_SYMBOL.test(value)),
      )
    )
      fail("boundary_aa_implementation_forbidden");
  }
}
