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

- `0.x` versions may make breaking changes in minor releases. Pin an exact
  version for production automation.
- After `1.0`, follow semantic versioning for the SDK API.
- The SDK talks to an instance over HTTP; the instance may be older or newer than
  the SDK. Use `npm run sdk:check` in the server repository to detect drift, and
  use `client.raw()` when calling a route that is newer than the installed SDK.
- The SDK sends no version-specific headers today. Server-side behavior is
  selected by the API key and the instance build.

## Drift detection

In the CrewRouter repository:

```bash
npm run sdk:generate   # regenerate catalog, OpenAPI, TypeScript metadata, docs table
npm run sdk:check      # fail if committed artifacts are stale
```

The check compares the generated output byte-for-byte and verifies that every
non-excluded Express route appears in the catalog.

## Deprecation

Deprecated operations remain in the catalog for at least one minor release with a
`deprecated` note in the generated reference. Removing an operation requires a
contract version bump and a major SDK release after 1.0.
