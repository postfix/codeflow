import tseslint from "typescript-eslint";

export default tseslint.config({
  ignores: ["dist/**", "node_modules/**"],
}, {
  files: ["**/*.ts"],
  linterOptions: { noInlineConfig: true },
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
  },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
    "@typescript-eslint/no-misused-promises": "error",
  },
});
