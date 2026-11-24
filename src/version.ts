// The server's version, reported by GET /api/v1/me. A Worker cannot read package.json at
// run time, so the number is written here and both targets import it; test/tours.test.ts
// fails on both when it differs from the version in package.json. Change the two together.
export const VERSION = "0.1.65";
