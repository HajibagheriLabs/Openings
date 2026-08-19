/**
 * Stub for the `server-only` package.
 *
 * The real module throws on import to stop server code being pulled into a
 * client bundle. That guard belongs to the Next build; under Vitest we import
 * the same modules directly in Node, so it resolves here instead. Aliased in
 * vitest.config.ts.
 */
export {};
