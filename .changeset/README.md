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

On push to `main`, the `Release` GitHub Actions workflow runs:

- **If changesets are present**, it opens (or updates) a `chore(release): version packages`
  PR that bumps versions, rewrites internal dependency ranges, and updates each
  package's `CHANGELOG.md`. Merging that PR triggers the next run.
- **If no changesets are present** but versions in `package.json` are ahead of
  what is on npm, it builds and runs `changeset publish` to publish them.

See the root `README.md` / `RELEASING` notes for the one-time `NPM_TOKEN`
secret setup.
