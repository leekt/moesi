import { fileURLToPath } from "node:url";
import { checkNoAaImplementation } from "./boundary-policy.mjs";

try {
  await checkNoAaImplementation(fileURLToPath(new URL("../", import.meta.url)));
  process.stdout.write("No account-abstraction implementation indicators found\n");
} catch (error) {
  process.stderr.write(
    `${/^boundary_[a-z_]+$/.test(error?.message) ? error.message : "boundary_check_failed"}\n`,
  );
  process.exitCode = 1;
}
