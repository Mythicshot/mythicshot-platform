// A consistent copy of the container's database, for backups. Run inside the app
// container as `node dist/node/backup.js <target file>`; it reads the database at
// $DATA_DIR/db.sqlite. The copy is made with SQLite's VACUUM INTO, which reads one
// snapshot of the database while the running server keeps writing, so the copy is
// never torn. It never overwrites a file that already exists, and the copy it writes
// is readable by its owner only (mode 0600).
import { closeSync, existsSync, openSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** Writes a consistent copy of the database at `dbPath` to `target`, a file that must not exist yet. */
export function backupDatabase(dbPath: string, target: string): void {
  if (!existsSync(dbPath)) throw new Error("no database at the given path");
  // Create the target ourselves, exclusively and with mode 0600: any existing file, even
  // an empty one VACUUM INTO would accept, is refused, and SQLite then writes into this
  // empty file, keeping its mode.
  let fd: number;
  try {
    fd = openSync(target, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") throw new Error("target file already exists");
    throw err;
  }
  closeSync(fd);
  const db = new DatabaseSync(dbPath, { timeout: 5000 });
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (err) {
    // Remove only the empty file this call created.
    rmSync(target, { force: true });
    throw err;
  } finally {
    db.close();
  }
}

function main(): void {
  const target = process.argv[2];
  if (!target) throw new Error("usage: node dist/node/backup.js <target file>");
  const dataDir = process.env.DATA_DIR;
  if (!dataDir) throw new Error("DATA_DIR is not set");
  backupDatabase(join(resolve(dataDir), "db.sqlite"), resolve(target));
  console.log("backup written");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err: unknown) {
    console.error(err instanceof Error ? err.message : "backup failed");
    process.exit(1);
  }
}
