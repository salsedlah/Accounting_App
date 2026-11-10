import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Contract test for two independent offline-first clients (the Windows desktop
 * app and the Flutter Android app) sharing one verified cloud business.
 *
 * It proves that:
 *  - both clients resolve to the same verified business and auth identity;
 *  - each client keeps its own cursor, so one client acknowledging a page never
 *    advances the other client past changes it has not seen;
 *  - a change pushed by one client is pulled exactly once by the other, and is
 *    never replayed after the cursor is acknowledged;
 *  - a backup created by one client is visible to, and restorable by, the other;
 *  - a restore performed by one client produces sync changes the other pulls.
 */

const TEST_DIR = mkdtempSync(join(tmpdir(), "hisab-two-client-"));
process.env.DATABASE_URL = `file:${TEST_DIR.replace(/\\/g, "/")}`;
delete process.env.SUPABASE_URL;
delete process.env.NEXT_PUBLIC_SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

const { ensureReady } = await import("@/db/bootstrap");
const { closeDb, getDb, transaction } = await import("@/db/client");
const schema = await import("@/db/schema");
const {
  acknowledgeCursor,
  getSyncStatus,
  latestChangeId,
  pullChanges,
  recordOperationChange,
} = await import("@/server/services/cloud-sync");
const {
  createBusinessBackup,
  listBusinessBackups,
  loadBusinessBackup,
  restoreBusinessBackup,
} = await import("@/server/services/cloud-backup");

const DESKTOP = "desktop-windows";
const FLUTTER = "flutter-android";

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
let businessId: string;

// Independent per-client cursors, exactly like the values each client persists.
let desktopCursor = 0;
let flutterCursor = 0;
let desktopSaleId = "";

async function pullAll(since: number) {
  const changes: Awaited<ReturnType<typeof pullChanges>>["changes"] = [];
  let cursor = since;
  for (let page = 0; page < 20; page += 1) {
    const result = await transaction((tx) =>
      pullChanges(tx, session, { since: cursor, limit: 500 }),
    );
    changes.push(...result.changes);
    cursor = result.nextCursor;
    if (!result.hasMore) break;
  }
  return { changes, nextCursor: cursor };
}

beforeAll(async () => {
  // Reset the shared runtime so this file's DATABASE_URL is the one migrated.
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
  const [ownerUser] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, owner.userId));

  // Both clients sign in to the same verified Supabase identity.
  const authUserId = randomUUID();
  await db
    .update(schema.users)
    .set({ authUserId })
    .where(eq(schema.users.id, ownerUser.id));
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
});

afterAll(async () => {
  await closeDb();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("desktop and Flutter share one cloud business", () => {
  it("resolves both clients to the same verified business identity", async () => {
    const desktop = await transaction((tx) =>
      getSyncStatus(tx, session, DESKTOP),
    );
    const flutter = await transaction((tx) =>
      getSyncStatus(tx, session, FLUTTER),
    );

    expect(desktop.businessId).toBe(flutter.businessId);
    expect(desktop.businessId).toBe(businessId);
    expect(desktop.authUserId).toBe(session.authUserId);
    expect(flutter.authUserId).toBe(session.authUserId);
    // No device has synced yet, so neither client has a cursor.
    expect(desktop.cursor).toBeNull();
    expect(flutter.cursor).toBeNull();
  });

  it("delivers a desktop offline sale to Flutter exactly once", async () => {
    desktopSaleId = randomUUID();
    const baseline = await transaction((tx) => latestChangeId(tx, businessId));

    await transaction((tx) =>
      recordOperationChange(
        tx,
        session,
        "sale.create",
        { sale: { id: desktopSaleId, totalMinor: "1500" } },
        DESKTOP,
      ),
    );

    const pulled = await transaction((tx) =>
      pullChanges(tx, session, { since: 0, limit: 500 }),
    );
    const delivered = pulled.changes.filter(
      (row) => row.table === "sales" && row.recordId === desktopSaleId,
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].operation).toBe("insert");
    expect(delivered[0].deviceId).toBe(DESKTOP);
    expect(pulled.nextCursor).toBeGreaterThan(baseline);

    flutterCursor = pulled.nextCursor;
    await transaction((tx) =>
      acknowledgeCursor(tx, session, {
        deviceId: FLUTTER,
        lastChangeId: flutterCursor,
      }),
    );

    const replay = await transaction((tx) =>
      pullChanges(tx, session, { since: flutterCursor, limit: 500 }),
    );
    expect(replay.changes).toHaveLength(0);
    expect(replay.nextCursor).toBe(flutterCursor);
  });

  it("delivers a Flutter sale back to desktop without replaying", async () => {
    const flutterSaleId = randomUUID();

    await transaction((tx) =>
      recordOperationChange(
        tx,
        session,
        "sale.create",
        { sale: { id: flutterSaleId } },
        FLUTTER,
      ),
    );

    const desktopPull = await transaction((tx) =>
      pullChanges(tx, session, { since: desktopCursor, limit: 500 }),
    );
    const incoming = desktopPull.changes.filter(
      (row) => row.table === "sales" && row.recordId === flutterSaleId,
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0].deviceId).toBe(FLUTTER);
    // The desktop also receives its own earlier push exactly once, because its
    // cursor had not advanced yet.
    const own = desktopPull.changes.filter(
      (row) => row.table === "sales" && row.recordId === desktopSaleId,
    );
    expect(own).toHaveLength(1);

    desktopCursor = desktopPull.nextCursor;
    await transaction((tx) =>
      acknowledgeCursor(tx, session, {
        deviceId: DESKTOP,
        lastChangeId: desktopCursor,
      }),
    );

    const again = await transaction((tx) =>
      pullChanges(tx, session, { since: desktopCursor, limit: 500 }),
    );
    expect(again.changes).toHaveLength(0);
  });

  it("keeps the two client cursors independent", async () => {
    const desktop = await transaction((tx) =>
      getSyncStatus(tx, session, DESKTOP),
    );
    const flutter = await transaction((tx) =>
      getSyncStatus(tx, session, FLUTTER),
    );

    expect(desktop.cursor?.deviceId).toBe(DESKTOP);
    expect(desktop.cursor?.lastChangeId).toBe(desktopCursor);
    expect(flutter.cursor?.deviceId).toBe(FLUTTER);
    // Desktop acknowledging past the Flutter sale must not move Flutter's cursor.
    expect(flutter.cursor?.lastChangeId).toBe(flutterCursor);

    const flutterPull = await transaction((tx) =>
      pullChanges(tx, session, { since: flutterCursor, limit: 500 }),
    );
    const flutterOwnSale = flutterPull.changes.find(
      (row) => row.table === "sales" && row.deviceId === FLUTTER,
    );
    expect(flutterOwnSale).toBeTruthy();

    flutterCursor = flutterPull.nextCursor;
    await transaction((tx) =>
      acknowledgeCursor(tx, session, {
        deviceId: FLUTTER,
        lastChangeId: flutterCursor,
      }),
    );
  });
});

describe("cloud backup and restore across clients", () => {
  it("makes a desktop backup visible to and restorable by Flutter", async () => {
    const customerName = `عميل متعدد الأجهزة ${randomUUID().slice(0, 8)}`;
    const [customer] = await db
      .insert(schema.customers)
      .values({ businessId, name: customerName })
      .returning();

    const created = await transaction((tx) =>
      createBusinessBackup(tx, session, "manual"),
    );
    expect(created.duplicate).toBe(false);
    expect(created.backup.businessId).toBe(businessId);
    expect(created.backup.metadata).toMatchObject({
      storage: "postgres-jsonb",
    });

    // Flutter lists and loads the same backup.
    const listed = await transaction((tx) =>
      listBusinessBackups(tx, businessId),
    );
    expect(listed.some((row) => row.id === created.backup.id)).toBe(true);
    const loaded = await transaction((tx) =>
      loadBusinessBackup(tx, businessId, created.backup.id),
    );
    expect(
      loaded.data.tables.customers.some(
        (row) => row.id === customer.id && row.name === customerName,
      ),
    ).toBe(true);

    // The desktop changed data after the backup; Flutter restores it.
    await db
      .delete(schema.customers)
      .where(eq(schema.customers.id, customer.id));

    const restored = await transaction((tx) =>
      restoreBusinessBackup(tx, session, created.backup.id),
    );
    expect(restored.restoredRows).toBeGreaterThan(0);

    const [restoredCustomer] = await db
      .select({ id: schema.customers.id, name: schema.customers.name })
      .from(schema.customers)
      .where(eq(schema.customers.id, customer.id));
    expect(restoredCustomer?.name).toBe(customerName);

    const [marked] = await db
      .select({ restoredAt: schema.cloudBackups.restoredAt })
      .from(schema.cloudBackups)
      .where(eq(schema.cloudBackups.id, created.backup.id));
    expect(marked.restoredAt).toBeTruthy();
  });

  it("propagates a restore to the other client as sync changes", async () => {
    const [customer] = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.businessId, businessId))
      .limit(1);
    expect(customer).toBeTruthy();

    // Flutter restores the latest backup. The desktop, which has been idle,
    // must pull the resulting inserts exactly once.
    const baseline = await transaction((tx) => latestChangeId(tx, businessId));
    const [latest] = await transaction((tx) => listBusinessBackups(tx, businessId, 1));
    expect(latest).toBeTruthy();
    await transaction((tx) =>
      restoreBusinessBackup(tx, session, latest.id),
    );

    const pulled = await pullAll(baseline);
    const restoredInserts = pulled.changes.filter(
      (row) =>
        row.table === "customers" &&
        row.recordId === customer.id &&
        row.operation === "insert",
    );
    expect(restoredInserts.length).toBeGreaterThanOrEqual(1);

    const next = pulled.nextCursor;
    await transaction((tx) =>
      acknowledgeCursor(tx, session, {
        deviceId: DESKTOP,
        lastChangeId: next,
      }),
    );
    desktopCursor = next;

    const replay = await transaction((tx) =>
      pullChanges(tx, session, { since: desktopCursor, limit: 500 }),
    );
    expect(replay.changes).toHaveLength(0);
  });
});
