import { relations, sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/* ------------------------------------------------------------------ enums */

export const userRoleEnum = pgEnum("user_role", [
  "owner",
  "accountant",
  "cashier",
  "inventory_manager",
  "viewer",
]);

export const platformSubscriptionStatusEnum = pgEnum("platform_subscription_status", [
  "trial", "active", "pending_payment", "expired", "suspended", "cancelled",
]);

export const valuationMethodEnum = pgEnum("valuation_method", ["weighted_average", "fifo"]);
export const docKindEnum = pgEnum("doc_kind", ["sale", "return"]);
export const purchaseKindEnum = pgEnum("purchase_kind", ["purchase", "return"]);
export const paymentTypeEnum = pgEnum("payment_type", ["cash", "credit", "mixed"]);
export const movementTypeEnum = pgEnum("movement_type", [
  "opening",
  "purchase",
  "purchase_return",
  "sale",
  "sale_return",
  "adjustment",
  "transfer_in",
  "transfer_out",
  "stocktake",
  "damage",
]);
export const paymentDirectionEnum = pgEnum("payment_direction", [
  "customer_receipt",
  "supplier_payment",
]);
export const cashDirectionEnum = pgEnum("cash_direction", ["inflow", "outflow"]);
export const accountTypeEnum = pgEnum("account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
]);
export const docStatusEnum = pgEnum("doc_status", ["posted", "void"]);
export const stocktakeStatusEnum = pgEnum("stocktake_status", [
  "draft",
  "counting",
  "pending_approval",
  "approved",
  "posted",
  "cancelled",
]);
export const syncStatusEnum = pgEnum("sync_status", [
  "pending",
  "processing",
  "done",
  "failed",
  "conflict",
]);
export const notificationStatusEnum = pgEnum("notification_status", [
  "pending",
  "prepared",
  "sent",
  "failed",
]);
export const reminderChannelEnum = pgEnum("reminder_channel", ["whatsapp", "in_app", "sms"]);

/* ------------------------------------------------------------- businesses */

export const businesses = pgTable("businesses", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  platformStatus: text("platform_status").notNull().default("active"),
  maxUsersOverride: integer("max_users_override"),
  maxProductsOverride: integer("max_products_override"),
  legalName: text("legal_name"),
  phone: text("phone"),
  address: text("address"),
  currency: text("currency").notNull().default("YER"),
  currencyScale: integer("currency_scale").notNull().default(2),
  taxEnabled: boolean("tax_enabled").notNull().default(false),
  taxRateBp: integer("tax_rate_bp").notNull().default(0),
  valuationMethod: valuationMethodEnum("valuation_method").notNull().default("weighted_average"),
  offlineSellLimitMilli: bigint("offline_sell_limit_milli", { mode: "bigint" })
    .notNull()
    .default(sql`5000000`),
  // Supabase Auth id of the account owner. Every cloud row is linked to this
  // account through its business. Kept nullable for legacy/local businesses.
  ownerAuthUserId: uuid("owner_auth_user_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    // Supabase Auth user id. Nullable so existing installations keep working
    // until each account signs in through Supabase for the first time.
    authUserId: uuid("auth_user_id"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_uq").on(t.email), uniqueIndex("users_auth_user_id_uq").on(t.authUserId)],
);

// Platform administrators are provisioned out of band by an operator. No
// business user role or client supplied field can create one of these rows.
export const platformAdmins = pgTable("platform_admins", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  monthlyPriceMinor: bigint("monthly_price_minor", { mode: "bigint" }).notNull().default(sql`0`),
  yearlyPriceMinor: bigint("yearly_price_minor", { mode: "bigint" }).notNull().default(sql`0`),
  currency: text("currency").notNull().default("YER"),
  trialDays: integer("trial_days").notNull().default(0),
  maxUsers: integer("max_users").notNull().default(1),
  maxProducts: integer("max_products").notNull().default(100),
  storageLimitMb: integer("storage_limit_mb").notNull().default(500),
  features: jsonb("features").$type<Record<string, boolean>>().notNull().default(sql`'{}'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("subscription_plans_name_uq").on(t.name)]);

export const businessSubscriptions = pgTable("business_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").references(() => subscriptionPlans.id, { onDelete: "set null" }),
  status: platformSubscriptionStatusEnum("status").notNull().default("trial"),
  billingPeriod: text("billing_period").notNull().default("monthly"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("business_subscriptions_business_idx").on(t.businessId), index("business_subscriptions_expiry_idx").on(t.expiresAt)]);

export const businessFeatureOverrides = pgTable("business_feature_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  featureKey: text("feature_key").notNull(),
  enabled: boolean("enabled").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("business_feature_overrides_uq").on(t.businessId, t.featureKey)]);

export const subscriptionPayments = pgTable("subscription_payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => businessSubscriptions.id, { onDelete: "set null" }),
  amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
  currency: text("currency").notNull().default("YER"),
  status: text("status").notNull().default("pending"),
  provider: text("provider").notNull().default("manual_pending"),
  providerReference: text("provider_reference"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("subscription_payments_business_idx").on(t.businessId, t.createdAt)]);

export const subscriptionHistory = pgTable("subscription_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("subscription_history_business_idx").on(t.businessId, t.createdAt)]);

export const platformAuditLogs = pgTable("platform_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("platform_audit_logs_created_idx").on(t.createdAt)]);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    key: userRoleEnum("key").notNull(),
    nameAr: text("name_ar").notNull(),
    isSystem: boolean("is_system").notNull().default(true),
  },
  (t) => [uniqueIndex("roles_business_key_uq").on(t.businessId, t.key)],
);

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  labelAr: text("label_ar").notNull(),
  groupAr: text("group_ar").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key")
      .notNull()
      .references(() => permissions.key, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("role_permissions_uq").on(t.roleId, t.permissionKey)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: userRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("memberships_business_user_uq").on(t.businessId, t.userId),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const membershipPermissionOverrides = pgTable(
  "membership_permission_overrides",
  {
    membershipId: uuid("membership_id").notNull().references(() => memberships.id, { onDelete: "cascade" }),
    permissionKey: text("permission_key").notNull().references(() => permissions.key, { onDelete: "cascade" }),
    allowed: boolean("allowed").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.membershipId, t.permissionKey], name: "membership_permission_overrides_pk" }), index("membership_permission_overrides_membership_idx").on(t.membershipId)],
);

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [index("warehouses_business_idx").on(t.businessId)],
);

/* ---------------------------------------------------------- catalog units */

export const units = pgTable(
  "units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull().default("custom"),
  },
  (t) => [uniqueIndex("units_business_name_uq").on(t.businessId, t.name)],
);

export const productCategories = pgTable(
  "product_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [uniqueIndex("categories_business_name_uq").on(t.businessId, t.name)],
);

export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    address: text("address"),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("suppliers_business_idx").on(t.businessId)],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    address: text("address"),
    creditLimitMinor: bigint("credit_limit_minor", { mode: "bigint" }).notNull().default(sql`0`),
    notes: text("notes"),
    isActive: boolean("is_active").notNull().default(true),
    lastTransactionAt: timestamp("last_transaction_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("customers_business_idx").on(t.businessId),
    index("customers_phone_idx").on(t.businessId, t.phone),
  ],
);

export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sku: text("sku").notNull(),
    barcode: text("barcode"),
    categoryId: uuid("category_id").references(() => productCategories.id, {
      onDelete: "set null",
    }),
    imageUrl: text("image_url"),
    baseUnitId: uuid("base_unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    purchaseCostMinor: bigint("purchase_cost_minor", { mode: "bigint" }).notNull().default(sql`0`),
    retailPriceMinor: bigint("retail_price_minor", { mode: "bigint" }).notNull().default(sql`0`),
    wholesalePriceMinor: bigint("wholesale_price_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    minStockMilli: bigint("min_stock_milli", { mode: "bigint" }).notNull().default(sql`0`),
    defaultSupplierId: uuid("default_supplier_id").references(() => suppliers.id, {
      onDelete: "set null",
    }),
    expiryDate: date("expiry_date"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("products_business_sku_uq").on(t.businessId, t.sku),
    uniqueIndex("products_business_barcode_uq").on(t.businessId, t.barcode),
    index("products_business_name_idx").on(t.businessId, t.name),
  ],
);

export const productUnits = pgTable(
  "product_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    factorMilli: bigint("factor_milli", { mode: "bigint" }).notNull(),
    isBase: boolean("is_base").notNull().default(false),
    retailPriceMinor: bigint("retail_price_minor", { mode: "bigint" }),
    wholesalePriceMinor: bigint("wholesale_price_minor", { mode: "bigint" }),
    allowFraction: boolean("allow_fraction").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [
    uniqueIndex("product_units_product_unit_uq").on(t.productId, t.unitId),
    index("product_units_product_idx").on(t.productId),
  ],
);

export const unitConversions = pgTable(
  "unit_conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    fromUnitId: uuid("from_unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    toUnitId: uuid("to_unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    factor: text("factor").notNull(),
    note: text("note"),
  },
  (t) => [uniqueIndex("unit_conversions_uq").on(t.productId, t.fromUnitId, t.toUnitId)],
);

/* --------------------------------------------------------------- inventory */

export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    type: movementTypeEnum("type").notNull(),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    valueMinor: bigint("value_minor", { mode: "bigint" }).notNull().default(sql`0`),
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id").notNull(),
    reversalOfId: uuid("reversal_of_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("movements_business_created_idx").on(t.businessId, t.createdAt),
    index("movements_product_warehouse_idx").on(t.productId, t.warehouseId),
    index("movements_reference_idx").on(t.referenceType, t.referenceId),
    uniqueIndex("movements_reversal_uq").on(t.reversalOfId),
  ],
);

export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull().default(sql`0`),
    valueMinor: bigint("value_minor", { mode: "bigint" }).notNull().default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("inventory_balances_uq").on(t.productId, t.warehouseId),
    index("inventory_balances_business_idx").on(t.businessId),
  ],
);

export const inventoryLots = pgTable(
  "inventory_lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "cascade" }),
    sourceMovementId: uuid("source_movement_id").references(() => inventoryMovements.id, {
      onDelete: "set null",
    }),
    qtyReceivedMilli: bigint("qty_received_milli", { mode: "bigint" }).notNull(),
    qtyRemainingMilli: bigint("qty_remaining_milli", { mode: "bigint" }).notNull(),
    valueRemainingMinor: bigint("value_remaining_minor", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("inventory_lots_fifo_idx").on(t.productId, t.warehouseId, t.createdAt)],
);

export const stockTransfers = pgTable("stock_transfers", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  fromWarehouseId: uuid("from_warehouse_id")
    .notNull()
    .references(() => warehouses.id, { onDelete: "restrict" }),
  toWarehouseId: uuid("to_warehouse_id")
    .notNull()
    .references(() => warehouses.id, { onDelete: "restrict" }),
  note: text("note"),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const stocktakingSessions = pgTable("stocktaking_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id, { onDelete: "cascade" }),
  warehouseId: uuid("warehouse_id")
    .notNull()
    .references(() => warehouses.id, { onDelete: "restrict" }),
  scope: text("scope").notNull().default("full"),
  title: text("title").notNull(),
  status: stocktakeStatusEnum("status").notNull().default("draft"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  notes: text("notes"),
});

export const stocktakingItems = pgTable(
  "stocktaking_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => stocktakingSessions.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    expectedQtyMilli: bigint("expected_qty_milli", { mode: "bigint" }).notNull(),
    countedQtyMilli: bigint("counted_qty_milli", { mode: "bigint" }),
    varianceQtyMilli: bigint("variance_qty_milli", { mode: "bigint" }),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull().default(sql`0`),
    varianceValueMinor: bigint("variance_value_minor", { mode: "bigint" }).notNull().default(sql`0`),
  },
  (t) => [uniqueIndex("stocktaking_items_uq").on(t.sessionId, t.productId)],
);

/* ------------------------------------------------------------------- sales */

export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    kind: docKindEnum("kind").notNull().default("sale"),
    invoiceNo: text("invoice_no").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    originalSaleId: uuid("original_sale_id"),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).notNull().default(sql`0`),
    taxMinor: bigint("tax_minor", { mode: "bigint" }).notNull().default(sql`0`),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    costTotalMinor: bigint("cost_total_minor", { mode: "bigint" }).notNull().default(sql`0`),
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
    dueMinor: bigint("due_minor", { mode: "bigint" }).notNull().default(sql`0`),
    paymentType: paymentTypeEnum("payment_type").notNull().default("cash"),
    cashboxId: uuid("cashbox_id").references(() => cashboxes.id, { onDelete: "restrict" }),
    status: docStatusEnum("status").notNull().default("posted"),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key").notNull(),
    clientUuid: text("client_uuid"),
    offlineCreated: boolean("offline_created").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sales_business_invoice_uq").on(t.businessId, t.kind, t.invoiceNo),
    uniqueIndex("sales_business_idem_uq").on(t.businessId, t.idempotencyKey),
    index("sales_business_created_idx").on(t.businessId, t.createdAt),
    index("sales_customer_idx").on(t.businessId, t.customerId),
  ],
);

export const saleItems = pgTable(
  "sale_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => sales.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    qtyBaseMilli: bigint("qty_base_milli", { mode: "bigint" }).notNull(),
    unitPriceMinor: bigint("unit_price_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).notNull().default(sql`0`),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
    costTotalMinor: bigint("cost_total_minor", { mode: "bigint" }).notNull().default(sql`0`),
    priceTier: text("price_tier").notNull().default("retail"),
  },
  (t) => [index("sale_items_sale_idx").on(t.saleId), index("sale_items_product_idx").on(t.productId)],
);

export const purchases = pgTable(
  "purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    kind: purchaseKindEnum("kind").notNull().default("purchase"),
    invoiceNo: text("invoice_no").notNull(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "restrict" }),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id, { onDelete: "restrict" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    originalPurchaseId: uuid("original_purchase_id"),
    subtotalMinor: bigint("subtotal_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).notNull().default(sql`0`),
    extraCostMinor: bigint("extra_cost_minor", { mode: "bigint" }).notNull().default(sql`0`),
    totalMinor: bigint("total_minor", { mode: "bigint" }).notNull(),
    paidMinor: bigint("paid_minor", { mode: "bigint" }).notNull().default(sql`0`),
    dueMinor: bigint("due_minor", { mode: "bigint" }).notNull().default(sql`0`),
    cashboxId: uuid("cashbox_id").references(() => cashboxes.id, { onDelete: "restrict" }),
    status: docStatusEnum("status").notNull().default("posted"),
    notes: text("notes"),
    idempotencyKey: text("idempotency_key").notNull(),
    clientUuid: text("client_uuid"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("purchases_business_invoice_uq").on(t.businessId, t.kind, t.invoiceNo),
    uniqueIndex("purchases_business_idem_uq").on(t.businessId, t.idempotencyKey),
    index("purchases_business_created_idx").on(t.businessId, t.createdAt),
  ],
);

export const purchaseItems = pgTable(
  "purchase_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    purchaseId: uuid("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "restrict" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "restrict" }),
    qtyMilli: bigint("qty_milli", { mode: "bigint" }).notNull(),
    qtyBaseMilli: bigint("qty_base_milli", { mode: "bigint" }).notNull(),
    unitCostMinor: bigint("unit_cost_minor", { mode: "bigint" }).notNull(),
    discountMinor: bigint("discount_minor", { mode: "bigint" }).notNull().default(sql`0`),
    lineTotalMinor: bigint("line_total_minor", { mode: "bigint" }).notNull(),
  },
  (t) => [index("purchase_items_purchase_idx").on(t.purchaseId)],
);

/* ---------------------------------------------------------------- payments */

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    paymentNo: text("payment_no").notNull(),
    direction: paymentDirectionEnum("direction").notNull(),
    customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    method: text("method").notNull().default("cash"),
    cashboxId: uuid("cashbox_id").references(() => cashboxes.id, { onDelete: "restrict" }),
    reference: text("reference"),
    notes: text("notes"),
    journalEntryId: uuid("journal_entry_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payments_business_no_uq").on(t.businessId, t.paymentNo),
    uniqueIndex("payments_business_idem_uq").on(t.businessId, t.idempotencyKey),
    index("payments_customer_idx").on(t.businessId, t.customerId),
    index("payments_supplier_idx").on(t.businessId, t.supplierId),
  ],
);

export const customerAccounts = pgTable(
  "customer_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    entryType: text("entry_type").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_accounts_customer_idx").on(t.customerId, t.createdAt)],
);

export const supplierAccounts = pgTable(
  "supplier_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id, { onDelete: "cascade" }),
    entryType: text("entry_type").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    referenceType: text("reference_type").notNull(),
    referenceId: uuid("reference_id").notNull(),
    journalEntryId: uuid("journal_entry_id"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("supplier_accounts_supplier_idx").on(t.supplierId, t.createdAt)],
);

/* ----------------------------------------------------------- cash/expenses */

export const cashboxes = pgTable(
  "cashboxes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    openingBalanceMinor: bigint("opening_balance_minor", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [index("cashboxes_business_idx").on(t.businessId)],
);

export const cashTransactions = pgTable(
  "cash_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    cashboxId: uuid("cashbox_id")
      .notNull()
      .references(() => cashboxes.id, { onDelete: "restrict" }),
    direction: cashDirectionEnum("direction").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id").notNull(),
    description: text("description"),
    journalEntryId: uuid("journal_entry_id"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cash_transactions_cashbox_idx").on(t.cashboxId, t.createdAt)],
);

export const expenses = pgTable(
  "expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    expenseNo: text("expense_no").notNull(),
    category: text("category").notNull(),
    description: text("description").notNull(),
    amountMinor: bigint("amount_minor", { mode: "bigint" }).notNull(),
    expenseAccountId: uuid("expense_account_id"),
    cashboxId: uuid("cashbox_id")
      .notNull()
      .references(() => cashboxes.id, { onDelete: "restrict" }),
    journalEntryId: uuid("journal_entry_id"),
    reference: text("reference"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("expenses_business_no_uq").on(t.businessId, t.expenseNo),
    uniqueIndex("expenses_business_idem_uq").on(t.businessId, t.idempotencyKey),
    index("expenses_business_date_idx").on(t.businessId, t.paidAt),
  ],
);

/* -------------------------------------------------------------- accounting */

export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    nameAr: text("name_ar").notNull(),
    type: accountTypeEnum("type").notNull(),
    parentId: uuid("parent_id"),
    isSystem: boolean("is_system").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [uniqueIndex("accounts_business_code_uq").on(t.businessId, t.code)],
);

export const journalEntries = pgTable(
  "journal_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    entryNo: text("entry_no").notNull(),
    entryDate: timestamp("entry_date", { withTimezone: true }).notNull().defaultNow(),
    memo: text("memo").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: uuid("source_id"),
    reversalOfId: uuid("reversal_of_id"),
    isReversal: boolean("is_reversal").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("journal_entries_business_no_uq").on(t.businessId, t.entryNo),
    index("journal_entries_business_date_idx").on(t.businessId, t.entryDate),
    index("journal_entries_source_idx").on(t.sourceType, t.sourceId),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "restrict" }),
    debitMinor: bigint("debit_minor", { mode: "bigint" }).notNull().default(sql`0`),
    creditMinor: bigint("credit_minor", { mode: "bigint" }).notNull().default(sql`0`),
    description: text("description"),
  },
  (t) => [index("journal_lines_entry_idx").on(t.entryId), index("journal_lines_account_idx").on(t.accountId)],
);

/* -------------------------------------------------------------- infra docs */

export const invoiceSequences = pgTable(
  "invoice_sequences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    docType: text("doc_type").notNull(),
    prefix: text("prefix").notNull().default(""),
    nextNumber: integer("next_number").notNull().default(1),
  },
  (t) => [uniqueIndex("invoice_sequences_uq").on(t.businessId, t.docType)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_logs_business_idx").on(t.businessId, t.createdAt)],
);

export const syncOperations = pgTable(
  "sync_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    operationId: text("operation_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    type: text("type").notNull(),
    status: syncStatusEnum("status").notNull().default("pending"),
    deviceId: text("device_id"),
    payload: jsonb("payload").notNull(),
    result: jsonb("result"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sync_operations_business_op_uq").on(t.businessId, t.operationId),
    uniqueIndex("sync_operations_business_idem_uq").on(t.businessId, t.idempotencyKey),
    index("sync_operations_status_idx").on(t.businessId, t.status),
  ],
);

export const notificationEvents = pgTable(
  "notification_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    severity: text("severity").notNull().default("info"),
    channel: reminderChannelEnum("channel").notNull().default("in_app"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    titleAr: text("title_ar").notNull(),
    bodyAr: text("body_ar"),
    payload: jsonb("payload"),
    status: notificationStatusEnum("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    index("notifications_business_idx").on(t.businessId, t.createdAt),
    index("notifications_customer_idx").on(t.businessId, t.entityId),
  ],
);

/* ------------------------------------------------ cloud sync and backups */

// Monotonic change feed. `id` doubles as the pull cursor/version so clients can
// request "everything after N" without relying on wall-clock timestamps.
export const syncChanges = pgTable(
  "sync_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // Supabase Auth user id of the account that owns the business.
    userId: uuid("user_id"),
    tableName: text("table_name").notNull(),
    recordId: text("record_id").notNull(),
    operation: text("operation").notNull(),
    payload: jsonb("payload"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    deviceId: text("device_id"),
  },
  (t) => [
    index("sync_changes_business_id_idx").on(t.businessId, t.id),
    index("sync_changes_record_idx").on(t.tableName, t.recordId),
  ],
);

export const syncCursors = pgTable(
  "sync_cursors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    deviceId: text("device_id").notNull(),
    lastChangeId: bigint("last_change_id", { mode: "bigint" }).notNull().default(sql`0`),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("sync_cursors_business_device_uq").on(t.businessId, t.deviceId),
    index("sync_cursors_business_idx").on(t.businessId),
  ],
);

export const cloudBackupSettings = pgTable(
  "cloud_backup_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    autoSync: boolean("auto_sync").notNull().default(true),
    autoBackup: boolean("auto_backup").notNull().default(true),
    backupIntervalHours: integer("backup_interval_hours").notNull().default(24),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastBackupAt: timestamp("last_backup_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("cloud_backup_settings_business_uq").on(t.businessId)],
);

export const cloudBackups = pgTable(
  "cloud_backups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    userId: uuid("user_id"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("manual"),
    status: text("status").notNull().default("ready"),
    formatVersion: integer("format_version").notNull().default(1),
    sizeBytes: bigint("size_bytes", { mode: "bigint" }).notNull().default(sql`0`),
    checksum: text("checksum").notNull(),
    storagePath: text("storage_path"),
    data: jsonb("data"),
    metadata: jsonb("metadata"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    restoredAt: timestamp("restored_at", { withTimezone: true }),
  },
  (t) => [
    index("cloud_backups_business_created_idx").on(t.businessId, t.createdAt),
    index("cloud_backups_user_created_idx").on(t.userId, t.createdAt),
    uniqueIndex("cloud_backups_checksum_uq").on(t.businessId, t.checksum),
  ],
);

/* --------------------------------------------------------------- relations */

export const businessRelations = relations(businesses, ({ many }) => ({
  memberships: many(memberships),
  products: many(products),
}));

export const productRelations = relations(products, ({ one, many }) => ({
  business: one(businesses, { fields: [products.businessId], references: [businesses.id] }),
  baseUnit: one(units, { fields: [products.baseUnitId], references: [units.id] }),
  category: one(productCategories, {
    fields: [products.categoryId],
    references: [productCategories.id],
  }),
  units: many(productUnits),
}));

export const productUnitRelations = relations(productUnits, ({ one }) => ({
  product: one(products, { fields: [productUnits.productId], references: [products.id] }),
  unit: one(units, { fields: [productUnits.unitId], references: [units.id] }),
}));

export const saleRelations = relations(sales, ({ one, many }) => ({
  customer: one(customers, { fields: [sales.customerId], references: [customers.id] }),
  items: many(saleItems),
}));

export const saleItemRelations = relations(saleItems, ({ one }) => ({
  sale: one(sales, { fields: [saleItems.saleId], references: [sales.id] }),
  product: one(products, { fields: [saleItems.productId], references: [products.id] }),
  unit: one(units, { fields: [saleItems.unitId], references: [units.id] }),
}));

export type Business = typeof businesses.$inferSelect;
export type User = typeof users.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductUnit = typeof productUnits.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Supplier = typeof suppliers.$inferSelect;
export type Sale = typeof sales.$inferSelect;
export type Purchase = typeof purchases.$inferSelect;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type JournalEntry = typeof journalEntries.$inferSelect;
export type Account = typeof accounts.$inferSelect;
