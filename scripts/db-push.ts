import { closeDb, getDb } from "../src/db/client";

try {
  process.loadEnvFile?.(".env");
} catch {
  /* ignore */
}

getDb()
  .then(() => console.log("migrations applied"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
