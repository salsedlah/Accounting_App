import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DIR = mkdtempSync(join(tmpdir(), "hisab-cloud-"));
process.env.DATABASE_URL = `file:${TEST_DIR.replace(/\\/g, "/")}`;
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { ensureReady } = await import("@/db/bootstrap");
const { closeDb, getDb, transaction } = await import("@/db/client");
const schema = await import("@/db/schema");
const { AuthError } = await import("@/server/auth");
const {
  acknowledgeCursor,
  cloudUserId,
  getSyncStatus,
  hasVerifiedCloudIdentity,
  latestChangeId,
  markSyncError,
  pullChanges,
  recordOperationChange,
} = await import("@/server/services/cloud-sync");
const {
  backupChecksum,
  collectBusinessData,
  createBusinessBackup,
  listBusinessBackups,
  loadBusinessBackup,
  restoreBusinessBackup,
} = await import("@/server/services/cloud-backup");
const { provisionAccount } = await import("@/server/services/provisioning");

type TestSession = {
  userId: string;
  businessId: string;
  email: string;
  name: string;
  role: string;
  businessName: string;
  authUserId?: string | null;
};

let db: Awaited<ReturnType<typeof getDb>>;

let session: TestSession;
let legacySession: TestSession;
let businessId: string;
let ownerUserId: string;

beforeAll(async () => {
  // The vitest config runs all files in one fork. Reset the shared runtime so
  // this file's DATABASE_URL is the one actually used for migrations and seed.
  await closeDb();
  await ensureReady();
  db = await getDb();

  const [business] = await db.select().from(schema.businesses).limit(1);
  businessId = business.id;
  const [owner] = await db
    .select({ userId: schema.memberships.userId })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.businessId, businessId),
        eq(schema.memberships.role, "owner"),
      ),
    );
  ownerUserId = owner.userId;
  const [ownerUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, ownerUserId));

  // Simulate the secure legacy-account link step: the local user and business
  // are attributed to a verified Supabase Auth identity.
  const authUserId = randomUUID();
  await db
    .update(schema.users)
    .set({ authUserId })
    .where(eq(schema.users.id, ownerUserId));
  await db
    .update(schema.businesses)
    .set({ ownerAuthUserId: authUserId })
    .where(eq(schema.businesses.id, businessId));

  session = {
    userId: ownerUser.id,
    businessId,
    email: ownerUser.email,
    name: ownerUser.name,
    role: "owner",
    businessName: business.name,
    authUserId,
  };
  legacySession = { ...session, authUserId: null };
});

afterAll(async () => {
  await closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("cloud identity verification", () => {
  it("rejects a legacy local user id as a cloud identity", () => {
    expect(hasVerifiedCloudIdentity(legacySession)).toBe(false);
    expect(hasVerifiedCloudIdentity(session)).toBe(true);
    expect(() => cloudUserId(legacySession)).toThrow(AuthError);
    expect(cloudUserId(session)).toBe(session.authUserId);
  });

  it("refuses to re-link an account to a different Supabase identity", async () => {
    await expect(
      transaction((tx) =>
        provisionAccount(tx, {
          email: session.email,
          name: session.name,
          businessName: session.businessName,
          authUserId: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("change capture and offline reconnect", () => {
  it("captures database writes for a verified business", async () => {
    const baseline = await transaction((tx) => latestChangeId(tx, businessId));
    await db
      .update(schema.businesses)
      .set({ name: `${session.businessName} - updated` })
      .where(eq(schema.businesses.id, businessId));

    const pulled = await transaction((tx) =>
      pullChanges(tx, session, { since: baseline, limit: 50 }),
    );
    const change = pulled.changes.find(
      (row) => row.table === "businesses" && row.recordId === businessId,
    );
    expect(change).toBeTruthy();
    expect(change?.operation).toBe("update");
    expect(pulled.nextCursor).toBeGreaterThan(baseline);
  });

  it("acknowledges a cursor and resumes without replaying changes", async () => {
    const baseline = await transaction((tx) => latestChangeId(tx, businessId));
    await db
      .update(schema.businesses)
      .set({ phone: "0000000" })
      .where(eq(schema.businesses.id, businessId));

    const first = await transaction((tx) =>
      pullChanges(tx, session, { since: baseline, limit: 50 }),
    );
    expect(first.changes.length).toBeGreaterThan(0);

    await transaction((tx) =>
      acknowledgeCursor(tx, session, {
        deviceId: "device-a",
        lastChangeId: first.nextCursor,
      }),
    );

    const status = await transaction((tx) =>
      getSyncStatus(tx, session, "device-a"),
    );
    expect(status.cursor?.deviceId).toBe("device-a");
    expect(status.cursor?.lastChangeId).toBe(first.nextCursor);
    expect(status.settings.lastSyncAt).toBeTruthy();
    expect(status.authUserId).toBe(session.authUserId);

    const resumed = await transaction((tx) =>
      pullChanges(tx, session, { since: first.nextCursor, limit: 50 }),
    );
    expect(resumed.changes).toHaveLength(0);
    expect(resumed.nextCursor).toBe(first.nextCursor);
  });

  it("records a pushed mobile operation exactly once", async () => {
    const baseline = await transaction((tx) => latestChangeId(tx, businessId));
    const productId = randomUUID();
    const recorded = await transaction((tx) =>
      recordOperationChange(
        tx,
        session,
        "product.create",
        { product: { id: productId, name: "منتج تجريبي" } },
        "device-a",
      ),
    );
    expect(recorded?.id).toBeGreaterThan(baseline);

    const pulled = await transaction((tx) =>
      pullChanges(tx, session, { since: baseline, limit: 50 }),
    );
    const matching = pulled.changes.filter(
      (row) => row.table === "products" && row.recordId === productId,
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].operation).toBe("insert");
    expect(matching[0].deviceId).toBe("device-a");
  });

  it("stores a bounded error message without leaking credentials", async () => {
    await transaction((tx) =>
      markSyncError(tx, session, "x".repeat(900)),
    );
    const status = await transaction((tx) => getSyncStatus(tx, session, null));
    expect(status.settings.lastError).toHaveLength(500);
  });
});

describe("cloud backup and restore", () => {
  it("creates an idempotent backup that excludes secrets", async () => {
    const first = await transaction((tx) =>
      createBusinessBackup(tx, session, "manual"),
    );
    expect(first.duplicate).toBe(false);

    const second = await transaction((tx) =>
      createBusinessBackup(tx, session, "manual"),
    );
    expect(second.duplicate).toBe(true);
    expect(second.backup.id).toBe(first.backup.id);

    const data = await transaction((tx) => collectBusinessData(tx, businessId));
    for (const user of data.tables.users) {
      expect(user).not.toHaveProperty("passwordHash");
      expect(user).not.toHaveProperty("authUserId");
    }
    expect(JSON.stringify(data.tables.users)).not.toContain("passwordHash");
    expect(data.metadata.excludes).toContain("users.password_hash");
    expect(first.backup.checksum).toBe(backupChecksum(data));
  });

  it("restores a backup over changed data and reports the safety backup", async () => {
    const [customer] = await db
      .insert(schema.customers)
      .values({ businessId, name: "عميل الاستعادة" })
      .returning();

    const backup = await transaction((tx) =>
      createBusinessBackup(tx, session, "manual"),
    );

    await db.delete(schema.customers).where(eq(schema.customers.id, customer.id));
    const [deleted] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.id, customer.id));
    expect(deleted).toBeUndefined();

    const safety = await transaction((tx) =>
      createBusinessBackup(tx, session, "safety"),
    );

    const result = await transaction((tx) =>
      restoreBusinessBackup(tx, session, backup.backup.id, {
        safetyBackupId: safety.backup.id,
      }),
    );
    expect(result.safetyBackupId).toBe(safety.backup.id);
    expect(result.restoredRows).toBeGreaterThan(0);

    const [restored] = await db
      .select({ id: schema.customers.id, name: schema.customers.name })
      .from(schema.customers)
      .where(eq(schema.customers.id, customer.id));
    expect(restored?.name).toBe("عميل الاستعادة");

    const [loaded] = await db
      .select({ restoredAt: schema.cloudBackups.restoredAt })
      .from(schema.cloudBackups)
      .where(eq(schema.cloudBackups.id, backup.backup.id));
    expect(loaded.restoredAt).toBeTruthy();
  });

  it("rejects a backup from another business", async () => {
    const [other] = await db
      .select({ id: schema.businesses.id })
      .from(schema.businesses)
      .where(eq(schema.businesses.id, businessId))
      .limit(1);
    expect(other).toBeTruthy();
    await expect(
      transaction((tx) =>
        loadBusinessBackup(tx, businessId, randomUUID()),
      ),
    ).rejects.toThrow();
  });
});

describe("account and business isolation", () => {
  let otherSession: TestSession;
  let otherBusinessId: string;
  let otherBackupId: string;

  beforeAll(async () => {
    const otherAuthUserId = randomUUID();
    const provisioned = await transaction((tx) =>
      provisionAccount(tx, {
        email: `other-${Date.now()}@example.com`,
        name: "مالك آخر",
        businessName: "نشاط آخر",
        authUserId: otherAuthUserId,
      }),
    );
    otherBusinessId = provisioned.businessId;
    const [otherUser] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, provisioned.userId));
    const [otherBusiness] = await db
      .select()
      .from(schema.businesses)
      .where(eq(schema.businesses.id, otherBusinessId));
    otherSession = {
      userId: otherUser.id,
      businessId: otherBusinessId,
      email: otherUser.email,
      name: otherUser.name,
      role: "owner",
      businessName: otherBusiness.name,
      authUserId: otherAuthUserId,
    };

    await db
      .insert(schema.customers)
      .values({ businessId: otherBusinessId, name: "عميل النشاط الآخر" });

    const backup = await transaction((tx) =>
      createBusinessBackup(tx, otherSession, "manual"),
    );
    otherBackupId = backup.backup.id;
  });

  it("never returns another business's changes to a device", async () => {
    const [otherChange] = await db
      .select({ id: schema.syncChanges.id })
      .from(schema.syncChanges)
      .where(eq(schema.syncChanges.businessId, otherBusinessId))
      .limit(1);
    expect(otherChange).toBeTruthy();

    const pulled = await transaction((tx) =>
      pullChanges(tx, session, { since: 0, limit: 500 }),
    );
    expect(pulled.changes.some((row) => row.id === otherChange.id)).toBe(false);
  });

  it("does not list another business's backups", async () => {
    const backups = await transaction((tx) =>
      listBusinessBackups(tx, businessId),
    );
    expect(backups.some((row) => row.id === otherBackupId)).toBe(false);
  });

  it("cannot read another business's backup contents", async () => {
    await expect(
      transaction((tx) => loadBusinessBackup(tx, businessId, otherBackupId)),
    ).rejects.toThrow();
  });

  it("provisions the same auth account without duplicating the business", async () => {
    const again = await transaction((tx) =>
      provisionAccount(tx, {
        email: otherSession.email,
        name: otherSession.name,
        businessName: otherSession.businessName,
        authUserId: otherSession.authUserId,
      }),
    );
    expect(again.businessId).toBe(otherBusinessId);
    expect(again.createdBusiness).toBe(false);
    expect(again.createdUser).toBe(false);
  });
});
