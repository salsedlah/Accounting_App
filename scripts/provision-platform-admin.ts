import "dotenv/config";
import { eq } from "drizzle-orm";
import { hashPassword } from "../src/server/auth";
import { getDb, closeDb } from "../src/db/client";
import { platformAdmins, users } from "../src/db/schema";

async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const name = process.env.PLATFORM_ADMIN_NAME?.trim();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !name || !password || password.length < 10) {
    throw new Error("Set PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_NAME, and PLATFORM_ADMIN_PASSWORD (10+ characters) in the operator environment.");
  }
  const db = await getDb();
  await db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing) throw new Error("That email already belongs to an account. Use a dedicated new email for the platform owner.");
    const [user] = await tx.insert(users).values({ email, name, passwordHash: await hashPassword(password), isActive: true }).returning({ id: users.id });
    await tx.insert(platformAdmins).values({ userId: user.id });
  });
  console.log(`Provisioned platform administrator: ${email}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDb());
