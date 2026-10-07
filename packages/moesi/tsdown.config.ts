import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cetane/index.ts", "src/fleet/index.ts", "src/node/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "neutral",
  deps: { neverBundle: [/^node:/] },
});
