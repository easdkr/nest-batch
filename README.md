# nest-batch-monorepo

A NestJS batch processing monorepo containing a reusable library and a demo consumer app.

## Workspace layout

```
nest-batch-monorepo/
├── packages/
│   └── nest-batch/        # Reusable NestJS batch-processing library
└── apps/
    └── demo/              # Demo Nest application that consumes the library
```

Both packages extend the root `tsconfig.base.json`, share the root `.swcrc` for compilation, and use the root `vitest.config.ts` for testing.

## Tooling

- **Package manager:** pnpm@10 (workspaces)
- **Language:** TypeScript 5.7 (strict, NodeNext modules, ES2022 target)
- **Decorator support:** `experimentalDecorators` + `emitDecoratorMetadata` (NestJS-compatible)
- **Compiler:** SWC (`.swcrc` at root) for fast TS → CJS transpilation
- **Tests:** Vitest with v8 coverage (80% threshold)
- **Lint:** ESLint with `@typescript-eslint` + `eslint-plugin-import` for order
- **Format:** Prettier (single quote, trailing comma `all`, 100 cols)

## Common scripts

| Script            | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `pnpm build`      | Build every workspace package (`-r`)                     |
| `pnpm test`       | Run tests across all workspace packages                  |
| `pnpm lint`       | Lint all workspace packages                              |
| `pnpm typecheck`  | `tsc --noEmit` per package via `pnpm -r exec`            |
| `pnpm format`     | Prettier write across the repo                           |
| `pnpm format:check` | Prettier check (CI-friendly)                           |

## Node version

Requires Node `>=20` (Node 24 supported). Volta pins both `node` and `pnpm` versions in this repo.

## Status

Wave 1 — foundation scaffolding. Library and demo app code lands in subsequent tasks.
