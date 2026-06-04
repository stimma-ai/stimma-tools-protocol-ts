import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es", "cjs"],
      fileName: (format) => `index.${format === "es" ? "js" : "cjs"}`,
    },
    rollupOptions: {
      external: [
        "ws",
        /^node:/,
      ],
    },
    target: "node18",
    minify: false,
  },
  plugins: [
    dts({ rollupTypes: true }),
  ],
});
