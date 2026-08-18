/**
 * The sample lockfile this surface can load into the tray, so that a reader who does not have a
 * project open can still run a scan.
 *
 * The text is a copy of test/fixtures/lockfiles/package-lock-v3.json rather than an import of
 * it, on purpose. Test fixtures are not shipped code: importing one would put the test tree
 * inside the browser bundle and would break this page the moment a parser test needed a
 * different file. The copy is exact, so the fixture stays the one place the format is described.
 * sourceRef: test/fixtures/lockfiles/package-lock-v3.json
 *
 * What it exercises: two levels of nesting with a duplicate of the same package at different
 * depths, a dev-only branch, a workspace link entry, and six direct dependencies across eleven
 * package entries. Its package names are invented, so most rows come back undecided rather than
 * clean, and that is the honest result to demonstrate: the slice never ingested those packages,
 * so the scan says it cannot decide instead of calling them safe. The UI names this as a sample
 * before it is run.
 */

/**
 * Named wherever the sample is offered, so nobody reads its result as a report about their own
 * project. It carries no dependency count on purpose: the parser folds the eleven package
 * entries into the dependencies it can identify, and a number here that disagrees with the
 * "Dependencies read" line on the receipt would read as one of the two being wrong.
 */
export const SAMPLE_LOCKFILE_LABEL = "package-lock.json at lockfileVersion 3";

/** The file contents, verbatim. Read as text and posted as text: nothing in it is ever evaluated. */
export const SAMPLE_LOCKFILE_TEXT = `{
  "name": "fixture-app",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "fixture-app",
      "version": "0.1.0",
      "dependencies": {
        "@babel/core": "^7.24.0",
        "chalk": "^5.3.1",
        "left-pad": "^1.3.0",
        "shared-util": "^3.1.0"
      },
      "devDependencies": {
        "aaa": "^1.0.0",
        "typescript": "^5.4.5"
      },
      "workspaces": ["packages/*"]
    },
    "node_modules/@babel/core": {
      "version": "7.24.0",
      "resolved": "https://registry.npmjs.org/@babel/core/-/core-7.24.0.tgz",
      "integrity": "sha512-fixtureBabelCore==",
      "engines": { "node": ">=6.9.0" }
    },
    "node_modules/aaa": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/aaa/-/aaa-1.0.0.tgz",
      "integrity": "sha512-fixtureAaa==",
      "dev": true
    },
    "node_modules/aaa/node_modules/shared-util": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/shared-util/-/shared-util-3.1.0.tgz",
      "integrity": "sha512-fixtureSharedUtil==",
      "dev": true
    },
    "node_modules/chalk": {
      "version": "5.3.1",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.3.1.tgz",
      "integrity": "sha512-fixtureChalk==",
      "engines": { "node": "^12.17.0 || ^14.13 || >=16.0.0" }
    },
    "node_modules/left-pad": {
      "version": "1.3.0",
      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
      "integrity": "sha512-fixtureLeftPad=="
    },
    "node_modules/left-pad/node_modules/chalk": {
      "version": "5.3.1",
      "resolved": "https://registry.npmjs.org/chalk/-/chalk-5.3.1.tgz",
      "integrity": "sha512-fixtureChalk==",
      "dev": true
    },
    "node_modules/left-pad/node_modules/nested-only": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/nested-only/-/nested-only-2.0.0.tgz",
      "integrity": "sha512-fixtureNestedOnly=="
    },
    "node_modules/shared-util": {
      "version": "3.1.0",
      "resolved": "https://registry.npmjs.org/shared-util/-/shared-util-3.1.0.tgz",
      "integrity": "sha512-fixtureSharedUtil=="
    },
    "node_modules/typescript": {
      "version": "5.4.5",
      "resolved": "https://registry.npmjs.org/typescript/-/typescript-5.4.5.tgz",
      "integrity": "sha512-fixtureTypescript==",
      "dev": true,
      "bin": { "tsc": "bin/tsc" },
      "engines": { "node": ">=14.17" }
    },
    "node_modules/web": {
      "resolved": "packages/web",
      "link": true
    },
    "packages/web": {
      "name": "@fixture-app/web",
      "version": "0.0.1"
    }
  }
}
`;
