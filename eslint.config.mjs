// @ts-check
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // ── Global ignores ────────────────────────────────────────────────────────
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/generated/**",
      "**/.replit-artifact/**",
      ".local/**",
      ".agents/**",
      "pnpm-lock.yaml",
      "eslint.config.mjs",
    ],
  },

  // ── TypeScript — all packages ─────────────────────────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node, ...globals.es2022 },
    },
    rules: {
      // Unused vars: allow underscore-prefixed names
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Explicit any is common in Express middleware — warn, don't error
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      // Allow console.warn/error in server code (no console.log)
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // Prefer const
      "prefer-const": "error",
    },
  },

  // ── React — rfq-portal only ───────────────────────────────────────────────
  {
    files: ["artifacts/rfq-portal/**/*.tsx", "artifacts/rfq-portal/**/*.ts"],
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // react-hooks v7 React-Compiler compatibility rules —
      // set to warn (not error) until the codebase opts in to React Compiler
      "react-hooks/react-compiler": "off",
      // react-hooks v7 React-Compiler compatibility rules — warn until opt-in
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/refs": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },

  // ── Test files — relax some rules ─────────────────────────────────────────
  {
    files: ["**/__tests__/**/*.ts", "**/__tests__/**/*.tsx", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },

  // ── Prettier must be LAST ─────────────────────────────────────────────────
  prettier,
);
