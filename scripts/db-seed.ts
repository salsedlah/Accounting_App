import { ensureReady } from "../src/db/bootstrap";
import { closeDb } from "../src/db/client";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

ensureReady()
  .then((result) => {
    console.log("seed complete:", result);
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
