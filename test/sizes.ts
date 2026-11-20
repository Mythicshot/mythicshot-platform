// The one table of how a size is written, everywhere a person reads one: the server's
// formatBytes (src/usage.ts, used in the storage-full sentence) and the dashboard's shared
// script (Dash.formatBytes inside DASH_JS, src/dash/script.ts), which is plain text served
// to the browser and cannot import the server's module. Both are held to this table, in
// test/usage.test.ts and test/node-dash-pages.test.ts, so they cannot drift apart. (The old
// account page's own copy went with it when /account became a dashboard page.)
//
// The rule: under 1024 the exact number of bytes; otherwise 1024 to the next unit, at most
// one decimal and no trailing ".0"; a value that rounds to 1024 of a unit is 1 of the next;
// GB is the largest unit.
export const SIZE_TABLE: readonly (readonly [number, string])[] = [
  [0, "0 bytes"],
  [1, "1 byte"],
  [2, "2 bytes"],
  [1023, "1023 bytes"],
  [1024, "1 KB"],
  [1075, "1 KB"],
  [1126, "1.1 KB"],
  [1536, "1.5 KB"],
  [10_240, "10 KB"],
  [102_400, "100 KB"],
  [200_000, "195.3 KB"],
  [524_288, "512 KB"],
  [525_000, "512.7 KB"],
  [1_048_524, "1023.9 KB"],
  [1_048_525, "1 MB"],
  [1_048_575, "1 MB"],
  [1_048_576, "1 MB"],
  [2_000_000, "1.9 MB"],
  [14_889_779, "14.2 MB"],
  [1023 * 1024 * 1024, "1023 MB"],
  [1_073_741_823, "1 GB"],
  [1_073_741_824, "1 GB"],
  [1_288_490_189, "1.2 GB"],
  [5 * 1024 ** 3, "5 GB"],
  [1024 ** 4, "1024 GB"],
  [5 * 1024 ** 4, "5120 GB"],
  [9_007_199_254_740_991, "8388608 GB"],
];
