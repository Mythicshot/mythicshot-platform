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
// The optional mail settings are passed on the same way: MAIL_MODE (off, the default, or
// smtp), MAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASSWORD, and with them
// SITE_HOST (the host name sign-in links use when the app serves one address) and
// CLIENT_ADDRESS_HEADER (the header in which the hosting's proxy writes the visitor's
// address). SMTP_PASSWORD is a secret like SETUP_CODE: it lives in this file only, which
// must be readable by this account alone. The app checks these settings itself and never
// stops over them: a mail block it cannot use leaves mail off, with one line in the log
// that names the setting and no value.
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

// `node app.cjs admin <arguments>` runs the site's admin command (dist/node/admin.js)
// instead of the app, with these same settings: that is how `cpanel.sh admin` runs it.
// The guard is the first argument: whatever loads this file to start the app (Passenger,
// through a loader of its own) does not hand it `admin` first, and no line of the
// settings file can choose the command. For the command the settings file wins over the
// environment for every setting it holds, so a setting exported in the shell it is run
// from cannot change what it does; for the app the environment wins, as before.
const runAdmin = require.main === module && process.argv[2] === "admin";

for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) continue;
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
  if (!m || (!runAdmin && process.env[m[1]] !== undefined)) continue;
  const quoted = /^"(.*)"$/.exec(m[2]) || /^'(.*)'$/.exec(m[2]);
  process.env[m[1]] = quoted ? quoted[1] : m[2];
}

// The arguments after `admin` reach the command unchanged.
if (runAdmin) {
  import("./dist/node/admin.js")
    .then((admin) => admin.main(process.argv.slice(3)))
    .catch(() => {
      // A fixed sentence: nothing of the settings and nothing the error says.
      console.error("demo-platform: the admin command could not be run. Update the site with a current archive and try again.");
      process.exit(1);
    });
} else {
  import("./dist/node/entry.js").catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
