export type AppModule = {
  id: string;
  title: string;
  endpoint: string;
  permission?: string;
  collection?: string;
};

export const APP_MODULES: AppModule[] = [
  { id: "pos", title: "نقطة البيع", endpoint: "/api/pos/data", permission: "sales.create" },
  { id: "products", title: "المنتجات", endpoint: "/api/products", permission: "products.read", collection: "products" },
  { id: "inventory", title: "المخزون", endpoint: "/api/inventory", permission: "inventory.read" },
  { id: "purchases", title: "المشتريات", endpoint: "/api/purchases", permission: "purchases.read", collection: "purchases" },
  { id: "customers", title: "العملاء", endpoint: "/api/customers", permission: "customers.read", collection: "customers" },
  { id: "debts", title: "ديون العملاء", endpoint: "/api/debts", permission: "debts.manage" },
  { id: "suppliers", title: "الموردون", endpoint: "/api/suppliers", permission: "purchases.read", collection: "suppliers" },
  { id: "supplier-debts", title: "ديون الموردين", endpoint: "/api/suppliers", permission: "purchases.read", collection: "suppliers" },
  { id: "expenses", title: "المصروفات", endpoint: "/api/expenses", permission: "expenses.create", collection: "expenses" },
  { id: "cashbox", title: "الصندوق", endpoint: "/api/cashbox", permission: "cashbox.manage" },
  { id: "invoices", title: "الفواتير", endpoint: "/api/invoices", permission: "sales.read", collection: "documents" },
  { id: "stocktaking", title: "الجرد", endpoint: "/api/stocktaking", permission: "stocktaking.manage", collection: "sessions" },
  { id: "reports", title: "التقارير", endpoint: "/api/reports", permission: "reports.read" },
  { id: "users", title: "المستخدمون", endpoint: "/api/users", permission: "users.manage" },
  { id: "settings", title: "الإعدادات", endpoint: "/api/settings", permission: "settings.manage" },
  { id: "ai", title: "المساعد الذكي", endpoint: "/api/ai/ask", permission: "ai.ask" },
];

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: [
    "sales.create", "sales.read", "sales.return", "sales.custom_price", "sales.discount",
    "purchases.create", "purchases.read", "products.read", "products.write",
    "customers.read", "customers.write", "debts.manage", "payments.create",
    "inventory.read", "inventory.adjust", "stocktaking.manage", "expenses.create",
    "cashbox.manage", "reports.read", "users.manage", "settings.manage", "ai.ask",
  ],
  accountant: [
    "sales.create", "sales.read", "sales.return", "sales.custom_price", "sales.discount",
    "purchases.create", "purchases.read", "products.read", "customers.read", "customers.write",
    "debts.manage", "payments.create", "inventory.read", "inventory.adjust",
    "stocktaking.manage", "expenses.create", "cashbox.manage", "reports.read", "ai.ask",
  ],
  cashier: ["sales.create", "sales.read", "products.read", "customers.read", "payments.create", "ai.ask"],
  inventory_manager: [
    "products.read", "products.write", "purchases.create", "purchases.read",
    "inventory.read", "inventory.adjust", "stocktaking.manage", "reports.read", "ai.ask",
  ],
  viewer: ["sales.read", "purchases.read", "products.read", "customers.read", "inventory.read", "reports.read"],
};

export const FIELD_LABELS: Record<string, string> = {
  name: "الاسم",
  email: "البريد الإلكتروني",
  phone: "الهاتف",
  sku: "رمز المنتج",
  barcode: "الباركود",
  qtyMilli: "الكمية",
  totalMinor: "الإجمالي",
  dueMinor: "المتبقي",
  balanceMinor: "الرصيد",
  expectedBalanceMinor: "الرصيد المتوقع",
  invoiceNo: "رقم الفاتورة",
  docNo: "رقم المستند",
  status: "الحالة",
  createdAt: "تاريخ الإنشاء",
  occurredAt: "التاريخ",
  retailPriceMinor: "سعر البيع",
  wholesalePriceMinor: "سعر الجملة",
  minStockMilli: "حد التنبيه",
  categoryName: "التصنيف",
  party: "الطرف",
  kind: "النوع",
  currency: "العملة",
  lowStockCount: "منتجات منخفضة المخزون",
  invoiceCount: "عدد الفواتير",
};
