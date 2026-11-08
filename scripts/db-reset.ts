import fs from "node:fs";
import path from "node:path";
import { closeDb } from "../src/db/client";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

const url = process.env.DATABASE_URL?.trim();
if (url) {
  console.error("Refusing to delete a remote database. Unset DATABASE_URL to reset the embedded DB.");
  process.exit(1);
}

async function main() {
  await closeDb();
  const dir = path.join(process.cwd(), "data", "pg");
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("removed", dir);
  } else {
    console.log("nothing to remove");
  }
}

main();
