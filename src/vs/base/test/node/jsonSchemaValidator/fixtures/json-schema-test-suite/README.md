# JSON-Schema-Test-Suite fixtures

Copied from the official [json-schema-org/JSON-Schema-Test-Suite](https://github.com/json-schema-org/JSON-Schema-Test-Suite)
at commit `5b0ee1613e45fcc2bddac00e07c19cd49b00d8a8`, licensed under the MIT License (see `LICENSE`).
The files are unmodified.

Copied files, below the root of the upstream repository:

- `LICENSE`
- `tests/draft2020-12/*.json`: every file of the required draft 2020-12 tests.
- `tests/draft2020-12/optional/`: only `anchor.json`, `dynamicRef.json`, `ecmascript-regex.json`, `id.json`,
  `no-schema.json`, `non-bmp-regex.json`, `refOfUnknownKeyword.json` and `unknownKeyword.json`.
- `tests/draft7/*.json`: every file of the required draft-07 tests (the `optional` folder is not copied).
- `remotes/draft2020-12/`: the draft 2020-12 remote documents, without the `metaschema-*.json` and
  `format-assertion-*.json` documents that need custom metaschemas.
- `remotes/draft7/`: every draft-07 remote document.
- `remotes/integer.json`, `remotes/baseUriChange/`, `remotes/baseUriChangeFolder/`,
  `remotes/baseUriChangeFolderInSubschema/`: the dialect-independent remote documents the draft-07 tests use.

The tests reference remote documents as `http://localhost:1234/<path below remotes>`;
`src/vs/base/test/node/jsonSchemaValidator/jsonSchemaTestSuite.test.ts` supplies them in memory.

These files are development-only test data and are not shipped with VS Code. `cgmanifest.json` registers
`json-schema-org/JSON-Schema-Test-Suite` with `"developmentDependency": true`, so it is not listed in
`ThirdPartyNotices.txt`; the upstream license is kept next to the copies instead (`LICENSE`).
