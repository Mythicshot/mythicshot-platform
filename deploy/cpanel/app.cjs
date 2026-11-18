"use strict";
// Startup file for shared cPanel hosting ("Setup Node.js App", which runs the app under
// Passenger). Passenger loads a CommonJS file; the app itself is an ES module, so this
// file reads the settings and then imports the app.
//
// The settings file sits beside the app folder, never inside it or inside the web root,
// and is named after the folder: the app in apps/tours reads apps/tours-config.env. It
// holds lines of NAME=value (DATA_DIR and SETUP_CODE). Blank lines and lines starting
// with # are ignored, a variable that is already set in the environment wins, and one
// pair of quotes around a value is dropped. No value from the file is ever printed.
//
// Two more settings are optional and go together: TOURS_HOST and APP_HOST, the host names
// of the tours address and the app address (such as tours.example.com and
// app.example.com). With neither, the app serves one address. They are passed on like
// every other line; the app itself checks them and stops at the start on a pair it
// cannot use.
//
// Tests: test/node-cpanel-app.test.ts.
const fs = require("node:fs");
const path = require("node:path");

const settingsFile = path.join(path.dirname(__dirname), `${path.basename(__dirname)}-config.env`);

let text;
try {
  text = fs.readFileSync(settingsFile, "utf8");
} catch (err) {
  // Only the path and the error code: the code names the reason (ENOENT, EACCES, ...)
  // and cannot carry anything from the file.
  const code = err && typeof err.code === "string" ? err.code : "unknown error";
  console.error(`demo-platform: cannot read the settings file ${settingsFile} (${code}). It must exist, be readable by this account, and hold DATA_DIR and SETUP_CODE.`);
  process.exit(1);
}

for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) continue;
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m || process.env[m[1]] !== undefined) continue;
  const quoted = /^"(.*)"$/.exec(m[2]) || /^'(.*)'$/.exec(m[2]);
  process.env[m[1]] = quoted ? quoted[1] : m[2];
}

import("./dist/node/entry.js").catch((err) => {
  console.error(err);
  process.exit(1);
});
