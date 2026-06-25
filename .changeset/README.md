# Changesets

This folder is managed by [changesets](https://github.com/changesets/changesets).
Releases of the `@nest-batch/*` packages are driven by changeset files here.

## Adding a changeset

When you make a change that should be released, run:

```bash
pnpm changeset
```

Pick the affected packages, choose the bump type (patch / minor / major) per
[semver](https://semver.org), and write a short summary. This creates a
markdown file in this folder — commit it alongside your change.

## How releases happen

On push to `main`, the `Release` GitHub Actions workflow creates or updates the
Changesets version PR:

- **If changesets are present**, it opens or updates a `chore(release): version packages`
  PR that bumps versions, rewrites internal dependency ranges, and updates package
  changelogs.
- **npm publishing is currently manual.** GitHub OIDC / npm trusted publishing is
  not configured yet, so the workflow intentionally does not run
  `changeset publish`.

After the version PR is merged, publish from a machine that is logged in to npm
with access to the `@nest-batch` scope:

```bash
pnpm install --frozen-lockfile
pnpm --dir packages/prisma exec prisma generate --schema tests/fixtures/postgresql/schema.prisma
pnpm build
pnpm changeset publish
```

Push the tags created by Changesets if the manual publish step creates local git
tags.
