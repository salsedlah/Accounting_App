export const CURRENCY = {
  code: "YER",
  symbol: "ر.ي",
  scale: 2,
} as const;

export const ACCOUNT_CODES = {
  cash: "1000",
  bank: "1010",
  receivable: "1100",
  inventory: "1200",
  payable: "2000",
  taxPayable: "2100",
  capital: "3000",
  drawings: "3100",
  retainedEarnings: "3900",
  sales: "4000",
  salesReturns: "4100",
  adjustmentGain: "4200",
  cogs: "5000",
  operatingExpenses: "5100",
  adjustmentLoss: "5200",
} as const;

export type AccountCode = (typeof ACCOUNT_CODES)[keyof typeof ACCOUNT_CODES];

export const SYSTEM_ACCOUNTS: ReadonlyArray<{
  code: string;
  nameAr: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
}> = [
  { code: ACCOUNT_CODES.cash, nameAr: "الصندوق", type: "asset" },
  { code: ACCOUNT_CODES.bank, nameAr: "البنك", type: "asset" },
  { code: ACCOUNT_CODES.receivable, nameAr: "ذمم العملاء (مدينون)", type: "asset" },
  { code: ACCOUNT_CODES.inventory, nameAr: "المخزون", type: "asset" },
  { code: ACCOUNT_CODES.payable, nameAr: "ذمم الموردين (دائنون)", type: "liability" },
  { code: ACCOUNT_CODES.taxPayable, nameAr: "ضريبة مستحقة", type: "liability" },
  { code: ACCOUNT_CODES.capital, nameAr: "رأس مال المالك", type: "equity" },
  { code: ACCOUNT_CODES.drawings, nameAr: "مسحوبات المالك", type: "equity" },
  { code: ACCOUNT_CODES.retainedEarnings, nameAr: "الأرباح المحتجزة", type: "equity" },
  { code: ACCOUNT_CODES.sales, nameAr: "إيرادات المبيعات", type: "revenue" },
  { code: ACCOUNT_CODES.salesReturns, nameAr: "مردودات المبيعات", type: "revenue" },
  { code: ACCOUNT_CODES.adjustmentGain, nameAr: "أرباح فروقات المخزون", type: "revenue" },
  { code: ACCOUNT_CODES.cogs, nameAr: "تكلفة البضاعة المباعة", type: "expense" },
  { code: ACCOUNT_CODES.operatingExpenses, nameAr: "المصروفات التشغيلية", type: "expense" },
  { code: ACCOUNT_CODES.adjustmentLoss, nameAr: "خسائر فروقات المخزون", type: "expense" },
];

export const DOC_PREFIX: Record<string, string> = {
  sale: "S-",
  sale_return: "SR-",
  purchase: "P-",
  purchase_return: "PR-",
  receipt: "RC-",
  supplier_payment: "SP-",
  journal: "JE-",
  expense: "EX-",
  stocktake: "ST-",
};

export const DOC_LABELS: Record<string, string> = {
  sale: "فاتورة بيع",
  sale_return: "مرتجع بيع",
  purchase: "فاتورة شراء",
  purchase_return: "مرتجع شراء",
  receipt: "سند قبض",
  supplier_payment: "سند صرف مورد",
  journal: "قيد يومية",
  expense: "سند مصروف",
  stocktake: "تسوية جرد",
};

export const PAYMENT_METHODS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "cash", label: "نقدي" },
  { value: "bank_transfer", label: "حوالة بنكية" },
  { value: "card", label: "بطاقة" },
  { value: "wallet", label: "محفظة إلكترونية" },
];

export const PERMISSIONS = {
  salesCreate: "sales.create",
  salesRead: "sales.read",
  salesReturn: "sales.return",
  customPrice: "sales.custom_price",
  discounts: "sales.discount",
  purchasesCreate: "purchases.create",
  purchasesRead: "purchases.read",
  productsRead: "products.read",
  productsWrite: "products.write",
  customersRead: "customers.read",
  customersWrite: "customers.write",
  debtsManage: "debts.manage",
  paymentsCreate: "payments.create",
  inventoryRead: "inventory.read",
  inventoryAdjust: "inventory.adjust",
  stocktakingManage: "stocktaking.manage",
  expensesCreate: "expenses.create",
  cashboxManage: "cashbox.manage",
  reportsRead: "reports.read",
  usersManage: "users.manage",
  settingsManage: "settings.manage",
  aiAsk: "ai.ask",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_CATALOG: ReadonlyArray<{
  key: Permission;
  labelAr: string;
  groupAr: string;
}> = [
  { key: PERMISSIONS.salesCreate, labelAr: "إنشاء المبيعات", groupAr: "المبيعات" },
  { key: PERMISSIONS.salesRead, labelAr: "عرض المبيعات", groupAr: "المبيعات" },
  { key: PERMISSIONS.salesReturn, labelAr: "مرتجع مبيعات", groupAr: "المبيعات" },
  { key: PERMISSIONS.customPrice, labelAr: "تعديل الأسعار", groupAr: "المبيعات" },
  { key: PERMISSIONS.discounts, labelAr: "تطبيق الخصومات", groupAr: "المبيعات" },
  { key: PERMISSIONS.purchasesCreate, labelAr: "إنشاء المشتريات", groupAr: "المشتريات" },
  { key: PERMISSIONS.purchasesRead, labelAr: "عرض المشتريات", groupAr: "المشتريات" },
  { key: PERMISSIONS.productsRead, labelAr: "عرض المنتجات", groupAr: "المنتجات" },
  { key: PERMISSIONS.productsWrite, labelAr: "إدارة المنتجات", groupAr: "المنتجات" },
  { key: PERMISSIONS.customersRead, labelAr: "عرض العملاء", groupAr: "العملاء" },
  { key: PERMISSIONS.customersWrite, labelAr: "إدارة العملاء", groupAr: "العملاء" },
  { key: PERMISSIONS.debtsManage, labelAr: "إدارة الديون", groupAr: "العملاء" },
  { key: PERMISSIONS.paymentsCreate, labelAr: "تسجيل الدفعات", groupAr: "الخزينة" },
  { key: PERMISSIONS.inventoryRead, labelAr: "عرض المخزون", groupAr: "المخزون" },
  { key: PERMISSIONS.inventoryAdjust, labelAr: "تعديل المخزون", groupAr: "المخزون" },
  { key: PERMISSIONS.stocktakingManage, labelAr: "إدارة الجرد", groupAr: "المخزون" },
  { key: PERMISSIONS.expensesCreate, labelAr: "تسجيل المصروفات", groupAr: "الخزينة" },
  { key: PERMISSIONS.cashboxManage, labelAr: "إدارة الصندوق", groupAr: "الخزينة" },
  { key: PERMISSIONS.reportsRead, labelAr: "عرض التقارير", groupAr: "التقارير" },
  { key: PERMISSIONS.usersManage, labelAr: "إدارة المستخدمين", groupAr: "الإدارة" },
  { key: PERMISSIONS.settingsManage, labelAr: "إعدادات النظام", groupAr: "الإدارة" },
  { key: PERMISSIONS.aiAsk, labelAr: "استخدام المساعد الذكي", groupAr: "الإدارة" },
];

const ALL = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<string, ReadonlyArray<Permission>> = {
  owner: ALL,
  accountant: [
    PERMISSIONS.salesCreate,
    PERMISSIONS.salesRead,
    PERMISSIONS.salesReturn,
    PERMISSIONS.customPrice,
    PERMISSIONS.discounts,
    PERMISSIONS.purchasesCreate,
    PERMISSIONS.purchasesRead,
    PERMISSIONS.productsRead,
    PERMISSIONS.customersRead,
    PERMISSIONS.customersWrite,
    PERMISSIONS.debtsManage,
    PERMISSIONS.paymentsCreate,
    PERMISSIONS.inventoryRead,
    PERMISSIONS.inventoryAdjust,
    PERMISSIONS.stocktakingManage,
    PERMISSIONS.expensesCreate,
    PERMISSIONS.cashboxManage,
    PERMISSIONS.reportsRead,
    PERMISSIONS.aiAsk,
  ],
  cashier: [
    PERMISSIONS.salesCreate,
    PERMISSIONS.salesRead,
    PERMISSIONS.productsRead,
    PERMISSIONS.customersRead,
    PERMISSIONS.paymentsCreate,
    PERMISSIONS.aiAsk,
  ],
  inventory_manager: [
    PERMISSIONS.productsRead,
    PERMISSIONS.productsWrite,
    PERMISSIONS.purchasesCreate,
    PERMISSIONS.purchasesRead,
    PERMISSIONS.inventoryRead,
    PERMISSIONS.inventoryAdjust,
    PERMISSIONS.stocktakingManage,
    PERMISSIONS.reportsRead,
    PERMISSIONS.aiAsk,
  ],
  viewer: [
    PERMISSIONS.salesRead,
    PERMISSIONS.purchasesRead,
    PERMISSIONS.productsRead,
    PERMISSIONS.customersRead,
    PERMISSIONS.inventoryRead,
    PERMISSIONS.reportsRead,
  ],
};

export const ROLE_LABELS: Record<string, string> = {
  owner: "المالك / المدير",
  accountant: "محاسب",
  cashier: "كاشير",
  inventory_manager: "مدير مخزون",
  viewer: "مشاهد",
};

export function can(role: string, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permission);
}

export const MOVEMENT_LABELS: Record<string, string> = {
  opening: "رصيد افتتاحي",
  purchase: "شراء",
  purchase_return: "مرتجع شراء",
  sale: "بيع",
  sale_return: "مرتجع بيع",
  adjustment: "تسوية",
  transfer_in: "تحويل وارد",
  transfer_out: "تحويل صادر",
  stocktake: "جرد",
  damage: "تالف",
};
