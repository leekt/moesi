import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/viem/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  platform: "neutral",
});
