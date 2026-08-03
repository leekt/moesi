import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  platform: "node",
  fixedExtension: false,
  banner: "#!/usr/bin/env node",
});
