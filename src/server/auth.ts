import { cookies, headers } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import { and, desc, eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getDb } from "@/db/client";
import { businesses, businessFeatureOverrides, businessSubscriptions, membershipPermissionOverrides, memberships, platformAdmins, products, subscriptionPlans, users } from "@/db/schema";
import type { Permission } from "@/lib/constants";
import { PERMISSION_CATALOG, ROLE_PERMISSIONS, can } from "@/lib/constants";

export const SESSION_COOKIE = "hisab_session";
const SESSION_DAYS = 7;

function secret(): Uint8Array {
  const configured = process.env.AUTH_SECRET;
  if (process.env.NODE_ENV === "production" && (!configured || configured.length < 32)) {
    throw new Error("AUTH_SECRET must be configured with at least 32 characters in production.");
  }
  const value = configured && configured.length >= 24 ? configured : "hisab-dev-secret-change-me-please-1234567890";
  return new TextEncoder().encode(value);
}

export type Session = {
  userId: string;
  businessId: string;
  email: string;
  name: string;
  role: string;
  businessName: string;
};

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function createSessionToken(userId: string, businessId: string): Promise<string> {
  return new SignJWT({ uid: userId, bid: businessId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(secret());
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}

export async function getSession(): Promise<Session | null> {
  const authorization = (await headers()).get("authorization");
  const isBearerRequest = authorization?.toLowerCase().startsWith("bearer ") ?? false;
  const bearerToken = isBearerRequest ? authorization?.slice(7).trim() : undefined;
  const store = isBearerRequest ? null : await cookies();
  const token = isBearerRequest ? bearerToken || undefined : store?.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  let payload: { uid?: string; bid?: string };
  try {
    const verified = await jwtVerify(token, secret());
    payload = verified.payload as { uid?: string; bid?: string };
  } catch {
    return null;
  }
  if (!payload.uid || !payload.bid) return null;

  const db = await getDb();
  if (payload.bid === "platform") {
    const [admin] = await db.select({ userId: users.id, email: users.email, name: users.name })
      .from(platformAdmins)
      .innerJoin(users, eq(users.id, platformAdmins.userId))
      .where(and(eq(users.id, payload.uid), eq(users.isActive, true)))
      .limit(1);
    return admin ? { ...admin, businessId: "platform", role: "super_admin", businessName: "إدارة المنصة" } : null;
  }
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      role: memberships.role,
      businessId: businesses.id,
      businessName: businesses.name,
    })
    .from(users)
    .innerJoin(memberships, eq(memberships.userId, users.id))
    .innerJoin(businesses, eq(businesses.id, memberships.businessId))
    .where(
      and(
        eq(users.id, payload.uid),
        eq(users.isActive, true),
        eq(memberships.businessId, payload.bid),
      ),
    );
  return row ?? null;
}

export class AuthError extends Error {
  status: number;
  constructor(message = "غير مصرح", status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) throw new AuthError("يجب تسجيل الدخول");
  return session;
}

export async function requirePlatformAdmin(): Promise<Session> {
  const session = await requireSession();
  if (session.role !== "super_admin" || session.businessId !== "platform") {
    throw new AuthError("هذه الصفحة مخصصة لمالك المنصة", 403);
  }
  return session;
}

export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await requireSession();
  if (!(await hasPermission(session, permission))) {
    throw new AuthError("لا تملك صلاحية تنفيذ هذا الإجراء", 403);
  }
  await ensureBusinessActive(session);
  const feature = PERMISSION_FEATURES[permission];
  if (feature) await requireBusinessFeature(session, feature);
  return session;
}

const PERMISSION_FEATURES: Partial<Record<Permission, string>> = {
  "sales.create": "pos", "sales.read": "pos", "sales.return": "pos", "sales.custom_price": "pos", "sales.discount": "pos",
  "purchases.create": "purchases", "purchases.read": "purchases",
  "products.read": "products", "products.write": "products",
  "customers.read": "customers", "customers.write": "customers",
  "debts.manage": "customer_debts", "payments.create": "customer_debts",
  "inventory.read": "inventory", "inventory.adjust": "inventory", "stocktaking.manage": "stocktaking",
  "expenses.create": "expenses", "cashbox.manage": "cashbox", "reports.read": "reports", "ai.ask": "ai_assistant",
};

export async function requireBusinessFeature(session: Session, featureKey: string): Promise<void> {
  const features = await getBusinessFeatures(session);
  if (features[featureKey] === false) throw new AuthError("هذه الميزة متوفرة في باقة Plus أو Premium. قم بترقية اشتراكك للاستفادة منها.", 403);
}

export async function getBusinessFeatures(session: Session): Promise<Record<string, boolean>> {
  await ensureBusinessActive(session);
  const db = await getDb();
  const [subscription] = await db.select({ subscription: businessSubscriptions, plan: subscriptionPlans })
    .from(businessSubscriptions).leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id))
    .where(eq(businessSubscriptions.businessId, session.businessId)).orderBy(desc(businessSubscriptions.createdAt)).limit(1);
  if (!subscription) return {};
  if (subscription.subscription.status === "suspended") throw new AuthError("تم تعليق الاشتراك. يرجى التواصل مع مالك المنصة.", 403);
  const expired = subscription.subscription.status === "expired" || Boolean(subscription.subscription.expiresAt && subscription.subscription.expiresAt < new Date());
  const entitled = !expired && (subscription.subscription.status === "active" || subscription.subscription.status === "trial");
  const plan = entitled && subscription.plan ? subscription.plan : (await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.name, "Free")).limit(1))[0];
  const overrides = await db.select().from(businessFeatureOverrides).where(eq(businessFeatureOverrides.businessId, session.businessId));
  const features = { ...(plan?.features ?? {}) } as Record<string, boolean>;
  for (const override of overrides) features[override.featureKey] = override.enabled;
  return features;
}

export async function hasPermission(session: Session, permission: Permission): Promise<boolean> {
  if (session.role === "super_admin") return false;
  const db = await getDb();
  const [membership] = await db.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.businessId, session.businessId), eq(memberships.userId, session.userId))).limit(1);
  if (!membership) return false;
  const [override] = await db.select({ allowed: membershipPermissionOverrides.allowed }).from(membershipPermissionOverrides)
    .where(and(eq(membershipPermissionOverrides.membershipId, membership.id), eq(membershipPermissionOverrides.permissionKey, permission))).limit(1);
  const allowed = override?.allowed ?? can(session.role, permission);
  if (!allowed) return false;
  const feature = PERMISSION_FEATURES[permission];
  if (!feature) return true;
  const features = await getBusinessFeatures(session);
  return features[feature] !== false;
}

export async function getEffectivePermissions(session: Session): Promise<Permission[]> {
  if (session.role === "super_admin") return [];
  const db = await getDb();
  const [membership] = await db.select({ id: memberships.id }).from(memberships)
    .where(and(eq(memberships.businessId, session.businessId), eq(memberships.userId, session.userId))).limit(1);
  if (!membership) return [];
  const overrides = await db.select().from(membershipPermissionOverrides)
    .where(eq(membershipPermissionOverrides.membershipId, membership.id));
  const permissions = new Set<Permission>(ROLE_PERMISSIONS[session.role] ?? []);
  for (const override of overrides) {
    const permission = override.permissionKey as Permission;
    if (!PERMISSION_CATALOG.some((item) => item.key === permission)) continue;
    if (override.allowed) permissions.add(permission); else permissions.delete(permission);
  }
  const features = await getBusinessFeatures(session);
  return [...permissions].filter((permission) => {
    const feature = PERMISSION_FEATURES[permission];
    return !feature || features[feature] !== false;
  });
}

export async function getAvailablePermissions(session: Session) {
  const features = await getBusinessFeatures(session);
  return PERMISSION_CATALOG.filter((item) => {
    const feature = PERMISSION_FEATURES[item.key];
    return !feature || features[feature] !== false;
  });
}

export async function requireCapacity(session: Session, kind: "users" | "products"): Promise<void> {
  const db = await getDb();
  const [business] = await db.select().from(businesses).where(eq(businesses.id, session.businessId)).limit(1);
  if (!business) throw new AuthError("المؤسسة غير موجودة", 404);
  const [subscription] = await db.select({ subscription: businessSubscriptions, plan: subscriptionPlans })
    .from(businessSubscriptions).leftJoin(subscriptionPlans, eq(businessSubscriptions.planId, subscriptionPlans.id))
    .where(eq(businessSubscriptions.businessId, session.businessId)).orderBy(desc(businessSubscriptions.createdAt)).limit(1);
  const expired = !subscription || subscription.subscription.status === "expired" || subscription.subscription.status === "cancelled" || subscription.subscription.status === "pending_payment" || Boolean(subscription.subscription.expiresAt && subscription.subscription.expiresAt < new Date());
  const [free] = expired ? await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.name, "Free")).limit(1) : [];
  const plan = expired ? free : subscription?.plan;
  const configured = kind === "users" ? business.maxUsersOverride ?? plan?.maxUsers : business.maxProductsOverride ?? plan?.maxProducts;
  const limit = configured ?? 0;
  if (limit === 0) return;
  const [usage] = kind === "users"
    ? await db.select({ count: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.businessId, session.businessId))
    : await db.select({ count: sql<number>`count(*)::int` }).from(products).where(eq(products.businessId, session.businessId));
  if ((usage?.count ?? 0) >= limit) throw new AuthError(kind === "users" ? `وصلت المؤسسة إلى الحد الأعلى للمستخدمين (${limit}).` : `وصلت المؤسسة إلى الحد الأعلى للمنتجات (${limit}).`, 403);
}

async function ensureBusinessActive(session: Session) {
  const db = await getDb();
  const [business] = await db.select({ status: businesses.platformStatus }).from(businesses).where(eq(businesses.id, session.businessId)).limit(1);
  if (business?.status === "suspended") throw new AuthError("تم إيقاف حساب المؤسسة. يرجى التواصل مع إدارة المنصة.", 403);
}

export async function assertPermission(session: Session, permission: Permission): Promise<void> {
  if (!(await hasPermission(session, permission))) {
    throw new AuthError("لا تملك صلاحية تنفيذ هذا الإجراء", 403);
  }
}
