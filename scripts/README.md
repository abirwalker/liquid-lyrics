# Building, testing and releasing

`npm run build` creates the extension. Its postbuild hook runs prepare-marketplace.mjs, which generates manifest.json and Extension/Build/v<version>/liquid-lyrics.js from package.json.

## Checks and tests

Pull requests to master must pass the `Checks` and `Renderer (Chrome)` jobs. Run the same checks locally before pushing:

| Command | Checks |
| --- | --- |
| `npx tsc --noEmit` and `npx tsc -p tests/tsconfig.json --noEmit` | Source and test types |
| `npm run check` | Source audit: AST, CSS and script rules (ci-audit.mjs) |
| `npm run test:lyrics` | Lyrics provider adapters in headless Chrome |
| `npm run test:renderer` | Lyrics view, full screen and controls in headless Chrome |

The browser suites use an installed Chrome, Chromium or Edge; set `LYRICS_TEST_BROWSER` to its path if none is found. Output and screenshots go to `logs/adapter-tests/` and `logs/renderer-tests/`. On CI, a failing run lists every failed check in the job annotation and uploads these folders as an artifact.

## Choose a version

Run one of these when preparing a release, not for every commit:

| From 1.0.0 | Command | Result |
| --- | --- | --- |
| Bug fix | `npm version patch --no-git-tag-version` | 1.0.1 |
| New compatible feature | `npm version minor --no-git-tag-version` | 1.1.0 |
| Breaking change | `npm version major --no-git-tag-version` | 2.0.0 |

These commands update package.json and package-lock.json, then invoke the build to regenerate the manifest and versioned extension. Do not edit generated version strings by hand.

README-only changes need no bump or tag. Commit and merge them normally. Several code changes can also accumulate before one release.

## Example: release 1.1.0

1. Finish and verify the changes on a branch.
2. From 1.0.0, run `npm version minor --no-git-tag-version`.
3. Add the newest entry to [Extension/CHANGELOG.md](../Extension/CHANGELOG.md), using the actual release date:

   ```md
   ## [1.1.0] - YYYY-MM-DD

   - Describe the feature included in this release.
   ```

4. Commit the changes, package metadata, changelog, manifest and generated versioned build. Push and merge after CI passes.
5. Update master, check that the intended release is merged and the checkout is clean, then tag and push:

   ```sh
   git switch master
   git pull --ff-only
   git tag v1.1.0
   git push origin v1.1.0
   ```

Use the tag for the version you are releasing. The initial 1.0.0 release is already versioned; it needs v1.0.0, not another bump.

## What Actions does

Ordinary pushes run CI without publishing. A stable vX.Y.Z tag push starts the release workflow. It requires the tagged commit on master, matching package/lock/manifest versions, and the newest nonempty changelog entry. It then type-checks, runs the source audit, builds, confirms the committed build matches a fresh build of the tagged source, runs the lyrics and renderer browser tests, and publishes the extension with those notes and liquid-lyrics.js attached. No AI writes the notes or chooses the version.

prepare-release.mjs validates this metadata during regular CI too. Tagging v1.1.0 while package.json still says 1.0.0 stops before publication. Changing src/ after building the release commit also stops it: rebuild and commit the build before tagging. CI cannot infer that you intended a new release; you choose when to bump and tag.

Check the Actions run and release asset after publishing. Do not reuse an existing published tag for new changes.
