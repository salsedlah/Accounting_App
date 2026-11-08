class AppModule {
  const AppModule(
    this.id,
    this.title,
    this.endpoint,
    this.permission, {
    this.collection,
  });
  final String id;
  final String title;
  final String endpoint;
  final String? permission;
  final String? collection;
}

const appModules = <AppModule>[
  AppModule('pos', 'نقطة البيع', '/api/pos/data', 'sales.create'),
  AppModule(
    'products',
    'المنتجات',
    '/api/products',
    'products.read',
    collection: 'products',
  ),
  AppModule('inventory', 'المخزون', '/api/inventory', 'inventory.read'),
  AppModule(
    'purchases',
    'المشتريات',
    '/api/purchases',
    'purchases.read',
    collection: 'purchases',
  ),
  AppModule(
    'customers',
    'العملاء',
    '/api/customers',
    'customers.read',
    collection: 'customers',
  ),
  AppModule('debts', 'ديون العملاء', '/api/debts', 'debts.manage'),
  AppModule(
    'suppliers',
    'الموردون',
    '/api/suppliers',
    'purchases.read',
    collection: 'suppliers',
  ),
  AppModule(
    'supplier-debts',
    'ديون الموردين',
    '/api/suppliers',
    'purchases.read',
    collection: 'suppliers',
  ),
  AppModule(
    'expenses',
    'المصروفات',
    '/api/expenses',
    'expenses.create',
    collection: 'expenses',
  ),
  AppModule('cashbox', 'الصندوق', '/api/cashbox', 'cashbox.manage'),
  AppModule(
    'invoices',
    'الفواتير',
    '/api/invoices',
    'sales.read',
    collection: 'documents',
  ),
  AppModule(
    'stocktaking',
    'الجرد',
    '/api/stocktaking',
    'stocktaking.manage',
    collection: 'sessions',
  ),
  AppModule('reports', 'التقارير', '/api/reports', 'reports.read'),
  AppModule('users', 'المستخدمون', '/api/users', 'users.manage'),
  AppModule('settings', 'الإعدادات', '/api/settings', 'settings.manage'),
  AppModule('ai', 'المساعد الذكي', '/api/ai/ask', 'ai.ask'),
];

const rolePermissions = <String, Set<String>>{
  'owner': {
    'sales.create',
    'sales.read',
    'sales.return',
    'sales.custom_price',
    'sales.discount',
    'purchases.create',
    'purchases.read',
    'products.read',
    'products.write',
    'customers.read',
    'customers.write',
    'debts.manage',
    'payments.create',
    'inventory.read',
    'inventory.adjust',
    'stocktaking.manage',
    'expenses.create',
    'cashbox.manage',
    'reports.read',
    'users.manage',
    'settings.manage',
    'ai.ask',
  },
  'accountant': {
    'sales.create',
    'sales.read',
    'sales.return',
    'sales.custom_price',
    'sales.discount',
    'purchases.create',
    'purchases.read',
    'products.read',
    'customers.read',
    'customers.write',
    'debts.manage',
    'payments.create',
    'inventory.read',
    'inventory.adjust',
    'stocktaking.manage',
    'expenses.create',
    'cashbox.manage',
    'reports.read',
    'ai.ask',
  },
  'cashier': {
    'sales.create',
    'sales.read',
    'products.read',
    'customers.read',
    'payments.create',
    'ai.ask',
  },
  'inventory_manager': {
    'products.read',
    'products.write',
    'purchases.create',
    'purchases.read',
    'inventory.read',
    'inventory.adjust',
    'stocktaking.manage',
    'reports.read',
    'ai.ask',
  },
  'viewer': {
    'sales.read',
    'purchases.read',
    'products.read',
    'customers.read',
    'inventory.read',
    'reports.read',
  },
};

List<AppModule> modulesForRole(String? role) {
  final permissions = rolePermissions[role] ?? <String>{};
  return appModules
      .where((m) => m.permission == null || permissions.contains(m.permission))
      .toList();
}

String fieldLabel(String key) {
  const labels = <String, String>{
    'name': 'الاسم',
    'email': 'البريد الإلكتروني',
    'phone': 'الهاتف',
    'sku': 'رمز المنتج',
    'barcode': 'الباركود',
    'qtyMilli': 'الكمية',
    'totalMinor': 'الإجمالي',
    'dueMinor': 'المتبقي',
    'balanceMinor': 'الرصيد',
    'expectedBalanceMinor': 'الرصيد المتوقع',
    'invoiceNo': 'رقم الفاتورة',
    'docNo': 'رقم المستند',
    'status': 'الحالة',
    'createdAt': 'تاريخ الإنشاء',
    'occurredAt': 'التاريخ',
    'retailPriceMinor': 'سعر البيع',
    'wholesalePriceMinor': 'سعر الجملة',
    'minStockMilli': 'حد التنبيه',
    'categoryName': 'التصنيف',
    'party': 'الطرف',
    'kind': 'النوع',
    'currency': 'العملة',
    'invoiceCount': 'عدد الفواتير',
    '_localStatus': 'حالة المزامنة',
    '_localCreatedAt': 'وقت الحفظ على الجهاز',
  };
  return labels[key] ?? key;
}
