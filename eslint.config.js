import tseslint from "typescript-eslint";

const nodeOnly = {
  patterns: [{ group: ["node:*", "fs", "path", "os", "child_process", "url", "zlib", "util"], message: "Isomorphic code: no Node APIs (PRODUCT.md §7). Only src/cli and adapter discover* may use them." }],
};

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "fixtures/**/*.jsonl"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/core/**", "src/detectors/**", "src/report/**", "src/redact/**", "src/analyze.ts", "src/adapters/*/parse*.ts"],
    rules: {
      "no-restricted-imports": ["error", nodeOnly],
      "no-restricted-globals": ["error", "process", "Buffer", "__dirname", "require"],
    },
  },
  { rules: { "@typescript-eslint/no-explicit-any": "off" } },
);
