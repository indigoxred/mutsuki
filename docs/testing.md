# Testing

Automated tests use synthetic fixtures and mocked transports. They do not require a live Kavita server, MAL account, or physical Paperback device.

Run:

```bash
pnpm install
pnpm run test
pnpm run verify
```

`pnpm run test` compiles source and tests to `dist-tests` and executes Node's built-in test runner.

`pnpm run verify` runs formatting checks, TypeScript typechecking, lint checks, Paperback bundling, and tests.
