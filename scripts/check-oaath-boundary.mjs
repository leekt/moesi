import { fileURLToPath } from "node:url";
import { checkOaathBoundary } from "./boundary-policy.mjs";

try {
  await checkOaathBoundary(fileURLToPath(new URL("../", import.meta.url)));
  process.stdout.write("OAAth package boundary verified\n");
} catch (error) {
  process.stderr.write(
    `${/^boundary_[a-z_]+$/.test(error?.message) ? error.message : "boundary_check_failed"}\n`,
  );
  process.exitCode = 1;
}
