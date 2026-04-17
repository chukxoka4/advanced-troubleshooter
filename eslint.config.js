import tseslint from "typescript-eslint";

/**
 * Flat-config ESLint for the monorepo. Intentionally narrow: defer the
 * heavy lifting to TypeScript's strict compiler and keep lint rules for
 * patterns the compiler doesn't catch (unused locals, no-explicit-any
 * escape hatches, dead imports).
 *
 * Scope is packages/**\/*.ts; build output and node_modules are ignored.
 */

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },
  {
    files: ["packages/**/*.test.ts", "packages/**/*.integration.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
