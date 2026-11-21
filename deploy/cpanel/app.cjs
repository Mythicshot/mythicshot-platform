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
// app.example.com). With neither, the app serves one address. A third, IMG_HOST, the
// host name of an address for shared images and clips (such as img.example.com), is
// optional too and only ever set beside the other two. They are passed on like every
// other line; the app itself checks them and stops at the start on addresses it cannot
// use.
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
// The other optional settings are passed on the same way: STORAGE_ALLOWANCE_BYTES (the
// storage allowance of a workspace, in bytes), INVITE_CONTACT (who to ask for an
// invite, shown on the sign-in page), DOWNLOAD_URL (the https address of the public
// page the desktop app is downloaded from, linked on the dashboard), HOME_URL (the site's
// home page, which the logo and name at the top of the dashboard link to; a value the app
// cannot use stops it from starting, with one line in the log), and the three sign-in
// lifetimes in whole days, SESSION_MAX_DAYS, CONNECTION_IDLE_DAYS and CONNECTION_MAX_DAYS
// (0 or off switches one off; a value the app cannot use is its default, with one line in
// the log). PORT and PUBLIC_IMAGE_BASE are read by the app too
// and passed on like any other line; the install writes neither.
//
// RECOVERY_LINKS is read only for the admin command below, and never put in the
// environment: the command is handed it as an explicit yes or no.
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

/** The lines of the settings file as [NAME, value], with one pair of quotes dropped. */
function settingsLines() {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const quoted = /^"(.*)"$/.exec(m[2]) || /^'(.*)'$/.exec(m[2]);
    out.push([m[1], quoted ? quoted[1] : m[2]]);
  }
  return out;
}

// `node app.cjs admin <arguments>` runs the site's admin command (dist/node/admin.js)
// instead of the app: that is how `cpanel.sh admin` runs it. The guard is the first
// argument: whatever loads this file to start the app (Passenger, through a loader of its
// own) does not hand it `admin` first, and no line of the settings file can choose the
// command. For the command the settings file is the only source: every setting the app
// reads, and the recovery setting, is first cleared from the environment (the list comes
// from the command itself, ADMIN_SETTINGS), so a variable set in the shell it is run from
// cannot point it at another database or another address. RECOVERY_LINKS is not put in
// the environment at all: the command is handed it as an explicit yes or no. For the app
// the environment wins, as before.
if (require.main === module && process.argv[2] === "admin") {
  import("./dist/node/admin.js")
    .then((admin) => {
      if (!Array.isArray(admin.ADMIN_SETTINGS) || typeof admin.isRecoveryOn !== "function") throw new Error("not this command");
      for (const name of admin.ADMIN_SETTINGS) delete process.env[name];
      let recovery;
      for (const [name, value] of settingsLines()) {
        if (name === "RECOVERY_LINKS") recovery = value;
        else process.env[name] = value;
      }
      // The arguments after `admin` reach the command unchanged.
      return admin.main(process.argv.slice(3), { recoveryLinks: admin.isRecoveryOn(recovery) });
    })
    .catch(() => {
      // A fixed sentence: nothing of the settings and nothing the error says.
      console.error("demo-platform: the admin command could not be run. Update the site with a current archive and try again.");
      process.exit(1);
    });
} else {
  for (const [name, value] of settingsLines()) if (process.env[name] === undefined) process.env[name] = value;
  import("./dist/node/entry.js").catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
