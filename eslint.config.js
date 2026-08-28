import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "coverage",
      "playwright-report",
      "test-results",
      "supabase/.temp",
      // ⭐ The design session's scratch area. It is gitignored, but eslint does
      // not read .gitignore, so a throwaway probe file could — and did, on 28
      // Aug — fail `npm run lint` on a repo whose source was clean. Scratch
      // that can break the build is not scratch.
      "_delivery",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettier],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // A leading underscore means "destructured to discard it" -- the usual
      // way to pull one field out of an object and ignore the rest. Without
      // this, the convention is a lint error rather than a signal.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
);
