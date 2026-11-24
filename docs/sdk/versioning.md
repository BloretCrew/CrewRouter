# Versioning

## Package versions

| Package | Current | Tag scheme |
| --- | --- | --- |
| `@bloret-crew/crewrouter-sdk` (npm) | 27.0.0-beta.1 | `sdk/typescript/vX.Y.Z` |
| `crewrouter-sdk` (PyPI) | 27.0.0b1 (repository metadata; registry publication status must be verified per release) | `sdk/python/vX.Y.Z` |
| Go module | 27.0.0-beta.1 (repository metadata; tag/publication status must be verified per release) | `sdk/go/vX.Y.Z` |
| `crewrouter/embedded` | preview | root `vX.Y.Z` |

Go requires the module tag to be prefixed with the module subdirectory. For
example, `go get github.com/BloretCrew/CrewRouter/sdk/go@v27.0.0-beta.1` resolves
the `sdk/go/v27.0.0-beta.1` tag. Confirm that the release tag exists before
recommending an installation version.

## Contract version

`sdk/contract/operations.json` carries an integer `contractVersion`. It changes
when the generated operation surface changes incompatibly:

- Removing or renaming an `operationId`
- Removing an endpoint
- Changing a path template in a way that breaks existing path parameter calls

Additive endpoints and additive optional response fields do not bump the
contract version. The Node SDK exports `CONTRACT_VERSION`.

## Compatibility policy

- The packages are currently pre-release: npm `27.0.0-beta.1`, Python
  `27.0.0b1`, and Go `27.0.0-beta.1`. Treat their convenience APIs and operation
  catalogs as beta contracts; pin exact versions in production and expect that a
  later beta may require migration.
- A stable `1.0` release requires a published support matrix and compatibility
  tests across supported server/SDK combinations. From `1.0`, SDK public APIs
  follow semantic versioning: breaking changes require a major release; additive
  operations and optional fields may ship in a minor release.
- The SDK talks to an instance over HTTP; the instance may be older or newer than
  the SDK. Use `npm run sdk:check` in the server repository to detect stale
  generated artifacts. Calling a route newer than the installed SDK is possible
  through `request`/`raw` but is not covered by that SDK's compatibility promise.
- The SDK sends no version-specific headers today. Server-side behavior is
  selected by the API key and instance build; the SDK cannot automatically
  negotiate an unsupported server contract.

## Drift detection

In the CrewRouter repository:

```bash
npm run sdk:generate   # regenerate catalog, OpenAPI, TypeScript metadata, docs table
npm run sdk:check      # fail if committed artifacts are stale
```

The check compares the generated output byte-for-byte and verifies that every
non-excluded Express route appears in the catalog.

## Deprecation

- Mark a deprecated operation in the source contract and generated reference with
  a replacement operation ID and removal target. Keep it callable for at least
  one stable minor release; security or legal removals are documented as
  exceptions with an immediate migration notice.
- After `1.0`, removal/rename, method or path incompatibility, required request
  field additions, permission/auth changes that invalidate existing callers, and
  response shape changes that break documented typed APIs require both a
  `contractVersion` bump and an SDK major release.
- `sdk:check` verifies generated output freshness. Contract-version bump policy
  and compatibility impact must also be reviewed in the PR/release checklist;
  generated route catalogs cannot infer every semantic breaking change.
