import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:share_plus/share_plus.dart';

import 'api_service.dart';
import 'app_config.dart';
import 'local_store.dart';
import 'models.dart';

void main() => runApp(const HisabApp());

const brand = Color(0xff176b57);
const ink = Color(0xff172522);
const muted = Color(0xff697773);
const paper = Color(0xfff3f6f5);
const border = Color(0xffdce5e1);
const fieldNames = <String, String>{
  'sales': 'المبيعات',
  'products': 'المنتجات',
  'pnl': 'الأرباح والخسائر',
  'inventory': 'المخزون',
  'trial': 'ميزان المراجعة',
  'balance': 'الميزانية',
  'cashflow': 'التدفق النقدي',
  'expenses': 'المصروفات',
  'lowstock': 'المخزون المنخفض',
  'documents': 'المستندات',
};

class HisabApp extends StatefulWidget {
  const HisabApp({super.key});
  @override
  State<HisabApp> createState() => _HisabAppState();
}

class _HisabAppState extends State<HisabApp> with WidgetsBindingObserver {
  final store = LocalStore.instance;
  late final api = ApiService(store);
  StreamSubscription<List<ConnectivityResult>>? networkSubscription;
  Timer? reachabilityTimer;
  Map<String, dynamic>? session;
  bool ready = false, online = false, syncing = false;
  bool checkingConnection = false, warmingCache = false;
  int pending = 0;
  DateTime? lastSessionCheck;
  final syncRevision = ValueNotifier<int>(0);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _boot();
    networkSubscription = Connectivity().onConnectivityChanged.listen(
          (_) => unawaited(_refreshConnectivity()),
        );
    reachabilityTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => unawaited(_refreshConnectivity()),
    );
  }

  Future<void> _boot() async {
    try {
      await api.initialize();
      final cachedSession = await store.session;
      final token = await store.token;
      if (cachedSession != null && token != null) {
        session = cachedSession;
        api.setToken(token);
      }
      pending = await store.pendingCount;
      await _refreshConnectivity();
    } finally {
      if (mounted) setState(() => ready = true);
    }
  }

  Future<void> _refreshConnectivity() async {
    if (checkingConnection) return;
    checkingConnection = true;
    try {
      final previous = online;
      final states = await Connectivity().checkConnectivity();
      final hasNetwork = states.any((item) => item != ConnectivityResult.none);
      final reachable = hasNetwork && await api.checkServer();
      if (!mounted) return;
      if (reachable) {
        await _verifyOnlineSession();
      } else {
        await _applyOfflineSessionPolicy();
      }
      if (!mounted) return;
      if (online != reachable) setState(() => online = reachable);
      if (reachable && !previous && session != null) {
        unawaited(_sync());
        unawaited(_warmCache(session!['role']?.toString()));
      }
    } finally {
      checkingConnection = false;
    }
  }

  Future<void> _verifyOnlineSession() async {
    if (session == null) return;
    final now = DateTime.now().toUtc();
    if (lastSessionCheck != null &&
        now.difference(lastSessionCheck!) < const Duration(minutes: 10)) {
      return;
    }
    lastSessionCheck = now;
    try {
      final confirmed = await api.currentSession();
      if (confirmed == null) return;
      final token = await store.token;
      if (token == null) return;
      session = confirmed;
      await store.saveSession(token, confirmed);
      await store.markSessionVerified();
      if (mounted) setState(() {});
    } on ApiException catch (error) {
      if (error.status == 401) {
        await store.clearSession();
        api.setToken(null);
        if (mounted) setState(() => session = null);
      }
    } catch (_) {
      // Transient failures are retried by the connectivity timer.
    }
  }

  Future<void> _applyOfflineSessionPolicy() async {
    if (session == null) return;
    final policy = AppConfig.offlineAuthPolicy;
    final allowed = policy.allowsOfflineSession &&
        await store.canUseOfflineSession(AppConfig.offlineSessionDuration);
    if (allowed || !mounted) return;
    // Keep the cached profile and credentials in secure storage so the user
    // can still sign in offline while the server is unreachable.
    api.setToken(null);
    setState(() => session = null);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      unawaited(_refreshConnectivity());
    }
  }

  Future<void> _warmCache(String? role) async {
    if (!online || warmingCache) return;
    warmingCache = true;
    try {
      final endpoints = <String>{
        for (final module in modulesForRole(role))
          if (!{'ai', 'pos', 'reports'}.contains(module.id)) module.endpoint,
        if (rolePermissions[role]?.contains('sales.create') == true)
          '/api/pos/data',
        '/api/lookups',
        '/api/catalog',
      };
      for (final endpoint in endpoints) {
        try {
          await api.getCached(endpoint);
        } catch (_) {
          // Keep caching other permitted sections if one endpoint is unavailable.
        }
      }
      if (rolePermissions[role]?.contains('reports.read') == true) {
        try {
          await api.getCached('/api/reports?type=sales');
        } catch (_) {}
      }
    } finally {
      warmingCache = false;
    }
  }

  Future<void> _sync() async {
    if (!online || session == null || syncing) return;
    setState(() => syncing = true);
    try {
      final result = await api.sync();
      await store.markSessionVerified();
      pending = await store.pendingCount;
      if (mounted && result.failed > 0) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              'تمت مزامنة ${result.done} وبقيت ${result.failed} عملية.',
            ),
          ),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('تعذرت المزامنة: $error')));
      }
    } finally {
      if (mounted) {
        setState(() {
          syncing = false;
          syncRevision.value++;
        });
      }
    }
  }

  Future<void> _login(String email, String password) async {
    final normalizedEmail = email.trim().toLowerCase();
    try {
      final result =
          await api.login(normalizedEmail, password) as Map<String, dynamic>;
      final token = result['token']?.toString();
      final details = result['session'];
      if (token == null || details is! Map) {
        throw Exception('استجابة الدخول لا تحتوي جلسة صالحة.');
      }
      session = Map<String, dynamic>.from(details);
      await store.saveSession(token, session!);
      await store.markSessionVerified();
      await store.saveOfflineCredentials(normalizedEmail, password);
      api.setToken(token);
      online = true;
      lastSessionCheck = DateTime.now().toUtc();
      unawaited(_warmCache(session!['role']?.toString()));
      pending = await store.pendingCount;
      if (mounted) setState(() {});
    } catch (error) {
      if (!ApiService.canUseOfflineFallback(error)) rethrow;
      await _offlineLogin(normalizedEmail, password);
    }
  }

  Future<void> _offlineLogin(String email, String password) async {
    if (!AppConfig.offlineAuthPolicy.allowsOfflinePasswordLogin) {
      throw Exception(
        'تسجيل الدخول دون اتصال غير مسموح في هذه النسخة. اتصل بالإنترنت.',
      );
    }
    final cachedSession = await store.session;
    final token = await store.token;
    if (cachedSession == null || token == null) {
      throw Exception(
        'لا توجد جلسة محفوظة على هذا الهاتف. سجّل الدخول مرة واحدة عبر الإنترنت أولاً.',
      );
    }
    final cachedEmail =
        cachedSession['email']?.toString().trim().toLowerCase() ?? '';
    if (cachedEmail != email) {
      throw Exception(
        'البريد الإلكتروني لا يطابق الحساب المحفوظ على هذا الهاتف. اتصل بالإنترنت لتسجيل حساب آخر.',
      );
    }
    if (!await store.canUseOfflineCredentials(
      AppConfig.offlineCredentialDuration,
    )) {
      throw Exception(
        'انتهت مدة صلاحية الدخول دون اتصال. اتصل بالإنترنت لتجديد الجلسة.',
      );
    }
    if (!await store.verifyOfflineCredentials(email, password)) {
      throw Exception('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
    }
    session = Map<String, dynamic>.from(cachedSession);
    api.setToken(token);
    online = false;
    pending = await store.pendingCount;
    if (mounted) setState(() {});
  }

  Future<void> _logout() async {
    await store.clearSession();
    await store.clearOfflineCredentials();
    api.setToken(null);
    lastSessionCheck = null;
    if (mounted) setState(() => session = null);
  }

  @override
  void dispose() {
    networkSubscription?.cancel();
    reachabilityTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    syncRevision.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'حساب',
        theme: ThemeData(
          useMaterial3: true,
          colorScheme: ColorScheme.fromSeed(seedColor: brand),
          scaffoldBackgroundColor: paper,
          fontFamily: 'Roboto',
        ),
        builder: (context, child) => Directionality(
          textDirection: TextDirection.rtl,
          child: child ?? const SizedBox(),
        ),
        home: !ready
            ? const LoadingPage()
            : session == null
                ? LoginPage(api: api, onLogin: _login)
                : HomePage(
                    session: session!,
                    api: api,
                    online: online,
                    pending: pending,
                    syncing: syncing,
                    syncRevision: syncRevision,
                    onSync: _sync,
                    onLogout: _logout,
                    onPendingChanged: () async {
                      pending = await store.pendingCount;
                      syncRevision.value++;
                      if (mounted) setState(() {});
                    },
                  ),
      );
}

class LoadingPage extends StatelessWidget {
  const LoadingPage({super.key});
  @override
  Widget build(BuildContext context) => const Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              CircularProgressIndicator(),
              SizedBox(height: 12),
              Text('جارٍ فتح البيانات المحلية...'),
            ],
          ),
        ),
      );
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.api, required this.onLogin});
  final ApiService api;
  final Future<void> Function(String, String) onLogin;
  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final email = TextEditingController(),
      password = TextEditingController(),
      server = TextEditingController();
  bool busy = false, showServer = false;
  String error = '';
  @override
  void initState() {
    super.initState();
    server.text = widget.api.baseUrl;
    showServer = widget.api.canEditServer && !widget.api.hasBaseUrl;
    error = widget.api.configurationError ?? '';
  }

  @override
  void dispose() {
    email.dispose();
    password.dispose();
    server.dispose();
    super.dispose();
  }

  Future<void> submit() async {
    setState(() {
      busy = true;
      error = '';
    });
    try {
      if (widget.api.canEditServer && showServer) {
        await widget.api.setBaseUrl(server.text);
      }
      await widget.onLogin(email.text.trim(), password.text);
    } catch (e) {
      setState(() {
        error = e is SocketException || e is TimeoutException
            ? 'تعذر الوصول إلى خادم API. تحقق من رابط HTTPS والاتصال بالإنترنت.'
            : e.toString();
      });
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: SafeArea(
          child: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 480),
                child: Card(
                  elevation: 0,
                  child: Padding(
                    padding: const EdgeInsets.all(22),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Icon(
                          Icons.storefront_rounded,
                          color: brand,
                          size: 52,
                        ),
                        const SizedBox(height: 8),
                        const Text(
                          'حساب',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 27,
                            fontWeight: FontWeight.bold,
                            color: ink,
                          ),
                        ),
                        const Text(
                          'تطبيق المحاسبة وإدارة النشاط',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: muted),
                        ),
                        const SizedBox(height: 24),
                        if (!widget.api.hasBaseUrl)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 12),
                            child: Text(
                              widget.api.canEditServer
                                  ? 'أدخل رابط API المنشور لإجراء أول تسجيل دخول. بعد ذلك يمكن الدخول دون اتصال من هذا الهاتف.'
                                  : 'لم يتم ضبط رابط API في هذه النسخة. تواصل مع الدعم أو استخدم حساباً سبق تسجيل دخوله على هذا الهاتف.',
                              style: const TextStyle(color: muted),
                            ),
                          ),
                        if (showServer)
                          TextField(
                            controller: server,
                            textDirection: TextDirection.ltr,
                            decoration: const InputDecoration(
                              labelText: 'رابط API المنشور',
                              hintText: 'https://api.example.com',
                              border: OutlineInputBorder(),
                            ),
                          ),
                        TextField(
                          controller: email,
                          keyboardType: TextInputType.emailAddress,
                          textDirection: TextDirection.ltr,
                          decoration: const InputDecoration(
                            labelText: 'البريد الإلكتروني',
                            border: OutlineInputBorder(),
                          ),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: password,
                          obscureText: true,
                          textDirection: TextDirection.ltr,
                          decoration: const InputDecoration(
                            labelText: 'كلمة المرور',
                            border: OutlineInputBorder(),
                          ),
                          onSubmitted: (_) => submit(),
                        ),
                        if (error.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 12),
                            child: Text(
                              error,
                              style: const TextStyle(color: Colors.red),
                            ),
                          ),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: busy ? null : submit,
                          child: Text(
                            busy ? 'جارٍ تسجيل الدخول...' : 'تسجيل الدخول',
                          ),
                        ),
                        if (AppConfig
                            .offlineAuthPolicy.allowsOfflinePasswordLogin)
                          const Padding(
                            padding: EdgeInsets.only(top: 10),
                            child: Text(
                              'بعد أول تسجيل دخول ناجح يمكنك الدخول دون اتصال باستخدام بيانات الحساب المحفوظة على هذا الهاتف.',
                              textAlign: TextAlign.center,
                              style: TextStyle(color: muted, fontSize: 12),
                            ),
                          ),
                        if (widget.api.canEditServer)
                          TextButton(
                            onPressed: () =>
                                setState(() => showServer = !showServer),
                            child: Text(
                              showServer
                                  ? 'إخفاء إعداد رابط API'
                                  : 'إعداد رابط API',
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
}

class HomePage extends StatelessWidget {
  const HomePage({
    super.key,
    required this.session,
    required this.api,
    required this.online,
    required this.pending,
    required this.syncing,
    required this.syncRevision,
    required this.onSync,
    required this.onLogout,
    required this.onPendingChanged,
  });
  final Map<String, dynamic> session;
  final ApiService api;
  final bool online, syncing;
  final int pending;
  final ValueListenable<int> syncRevision;
  final Future<void> Function() onSync, onPendingChanged;
  final Future<void> Function() onLogout;
  @override
  Widget build(BuildContext context) {
    final modules = modulesForRole(session['role']?.toString());
    return Scaffold(
      appBar: AppBar(
        title: const Text('حساب'),
        actions: [
          IconButton(
            onPressed: () => Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => SettingsPage(
                  api: api,
                  onLogout: onLogout,
                  online: online,
                  canManageServerBackup: session['role'] == 'owner',
                  onLocalDataChanged: onPendingChanged,
                ),
              ),
            ),
            icon: const Icon(Icons.settings_outlined),
            tooltip: 'الإعدادات',
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            color: const Color(0xff123f35),
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'مرحباً ${session['name'] ?? ''}',
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 21,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                  Text(
                    '${session['businessName'] ?? ''}',
                    style: const TextStyle(color: Color(0xffc5e0d7)),
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Icon(
                        Icons.circle,
                        size: 10,
                        color:
                            online ? Colors.greenAccent : Colors.orangeAccent,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          online
                              ? 'متصل بالخادم'
                              : 'دون اتصال — البيانات المخزنة متاحة',
                          style: const TextStyle(color: Colors.white),
                        ),
                      ),
                    ],
                  ),
                  if (pending > 0) ...[
                    const SizedBox(height: 12),
                    Text(
                      '$pending عملية بانتظار المزامنة',
                      style: const TextStyle(color: Colors.white),
                    ),
                    const SizedBox(height: 8),
                    OutlinedButton(
                      onPressed: !online || syncing ? null : () => onSync(),
                      child: Text(syncing ? 'جارٍ...' : 'مزامنة الآن'),
                    ),
                  ],
                ],
              ),
            ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 10),
            child: Text(
              'أقسام التطبيق',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17),
            ),
          ),
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: modules.length,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              crossAxisSpacing: 10,
              mainAxisSpacing: 10,
              childAspectRatio: 1.48,
            ),
            itemBuilder: (context, index) {
              final module = modules[index];
              return Card(
                child: InkWell(
                  borderRadius: BorderRadius.circular(16),
                  onTap: () => Navigator.push(
                    context,
                    MaterialPageRoute(
                      builder: (_) => module.id == 'pos'
                          ? PosPage(api: api, onSaved: onPendingChanged)
                          : module.id == 'ai'
                              ? AssistantPage(api: api)
                              : DataPage(
                                  module: module,
                                  api: api,
                                  online: online,
                                  syncRevision: syncRevision,
                                  onPendingChanged: onPendingChanged,
                                ),
                    ),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(_moduleIcon(module.id), color: brand, size: 27),
                        const SizedBox(height: 8),
                        Text(
                          module.title,
                          textAlign: TextAlign.center,
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ],
      ),
    );
  }
}

IconData _moduleIcon(String id) => switch (id) {
      'pos' => Icons.point_of_sale,
      'products' => Icons.inventory_2_outlined,
      'inventory' => Icons.warehouse_outlined,
      'purchases' => Icons.shopping_cart_outlined,
      'customers' => Icons.people_alt_outlined,
      'debts' => Icons.request_quote_outlined,
      'suppliers' || 'supplier-debts' => Icons.local_shipping_outlined,
      'expenses' => Icons.money_off_csred_outlined,
      'cashbox' => Icons.account_balance_wallet_outlined,
      'invoices' => Icons.receipt_long,
      'stocktaking' => Icons.fact_check_outlined,
      'reports' => Icons.bar_chart,
      'users' => Icons.manage_accounts,
      'settings' => Icons.settings,
      _ => Icons.auto_awesome,
    };

class DataPage extends StatefulWidget {
  const DataPage({
    super.key,
    required this.module,
    required this.api,
    required this.online,
    required this.syncRevision,
    required this.onPendingChanged,
  });
  final AppModule module;
  final ApiService api;
  final bool online;
  final ValueListenable<int> syncRevision;
  final Future<void> Function() onPendingChanged;
  @override
  State<DataPage> createState() => _DataPageState();
}

class _DataPageState extends State<DataPage> {
  CachedData? result;
  bool loading = true;
  String error = '', search = '', reportType = 'sales', from = '', to = '';
  List<Map<String, dynamic>> localPending = [];
  Future<void> load() async {
    setState(() {
      loading = true;
      error = '';
    });
    var endpoint = widget.module.endpoint;
    if (widget.module.id == 'reports') {
      endpoint =
          '/api/reports?type=$reportType${from.isNotEmpty ? '&from=$from' : ''}${to.isNotEmpty ? '&to=$to' : ''}';
    }
    try {
      localPending = await widget.api.pendingForModule(widget.module.id);
    } catch (_) {
      localPending = [];
    }
    try {
      result = await widget.api.getCached(endpoint);
    } catch (e) {
      error = localPending.isEmpty ? e.toString() : '';
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  void initState() {
    super.initState();
    widget.syncRevision.addListener(_refreshAfterSync);
    load();
  }

  void _refreshAfterSync() {
    if (mounted) load();
  }

  @override
  void dispose() {
    widget.syncRevision.removeListener(_refreshAfterSync);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: Text(widget.module.title),
          actions: [
            if (!{'reports', 'invoices'}.contains(widget.module.id))
              IconButton(
                onPressed: () async {
                  final saved = await Navigator.push<bool>(
                    context,
                    MaterialPageRoute(
                      builder: (_) => CreatePage(
                        module: widget.module,
                        api: widget.api,
                        onPendingChanged: widget.onPendingChanged,
                      ),
                    ),
                  );
                  if (saved == true) load();
                },
                icon: const Icon(Icons.add),
              ),
          ],
        ),
        body: Column(
          children: [
            if (widget.module.id == 'reports')
              Padding(
                padding: const EdgeInsets.all(12),
                child: Column(
                  children: [
                    DropdownButtonFormField<String>(
                      initialValue: reportType,
                      items: fieldNames.entries
                          .map(
                            (e) => DropdownMenuItem(
                              value: e.key,
                              child: Text(e.value),
                            ),
                          )
                          .toList(),
                      onChanged: (v) {
                        if (v != null) setState(() => reportType = v);
                      },
                      decoration:
                          const InputDecoration(labelText: 'نوع التقرير'),
                    ),
                    Row(
                      children: [
                        Expanded(
                          child: TextField(
                            decoration: const InputDecoration(
                              labelText: 'من YYYY-MM-DD',
                            ),
                            onChanged: (v) => from = v,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: TextField(
                            decoration: const InputDecoration(
                              labelText: 'إلى YYYY-MM-DD',
                            ),
                            onChanged: (v) => to = v,
                          ),
                        ),
                      ],
                    ),
                    Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton(
                        onPressed: load,
                        child: const Text('تطبيق الفترة'),
                      ),
                    ),
                  ],
                ),
              ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
              child: TextField(
                textAlign: TextAlign.right,
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'بحث في البيانات',
                  border: OutlineInputBorder(),
                ),
                onChanged: (v) => setState(() => search = v),
              ),
            ),
            if (result?.cached == true)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(
                  'بيانات محفوظة محلياً · ${result?.updatedAt ?? ''}',
                  style: const TextStyle(color: muted),
                ),
              ),
            if (error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(error, style: const TextStyle(color: Colors.red)),
              ),
            if (loading && result == null)
              const Expanded(child: Center(child: CircularProgressIndicator()))
            else
              Expanded(
                child: RefreshIndicator(
                  onRefresh: load,
                  child: _DataSections(
                    data: result?.data,
                    search: search,
                    module: widget.module,
                    api: widget.api,
                    localPending: localPending,
                  ),
                ),
              ),
          ],
        ),
      );
}

class _DataSections extends StatelessWidget {
  const _DataSections({
    required this.data,
    required this.search,
    required this.module,
    required this.api,
    required this.localPending,
  });
  final dynamic data;
  final String search;
  final AppModule module;
  final ApiService api;
  final List<Map<String, dynamic>> localPending;
  @override
  Widget build(BuildContext context) {
    final sections = <({String title, List<Map<String, dynamic>> rows})>[];
    if (data is List) {
      sections.add((
        title: module.title,
        rows: data
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList(),
      ));
    }
    if (data is Map) {
      final map = Map<String, dynamic>.from(data);
      if (module.collection != null && map[module.collection] is List) {
        sections.add((
          title: module.title,
          rows: (map[module.collection] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList(),
        ));
      } else {
        for (final entry in map.entries.where((e) => e.value is List)) {
          sections.add((
            title: fieldLabel(entry.key),
            rows: (entry.value as List)
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList(),
          ));
        }
      }
    }
    if (localPending.isNotEmpty) {
      sections.add((title: 'عمليات محفوظة محلياً', rows: localPending));
    }
    final filtered = sections
        .map(
          (s) => (
            title: s.title,
            rows: s.rows
                .where(
                  (r) =>
                      search.isEmpty ||
                      jsonEncode(
                        r,
                      ).toLowerCase().contains(search.toLowerCase()),
                )
                .toList(),
          ),
        )
        .toList();
    if (filtered.isEmpty) {
      return ListView(
        children: const [
          SizedBox(height: 120),
          Center(child: Text('لا توجد بيانات محفوظة لهذا القسم.')),
        ],
      );
    }
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        for (final section in filtered) ...[
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              '${section.title} (${section.rows.length})',
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ),
          for (final row in section.rows.take(100))
            Card(
              child: InkWell(
                borderRadius: BorderRadius.circular(12),
                onTap: module.id == 'debts' &&
                        row['id'] is String &&
                        row.containsKey('creditLimitMinor')
                    ? () => Navigator.push(
                          context,
                          MaterialPageRoute(
                            builder: (_) => CustomerDebtStatementPage(
                              customer: row,
                              api: api,
                            ),
                          ),
                        )
                    : null,
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(
                    children: [
                      for (final entry in row.entries
                          .where(
                            (e) => !RegExp(
                              r'password|secret|token|hash',
                              caseSensitive: false,
                            ).hasMatch(e.key),
                          )
                          .take(9))
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Expanded(
                                child: Text(
                                  _display(entry.value),
                                  textAlign: TextAlign.left,
                                ),
                              ),
                              const SizedBox(width: 8),
                              Text(
                                fieldLabel(entry.key),
                                style: const TextStyle(color: muted),
                              ),
                            ],
                          ),
                        ),
                      if (module.id == 'debts' &&
                          row.containsKey('creditLimitMinor'))
                        const Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            'اضغط لعرض تفاصيل الدين والسداد',
                            style: TextStyle(color: brand, fontSize: 12),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          if (section.rows.isEmpty)
            const Padding(
              padding: EdgeInsets.all(12),
              child: Text('لا توجد سجلات.'),
            ),
        ],
      ],
    );
  }
}

String _display(dynamic value) {
  if (value == null || value == '') return '—';
  if (value is bool) return value ? 'نعم' : 'لا';
  if (value is Map) return '${value.length} عناصر';
  if (value is List) return '${value.length} عناصر';
  return value.toString();
}

String _minorAmount(dynamic value) {
  final amount = BigInt.tryParse(value?.toString() ?? '') ?? BigInt.zero;
  final absolute = amount.abs();
  return '${amount.isNegative ? '-' : ''}${absolute ~/ BigInt.from(100)}.${(absolute % BigInt.from(100)).toString().padLeft(2, '0')}';
}

String _accountEntryLabel(dynamic value) => switch (value?.toString()) {
      'debt' => 'دين مضاف',
      'payment' => 'سداد',
      'sale' => 'فاتورة بيع',
      'sale_return' => 'مرتجع بيع',
      _ => 'حركة حساب',
    };

class CustomerDebtStatementPage extends StatefulWidget {
  const CustomerDebtStatementPage({
    super.key,
    required this.customer,
    required this.api,
  });
  final Map<String, dynamic> customer;
  final ApiService api;

  @override
  State<CustomerDebtStatementPage> createState() =>
      _CustomerDebtStatementPageState();
}

class _CustomerDebtStatementPageState extends State<CustomerDebtStatementPage> {
  CachedData? statement;
  String error = '';
  bool loading = true;

  Future<void> load() async {
    setState(() {
      loading = true;
      error = '';
    });
    try {
      statement =
          await widget.api.getCached('/api/debts/${widget.customer['id']}');
    } catch (e) {
      error = e.toString();
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  Widget build(BuildContext context) {
    final data = statement?.data is Map
        ? Map<String, dynamic>.from(statement!.data as Map)
        : <String, dynamic>{};
    final entries = (data['entries'] as List? ?? []).whereType<Map>().toList();
    final invoices =
        (data['invoices'] as List? ?? []).whereType<Map>().toList();
    final payments =
        (data['payments'] as List? ?? []).whereType<Map>().toList();
    return Scaffold(
      appBar:
          AppBar(title: Text('كشف حساب · ${widget.customer['name'] ?? ''}')),
      body: loading && statement == null
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: load,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (statement?.cached == true)
                    const Text('عرض نسخة محفوظة على الجهاز'),
                  Card(
                    child: ListTile(
                      title: const Text('الرصيد المستحق حالياً'),
                      subtitle: Text(widget.customer['phone']?.toString() ??
                          'بدون رقم هاتف'),
                      trailing: Text(
                        _minorAmount(data['balanceMinor'] ??
                            widget.customer['balanceMinor']),
                        style: const TextStyle(
                            fontWeight: FontWeight.bold, fontSize: 18),
                      ),
                    ),
                  ),
                  if (error.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(error,
                          style: const TextStyle(color: Colors.red)),
                    ),
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('حركات الدين والسداد',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                  if (entries.isEmpty) const Text('لا توجد حركات مسجلة.'),
                  for (final raw in entries)
                    Card(
                      child: ListTile(
                        leading: Icon((BigInt.tryParse(
                                        raw['amountMinor']?.toString() ?? '') ??
                                    BigInt.zero)
                                .isNegative
                            ? Icons.check_circle_outline
                            : Icons.add_circle_outline),
                        title: Text(_accountEntryLabel(raw['entryType'])),
                        subtitle: Text([
                          if (raw['note'] != null) raw['note'].toString(),
                          if (raw['runningBalanceMinor'] != null)
                            'الرصيد بعد الحركة: ${_minorAmount(raw['runningBalanceMinor'])}',
                          if (raw['createdAt'] != null)
                            raw['createdAt'].toString(),
                        ].join(' · ')),
                        trailing: Text(_minorAmount(raw['amountMinor'])),
                      ),
                    ),
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('الفواتير',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                  if (invoices.isEmpty) const Text('لا توجد فواتير.'),
                  for (final raw in invoices)
                    Card(
                      child: ListTile(
                        title: Text('فاتورة ${raw['invoiceNo'] ?? '—'}'),
                        subtitle: Text(
                            'مدفوع ${_minorAmount(raw['paidMinor'])} · متبقٍ ${_minorAmount(raw['dueMinor'])}'),
                        trailing: Text(_minorAmount(raw['totalMinor'])),
                      ),
                    ),
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 12),
                    child: Text('سندات السداد',
                        style: TextStyle(fontWeight: FontWeight.bold)),
                  ),
                  if (payments.isEmpty) const Text('لا توجد سندات سداد.'),
                  for (final raw in payments)
                    Card(
                      child: ListTile(
                        title: Text('سند ${raw['paymentNo'] ?? '—'}'),
                        subtitle: Text(
                            '${raw['occurredAt'] ?? raw['createdAt'] ?? ''} · ${raw['method'] ?? ''}'),
                        trailing: Text(_minorAmount(raw['amountMinor'])),
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}

class CreatePage extends StatefulWidget {
  const CreatePage({
    super.key,
    required this.module,
    required this.api,
    required this.onPendingChanged,
  });
  final AppModule module;
  final ApiService api;
  final Future<void> Function() onPendingChanged;
  @override
  State<CreatePage> createState() => _CreatePageState();
}

class _CreatePageState extends State<CreatePage> {
  final values = <String, String>{};
  final controllers = <String, TextEditingController>{};
  Map<String, dynamic> lookups = {};
  bool saving = false;
  String error = '';
  TextEditingController field(String key) => controllers.putIfAbsent(
        key,
        () => TextEditingController(text: values[key] ?? ''),
      );
  @override
  void initState() {
    super.initState();
    _loadLookups();
  }

  Future<void> _loadLookups() async {
    final endpoints = switch (widget.module.id) {
      'products' => ['/api/catalog'],
      // The POS catalog requires sales.create. Product and inventory staff may
      // create purchases or adjust stock without that permission.
      'purchases' => ['/api/products', '/api/suppliers'],
      'inventory' => ['/api/products'],
      'debts' => ['/api/customers', '/api/lookups'],
      'supplier-debts' => ['/api/suppliers', '/api/lookups'],
      'cashbox' => ['/api/lookups'],
      'settings' => ['/api/settings'],
      _ => <String>[],
    };
    for (final endpoint in endpoints) {
      try {
        final result = await widget.api.getCached(endpoint);
        if (result.data is Map) {
          lookups.addAll(Map<String, dynamic>.from(result.data as Map));
        }
      } catch (_) {}
    }
    if (mounted) setState(() {});
  }

  List<Map<String, dynamic>> options(String key) =>
      (lookups[key] as List? ?? [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
  Future<void> submit() async {
    setState(() {
      saving = true;
      error = '';
    });
    try {
      final v = {
        for (final e in controllers.entries) e.key: e.value.text.trim(),
      };
      final idempotency = widget.api.idempotencyKey();
      String path;
      Map<String, dynamic> body;
      var queue = false;
      var patch = false;
      switch (widget.module.id) {
        case 'customers':
          queue = true;
          path = '/api/customers';
          body = {
            'name': v['name'],
            'phone': v['phone'],
            'address': v['address'],
            'creditLimit': v['creditLimit'] ?? '0',
          };
          break;
        case 'suppliers':
          queue = true;
          path = '/api/suppliers';
          body = {
            'name': v['name'],
            'phone': v['phone'],
            'address': v['address'],
            'notes': v['notes'],
          };
          break;
        case 'products':
          queue = true;
          final units = options('units');
          final unit = v['unitId'] ??
              (units.isEmpty ? null : units.first['id']?.toString());
          if (unit == null) throw Exception('لا توجد وحدة قياس.');
          path = '/api/products';
          body = {
            'name': v['name'],
            'sku': v['sku'],
            'barcode': v['barcode'],
            'baseUnitId': unit,
            'purchaseCost': v['purchaseCost'] ?? '0',
            'retailPrice': v['retailPrice'] ?? '0',
            'wholesalePrice': v['wholesalePrice'] ?? v['retailPrice'] ?? '0',
            'minStock': v['minStock'] ?? '0',
            'units': [
              {'unitId': unit, 'factor': '1'},
            ],
          };
          break;
        case 'expenses':
          path = '/api/expenses';
          queue = true;
          body = {
            'category': v['category'],
            'description': v['description'],
            'amount': v['amount'],
            'idempotencyKey': idempotency,
          };
          break;
        case 'purchases':
          final product = options(
            'products',
          ).firstWhere((p) => p['id'] == v['productId'], orElse: () => {});
          final units =
              (product['units'] as List? ?? []).whereType<Map>().toList();
          final unit = units.isEmpty ? null : units.first['unitId']?.toString();
          if (product.isEmpty || v['supplierId'] == null || unit == null) {
            throw Exception('اختر المورد والمنتج.');
          }
          path = '/api/purchases';
          queue = true;
          body = {
            'supplierId': v['supplierId'],
            'items': [
              {
                'productId': v['productId'],
                'unitId': unit,
                'qty': v['qty'],
                'unitCost': v['unitCost'] ?? '0',
              },
            ],
            'paid': v['paid'] ?? '0',
            'idempotencyKey': idempotency,
          };
          break;
        case 'debts' || 'supplier-debts':
          final supplier = widget.module.id == 'supplier-debts';
          if (v['partyId'] == null) throw Exception('اختر الطرف.');
          final action = v['action'] ?? (supplier ? 'payment' : 'add_debt');
          if (!supplier && action == 'add_debt') {
            path = '/api/debts';
            queue = true;
            body = {
              'customerId': v['partyId'],
              'amount': v['amount'],
              'note': v['note'],
              'idempotencyKey': idempotency,
            };
            break;
          }
          path = '/api/payments';
          queue = true;
          body = {
            'direction': supplier ? 'supplier_payment' : 'customer_receipt',
            if (supplier) 'supplierId': v['partyId'],
            if (!supplier) 'customerId': v['partyId'],
            'amount': v['amount'],
            'method': 'cash',
            'cashboxId': v['cashboxId'],
            'idempotencyKey': idempotency,
          };
          break;
        case 'inventory':
          queue = true;
          path = '/api/inventory/adjust';
          body = {
            'productId': v['productId'],
            'direction': v['direction'] ?? 'increase',
            'qty': v['qty'],
            'unitCost': v['unitCost'],
            'reason': v['reason'],
          };
          break;
        case 'stocktaking':
          queue = true;
          path = '/api/stocktaking';
          body = {'title': v['title']};
          break;
        case 'cashbox':
          queue = true;
          path = '/api/cashbox/manual';
          body = {
            'cashboxId': v['cashboxId'],
            'direction': v['direction'] ?? 'inflow',
            'amount': v['amount'],
            'description': v['description'],
          };
          break;
        case 'users':
          path = '/api/users';
          body = {
            'name': v['name'],
            'email': v['email'],
            'password': v['password'],
            'role': v['role'] ?? 'cashier',
          };
          break;
        case 'settings':
          path = '/api/settings';
          patch = true;
          body = {
            'name': v['name'],
            'phone': v['phone'],
            'address': v['address'],
            'taxEnabled': v['taxEnabled'] == 'true',
            'taxRateBp':
                ((double.tryParse(v['taxRate'] ?? '0') ?? 0) * 100).round(),
          };
          break;
        default:
          throw Exception('لا يوجد نموذج إضافة لهذا القسم.');
      }
      final queued = patch
          ? await widget.api.patch(path, body).then((_) => false)
          : await widget.api.post(path, body, queueOffline: queue);
      await widget.onPendingChanged();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              queued
                  ? 'حُفظت العملية محلياً وستتم مزامنتها عند عودة الاتصال.'
                  : 'تم الحفظ بنجاح.',
            ),
          ),
        );
        Navigator.pop(context, true);
      }
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  Widget text(
    String key,
    String label, {
    bool numeric = false,
    bool secret = false,
  }) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 10),
        child: TextField(
          controller: field(key),
          obscureText: secret,
          keyboardType: numeric
              ? const TextInputType.numberWithOptions(decimal: true)
              : null,
          textDirection: const {'email', 'sku', 'barcode'}.contains(key)
              ? TextDirection.ltr
              : null,
          decoration: InputDecoration(
            labelText: label,
            border: const OutlineInputBorder(),
          ),
        ),
      );
  Widget pick(
    String key,
    String label,
    List<Map<String, dynamic>> items, {
    String defaultValue = '',
  }) {
    final selected = values[key] ?? defaultValue;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: DropdownButtonFormField<String>(
        initialValue:
            items.any((e) => e['id']?.toString() == selected) ? selected : null,
        decoration: InputDecoration(
          labelText: label,
          border: const OutlineInputBorder(),
        ),
        items: items
            .map(
              (e) => DropdownMenuItem(
                value: e['id']?.toString(),
                child: Text(
                  e['name']?.toString() ?? e['title']?.toString() ?? '—',
                ),
              ),
            )
            .toList(),
        onChanged: (v) => setState(() => values[key] = v ?? ''),
      ),
    );
  }

  List<Widget> form() {
    final id = widget.module.id;
    final result = <Widget>[];
    if (id == 'customers' || id == 'suppliers') {
      result.addAll([
        text('name', 'الاسم'),
        text('phone', 'الهاتف', numeric: true),
        text('address', 'العنوان'),
      ]);
    }
    if (id == 'customers') {
      result.add(text('creditLimit', 'حد الائتمان', numeric: true));
    }
    if (id == 'suppliers') result.add(text('notes', 'ملاحظات'));
    if (id == 'products') {
      result.addAll([
        text('name', 'اسم المنتج'),
        text('sku', 'رمز المنتج'),
        text('barcode', 'الباركود'),
        pick('unitId', 'الوحدة الأساسية', options('units')),
        text('purchaseCost', 'تكلفة الشراء', numeric: true),
        text('retailPrice', 'سعر البيع', numeric: true),
        text('wholesalePrice', 'سعر الجملة', numeric: true),
        text('minStock', 'حد التنبيه', numeric: true),
      ]);
    }
    if (id == 'expenses') {
      result.addAll([
        text('category', 'التصنيف'),
        text('description', 'الوصف'),
        text('amount', 'المبلغ', numeric: true),
      ]);
    }
    if (id == 'purchases') {
      result.addAll([
        pick('supplierId', 'المورد', options('suppliers')),
        pick('productId', 'المنتج', options('products')),
        text('qty', 'الكمية', numeric: true),
        text('unitCost', 'تكلفة الوحدة', numeric: true),
        text('paid', 'المدفوع', numeric: true),
      ]);
    }
    if (id == 'debts' || id == 'supplier-debts') {
      final rows = options(id == 'debts' ? 'customers' : 'suppliers');
      result.addAll([
        if (id == 'debts')
          pick(
              'action',
              'العملية',
              [
                {'id': 'add_debt', 'name': 'إضافة دين'},
                {'id': 'payment', 'name': 'تسجيل سداد'},
              ],
              defaultValue: 'add_debt'),
        pick('partyId', id == 'debts' ? 'العميل' : 'المورد', rows),
        pick('cashboxId', 'الصندوق', options('cashboxes')),
        text(
          'amount',
          id == 'debts' && (values['action'] ?? 'add_debt') == 'add_debt'
              ? 'مبلغ الدين'
              : 'مبلغ السداد',
          numeric: true,
        ),
        if (id == 'debts' && (values['action'] ?? 'add_debt') == 'add_debt')
          text('note', 'ملاحظة الدين'),
      ]);
    }
    if (id == 'inventory') {
      result.addAll([
        pick('productId', 'المنتج', options('products')),
        pick(
            'direction',
            'نوع الحركة',
            [
              {'id': 'increase', 'name': 'زيادة'},
              {'id': 'decrease', 'name': 'نقصان'},
            ],
            defaultValue: 'increase'),
        text('qty', 'الكمية', numeric: true),
        text('unitCost', 'تكلفة الوحدة', numeric: true),
        text('reason', 'السبب'),
      ]);
    }
    if (id == 'stocktaking') result.add(text('title', 'عنوان جلسة الجرد'));
    if (id == 'cashbox') {
      result.addAll([
        pick('cashboxId', 'الصندوق', options('cashboxes')),
        pick(
            'direction',
            'نوع الحركة',
            [
              {'id': 'inflow', 'name': 'إيداع'},
              {'id': 'outflow', 'name': 'سحب'},
            ],
            defaultValue: 'inflow'),
        text('amount', 'المبلغ', numeric: true),
        text('description', 'الوصف'),
      ]);
    }
    if (id == 'users') {
      result.addAll([
        text('name', 'الاسم'),
        text('email', 'البريد الإلكتروني'),
        text('password', 'كلمة المرور', secret: true),
        pick(
            'role',
            'الدور',
            [
              {'id': 'accountant', 'name': 'محاسب'},
              {'id': 'cashier', 'name': 'كاشير'},
              {'id': 'inventory_manager', 'name': 'مدير مخزون'},
              {'id': 'viewer', 'name': 'مشاهد'},
            ],
            defaultValue: 'cashier'),
      ]);
    }
    if (id == 'settings') {
      result.addAll([
        text('name', 'اسم النشاط'),
        text('phone', 'الهاتف'),
        text('address', 'العنوان'),
        pick(
            'taxEnabled',
            'الضريبة',
            [
              {'id': 'true', 'name': 'مفعّلة'},
              {'id': 'false', 'name': 'غير مفعّلة'},
            ],
            defaultValue: 'false'),
        text('taxRate', 'نسبة الضريبة %', numeric: true),
      ]);
    }
    return result;
  }

  @override
  void dispose() {
    for (final c in controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text('إضافة · ${widget.module.title}')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            ...form(),
            if (error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Text(error, style: const TextStyle(color: Colors.red)),
              ),
            FilledButton(
              onPressed: saving ? null : submit,
              child: Text(saving ? 'جارٍ الحفظ...' : 'حفظ'),
            ),
          ],
        ),
      );
}

class PosPage extends StatefulWidget {
  const PosPage({super.key, required this.api, required this.onSaved});
  final ApiService api;
  final Future<void> Function() onSaved;
  @override
  State<PosPage> createState() => _PosPageState();
}

class _PosPageState extends State<PosPage> {
  dynamic data;
  bool loading = true,
      saving = false,
      cameraBusy = false,
      usingCachedData = false;
  String error = '', search = '';
  final cart = <String, int>{};
  final selectedUnits = <String, String>{};
  final scannerController = TextEditingController();
  final scannerFocus = FocusNode();
  Timer? scannerDebounce;
  String lastCode = '';
  DateTime lastScanAt = DateTime.fromMillisecondsSinceEpoch(0);
  List<Map<String, dynamic>> localPendingSales = [];

  List<Map<String, dynamic>> get allProducts =>
      (data is Map ? (data['products'] as List? ?? []) : [])
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
  List<Map<String, dynamic>> get products => allProducts.where((product) {
        return search.isEmpty ||
            '${product['name']} ${product['sku']} ${product['barcode']}'
                .toLowerCase()
                .contains(search.toLowerCase());
      }).toList();

  String _key(String productId, String unitId) => '$productId::$unitId';
  List<Map<String, dynamic>> _units(Map<String, dynamic> product) =>
      (product['units'] as List? ?? [])
          .whereType<Map>()
          .map((unit) => Map<String, dynamic>.from(unit))
          .toList();
  Map<String, dynamic>? _baseUnit(Map<String, dynamic> product) {
    final units = _units(product);
    if (units.isEmpty) return null;
    return units.cast<Map<String, dynamic>?>().firstWhere(
          (unit) => unit?['isBase'] == true,
          orElse: () => units.first,
        );
  }

  Map<String, dynamic>? _unit(Map<String, dynamic> product, String? unitId) {
    final units = _units(product);
    if (units.isEmpty) return null;
    return units.cast<Map<String, dynamic>?>().firstWhere(
          (unit) => unit?['unitId']?.toString() == unitId,
          orElse: () => _baseUnit(product),
        );
  }

  int _int(dynamic value) => int.tryParse(value?.toString() ?? '') ?? 0;
  int _factor(Map<String, dynamic>? unit) => _int(unit?['factorMilli']);
  int _stock(Map<String, dynamic> product) => _int(product['qtyMilli']);
  String _qtyLabel(int baseMilli, int unitFactor) {
    if (unitFactor <= 0) return '0';
    final quantity = baseMilli / unitFactor;
    return quantity
        .toStringAsFixed(quantity == quantity.roundToDouble() ? 0 : 2);
  }

  int _cartBaseMilli(String productId) {
    var amount = 0;
    for (final line in cart.entries) {
      if (line.key.startsWith('$productId::')) {
        final unitId = line.key.substring(productId.length + 2);
        final product =
            allProducts.where((p) => p['id'].toString() == productId);
        if (product.isNotEmpty)
          amount += line.value * _factor(_unit(product.first, unitId));
      }
    }
    return amount;
  }

  int _linePrice(Map<String, dynamic> product, Map<String, dynamic>? unit) {
    final override = _int(unit?['retailPriceMinor']);
    if (override > 0) return override;
    final base = _int(product['retailPriceMinor']);
    final factor = _factor(unit);
    return factor == 0 ? base : (base * factor ~/ 1000);
  }

  int get total {
    var sum = 0;
    for (final line in cart.entries) {
      final parts = line.key.split('::');
      final matches = allProducts
          .where((product) => product['id'].toString() == parts.first);
      if (matches.isNotEmpty) {
        final unit = _unit(matches.first, parts.length > 1 ? parts[1] : null);
        sum += _linePrice(matches.first, unit) * line.value;
      }
    }
    return sum;
  }

  Future<void> load() async {
    localPendingSales = await widget.api.pendingForModule('pos');
    try {
      final cachedData = await widget.api.getCached('/api/pos/data');
      data = cachedData.data;
      usingCachedData = cachedData.cached;
    } catch (e) {
      error = e.toString();
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  void initState() {
    super.initState();
    load();
  }

  @override
  void dispose() {
    scannerDebounce?.cancel();
    scannerController.dispose();
    scannerFocus.dispose();
    super.dispose();
  }

  void _notify(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  void _addProduct(Map<String, dynamic> product, {String? unitId}) {
    final base = _baseUnit(product);
    final chosen = _unit(
        product,
        unitId ??
            selectedUnits[product['id'].toString()] ??
            base?['unitId']?.toString());
    if (chosen == null) {
      _notify('لا توجد وحدات بيع لهذا المنتج.');
      return;
    }
    final factor = _factor(chosen);
    final available =
        _stock(product) - _cartBaseMilli(product['id'].toString());
    if (factor <= 0 || available < factor) {
      _notify(available <= 0
          ? 'نفدت الكمية المتاحة من هذا المنتج.'
          : 'الكمية المتبقية لا تكفي لإضافة ${chosen['unitName'] ?? 'هذه الوحدة'}.');
      return;
    }
    final key = _key(product['id'].toString(), chosen['unitId'].toString());
    setState(() => cart[key] = (cart[key] ?? 0) + 1);
  }

  void _changeQuantity(
      Map<String, dynamic> product, Map<String, dynamic>? unit, int delta) {
    if (unit == null) return;
    final key = _key(product['id'].toString(), unit['unitId'].toString());
    final next = (cart[key] ?? 0) + delta;
    if (next < 0) return;
    if (delta > 0) {
      final remaining =
          _stock(product) - _cartBaseMilli(product['id'].toString());
      if (_factor(unit) <= 0 || remaining < _factor(unit)) {
        _notify('لا يمكن تجاوز المخزون المتاح.');
        return;
      }
    }
    setState(() {
      if (next == 0) {
        cart.remove(key);
      } else {
        cart[key] = next;
      }
    });
  }

  void _processBarcode(String rawCode) {
    final code = rawCode.trim();
    if (code.isEmpty) return;
    final now = DateTime.now();
    if (code == lastCode && now.difference(lastScanAt).inMilliseconds < 700)
      return;
    lastCode = code;
    lastScanAt = now;
    final matches = allProducts
        .where((product) => product['barcode']?.toString().trim() == code);
    if (matches.isEmpty) {
      _notify('لم يتم العثور على منتج بالباركود: $code');
      return;
    }
    _addProduct(matches.first);
    scannerController.clear();
    if (mounted && !cameraBusy) {
      Future<void>.delayed(const Duration(milliseconds: 100), () {
        if (mounted && scannerFocus.canRequestFocus)
          scannerFocus.requestFocus();
      });
    }
  }

  Future<void> _openCameraScanner() async {
    setState(() => cameraBusy = true);
    try {
      final code = await Navigator.of(context).push<String>(MaterialPageRoute(
        builder: (_) => const _PosCameraScannerPage(),
      ));
      if (code != null && mounted) _processBarcode(code);
    } catch (e) {
      _notify('تعذر فتح الكاميرا أو منح الإذن. $e');
    } finally {
      if (mounted) setState(() => cameraBusy = false);
      if (mounted) scannerFocus.requestFocus();
    }
  }

  Future<void> checkout() async {
    if (cart.isEmpty) return;
    setState(() => saving = true);
    try {
      final items = <Map<String, dynamic>>[];
      final localDeductions = <String, int>{};
      for (final line in cart.entries) {
        final parts = line.key.split('::');
        final product = allProducts.firstWhere(
          (item) => item['id'].toString() == parts.first,
        );
        final unit = _unit(product, parts[1]);
        localDeductions[parts.first] =
            (localDeductions[parts.first] ?? 0) + line.value * _factor(unit);
        items.add({
          'productId': parts.first,
          'unitId': parts[1],
          'qty': '${line.value}',
          'priceTier': 'retail',
        });
      }
      final queued = await widget.api.post(
        '/api/sales',
        {
          'items': items,
          'paymentType': 'cash',
          'paid':
              '${(total ~/ 100)}.${(total % 100).toString().padLeft(2, '0')}',
          'idempotencyKey': widget.api.idempotencyKey(),
          'offline': true,
          'notes': 'تطبيق الجوال Flutter',
        },
        queueOffline: true,
      );
      if (queued) {
        await widget.api.store.decrementCachedPosStock(localDeductions);
      }
      cart.clear();
      await widget.onSaved();
      await load();
      if (mounted)
        _notify(queued ? 'حُفظ البيع محلياً للمزامنة.' : 'تم تسجيل البيع.');
    } catch (e) {
      if (mounted) setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('نقطة البيع')),
        body: loading
            ? const Center(child: CircularProgressIndicator())
            : Column(children: [
                Padding(
                    padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
                    child: Row(children: [
                      Expanded(
                          child: OutlinedButton.icon(
                              onPressed: cameraBusy ? null : _openCameraScanner,
                              icon: const Icon(Icons.camera_alt_outlined),
                              label: const Text('مسح بالكاميرا'))),
                      const SizedBox(width: 8),
                      Expanded(
                          child: OutlinedButton.icon(
                              onPressed: () => scannerFocus.requestFocus(),
                              icon: const Icon(Icons.usb),
                              label: const Text('قارئ الباركود'))),
                    ])),
                Padding(
                    padding: const EdgeInsets.fromLTRB(12, 4, 12, 8),
                    child: TextField(
                      controller: scannerController,
                      focusNode: scannerFocus,
                      autofocus: true,
                      textInputAction: TextInputAction.done,
                      decoration: const InputDecoration(
                          prefixIcon: Icon(Icons.qr_code_scanner),
                          labelText: 'قارئ الباركود',
                          hintText: 'امسح الرمز أو أدخله ثم اضغط Enter',
                          border: OutlineInputBorder(),
                          isDense: true),
                      onSubmitted: _processBarcode,
                      onChanged: (value) {
                        scannerDebounce?.cancel();
                        if (value.trim().length >= 4)
                          scannerDebounce = Timer(
                              const Duration(milliseconds: 350),
                              () => _processBarcode(value));
                      },
                    )),
                Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                    child: TextField(
                      decoration: const InputDecoration(
                          prefixIcon: Icon(Icons.search),
                          hintText: 'ابحث عن منتج أو رمز',
                          border: OutlineInputBorder(),
                          isDense: true),
                      onChanged: (value) => setState(() => search = value),
                    )),
                if (usingCachedData)
                  const Padding(
                      padding: EdgeInsets.only(bottom: 6),
                      child: Text(
                          'تعمل نقطة البيع ببيانات المخزون المحفوظة محلياً؛ قد تتغير الكمية عند المزامنة.',
                          style: TextStyle(color: Colors.deepOrange))),
                if (error.isNotEmpty)
                  Text(error, style: const TextStyle(color: Colors.red)),
                if (localPendingSales.isNotEmpty)
                  Card(
                      child: ExpansionTile(
                    title: Text(
                        '${localPendingSales.length} مبيعات محفوظة على الهاتف وتنتظر المزامنة'),
                    children: [
                      for (final sale in localPendingSales)
                        ListTile(
                            leading: const Icon(Icons.cloud_upload_outlined),
                            title: const Text('بيع غير متزامن'),
                            subtitle: Text(
                                '${(sale['items'] as List? ?? []).length} أصناف · ${sale['_localStatus'] ?? ''}'))
                    ],
                  )),
                Expanded(
                    child: ListView.builder(
                        itemCount: products.length,
                        itemBuilder: (context, i) {
                          final product = products[i];
                          final id = product['id'].toString();
                          final units = _units(product);
                          final base = _baseUnit(product);
                          final selectedId =
                              selectedUnits[id] ?? base?['unitId']?.toString();
                          final unit = _unit(product, selectedId);
                          final key = unit == null
                              ? ''
                              : _key(id, unit['unitId'].toString());
                          final qty = cart[key] ?? 0;
                          final price = _linePrice(product, unit) / 100;
                          final available =
                              _stock(product) - _cartBaseMilli(id);
                          final inCart = _cartBaseMilli(id);
                          final baseFactor = _factor(base);
                          return Card(
                              child: Padding(
                                  padding: const EdgeInsets.all(8),
                                  child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        ListTile(
                                            contentPadding: EdgeInsets.zero,
                                            leading: product['imageUrl'] == null
                                                ? const Icon(
                                                    Icons.inventory_2_outlined)
                                                : ClipRRect(
                                                    borderRadius:
                                                        BorderRadius.circular(
                                                            6),
                                                    child: Image.network(
                                                      product['imageUrl']
                                                          .toString(),
                                                      width: 48,
                                                      height: 48,
                                                      fit: BoxFit.cover,
                                                      errorBuilder: (_, __,
                                                              ___) =>
                                                          const Icon(Icons
                                                              .inventory_2_outlined),
                                                    ),
                                                  ),
                                            title: Text(
                                                product['name']?.toString() ??
                                                    ''),
                                            subtitle: Text(
                                                '${product['sku'] ?? ''}${product['barcode'] == null ? '' : ' · ${product['barcode']}'}\n${price.toStringAsFixed(2)} ر.ي لكل ${unit?['unitName'] ?? ''}\nالمخزون المتوفر: ${_qtyLabel(_stock(product), baseFactor)} · الكمية في السلة: ${_qtyLabel(inCart, baseFactor)} · المتبقي: ${_qtyLabel(available, baseFactor)} ${base?['unitName'] ?? ''}${_stock(product) <= _int(product['minStockMilli']) && _stock(product) > 0 ? '\nاقترب المخزون من النفاد' : ''}',
                                                style: TextStyle(
                                                    color: available <= 0
                                                        ? Colors.red
                                                        : muted)),
                                            trailing: Wrap(
                                                crossAxisAlignment:
                                                    WrapCrossAlignment.center,
                                                children: [
                                                  IconButton(
                                                      tooltip: 'إنقاص',
                                                      onPressed: qty == 0
                                                          ? null
                                                          : () =>
                                                              _changeQuantity(
                                                                  product,
                                                                  unit,
                                                                  -1),
                                                      icon: const Icon(Icons
                                                          .remove_circle_outline)),
                                                  Text('$qty'),
                                                  IconButton(
                                                      tooltip: 'إضافة',
                                                      onPressed: () =>
                                                          _addProduct(product,
                                                              unitId:
                                                                  selectedId),
                                                      icon: const Icon(Icons
                                                          .add_circle_outline))
                                                ])),
                                        if (units.length > 1)
                                          DropdownButtonFormField<String>(
                                              value: selectedId,
                                              decoration: const InputDecoration(
                                                  labelText: 'وحدة البيع',
                                                  isDense: true),
                                              items: [
                                                for (final item in units)
                                                  DropdownMenuItem(
                                                      value: item['unitId']
                                                          .toString(),
                                                      child: Text(item[
                                                                  'unitName']
                                                              ?.toString() ??
                                                          'وحدة'))
                                              ],
                                              onChanged: (value) {
                                                if (value != null)
                                                  setState(() =>
                                                      selectedUnits[id] =
                                                          value);
                                              }),
                                      ])));
                        })),
                SafeArea(
                    top: false,
                    child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Row(children: [
                          Expanded(
                              child: Text(
                                  'الإجمالي: ${(total / 100).toStringAsFixed(2)} ر.ي',
                                  style: const TextStyle(
                                      fontSize: 17,
                                      fontWeight: FontWeight.bold))),
                          FilledButton(
                              onPressed: saving || total == 0 ? null : checkout,
                              child:
                                  Text(saving ? 'جارٍ الحفظ...' : 'حفظ البيع'))
                        ]))),
              ]),
      );
}

class _PosCameraScannerPage extends StatefulWidget {
  const _PosCameraScannerPage();
  @override
  State<_PosCameraScannerPage> createState() => _PosCameraScannerPageState();
}

class _PosCameraScannerPageState extends State<_PosCameraScannerPage> {
  late final MobileScannerController controller = MobileScannerController(
    facing: CameraFacing.back,
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [
      BarcodeFormat.ean13,
      BarcodeFormat.ean8,
      BarcodeFormat.upcA,
      BarcodeFormat.upcE,
      BarcodeFormat.code128
    ],
  );
  bool captured = false;

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('مسح الباركود بالكاميرا')),
        body: Stack(fit: StackFit.expand, children: [
          MobileScanner(
              controller: controller,
              onDetect: (capture) {
                if (captured) return;
                for (final barcode in capture.barcodes) {
                  final value = barcode.rawValue;
                  if (value != null && value.trim().isNotEmpty) {
                    captured = true;
                    Navigator.of(context).pop(value.trim());
                    break;
                  }
                }
              },
              errorBuilder: (context, error) => Center(
                  child: Padding(
                      padding: const EdgeInsets.all(24),
                      child: Text(
                          'تعذر تشغيل الكاميرا. تحقق من إذن الكاميرا أو استخدم قارئ الباركود الخارجي.\n${error.errorCode.name}',
                          textAlign: TextAlign.center)))),
          Align(
              alignment: Alignment.bottomCenter,
              child: SafeArea(
                  child: Container(
                      color: Colors.black54,
                      padding: const EdgeInsets.all(16),
                      child: const Text(
                          'وجّه الكاميرا إلى رمز EAN أو UPC أو Code 128',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.white))))),
        ]),
      );
}

class AssistantPage extends StatefulWidget {
  const AssistantPage({super.key, required this.api});
  final ApiService api;
  @override
  State<AssistantPage> createState() => _AssistantPageState();
}

class _AssistantPageState extends State<AssistantPage> {
  final question = TextEditingController();
  String answer = '', error = '';
  bool loading = false;
  Future<void> ask() async {
    setState(() => loading = true);
    try {
      final result = await widget.api.post('/api/ai/ask', {
        'question': question.text,
      });
      answer = (result as Map)['answer']?.toString() ?? jsonEncode(result);
    } catch (e) {
      error = e is SocketException || e is TimeoutException
          ? 'المساعد الذكي يحتاج اتصالاً بالخادم، لذلك لم يُرسل السؤال. قاعدة البيانات المحلية مستقلة وتبقى متاحة للبيانات المحفوظة على الهاتف.'
          : e.toString();
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  @override
  void dispose() {
    question.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('المساعد الذكي')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(
                'اسأل عن بيانات نشاطك. يتطلب هذا القسم اتصالاً بالخادم.'),
            const SizedBox(height: 10),
            TextField(
              controller: question,
              maxLines: 3,
              decoration: const InputDecoration(
                labelText: 'سؤالك',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 10),
            FilledButton(
              onPressed: loading ? null : ask,
              child: Text(loading ? 'جارٍ التحليل...' : 'إرسال السؤال'),
            ),
            if (error.isNotEmpty)
              Text(error, style: const TextStyle(color: Colors.red)),
            if (answer.isNotEmpty)
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Text(answer),
                ),
              ),
          ],
        ),
      );
}

class SettingsPage extends StatefulWidget {
  const SettingsPage({
    super.key,
    required this.api,
    required this.onLogout,
    required this.online,
    required this.canManageServerBackup,
    required this.onLocalDataChanged,
  });
  final ApiService api;
  final Future<void> Function() onLogout;
  final bool online, canManageServerBackup;
  final Future<void> Function() onLocalDataChanged;
  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> {
  late final url = TextEditingController(text: widget.api.baseUrl);
  final confirmController = TextEditingController();
  String message = '', error = '';
  bool busy = false;
  Future<void> saveUrl() async {
    try {
      await widget.api.setBaseUrl(url.text);
      setState(
        () => message = 'تم حفظ رابط الخادم. أعد تسجيل الدخول عند الحاجة.',
      );
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  String get offlinePolicyLabel => switch (AppConfig.offlineAuthPolicy) {
        OfflineAuthPolicy.requireOnline => 'يتطلب اتصالاً دائماً بالإنترنت',
        OfflineAuthPolicy.cachedSession =>
          'فتح الجلسة المحفوظة دون اتصال لمدة ${AppConfig.offlineSessionDays} يوماً',
        OfflineAuthPolicy.cachedCredentials =>
          'فتح الجلسة أو الدخول بكلمة المرور المحفوظة دون اتصال',
      };

  Future<void> backup() async {
    try {
      final file = await LocalStore.instance.exportBackup();
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path)],
          text: 'نسخة بيانات تطبيق حساب المحلية',
        ),
      );
      setState(
        () => message =
            'تم إنشاء نسخة محلية تشمل البيانات المحفوظة والعمليات المعلقة.',
      );
    } catch (e) {
      setState(() => error = e.toString());
    }
  }

  Future<void> serverBackup() async {
    try {
      if (!widget.online) {
        throw Exception('اتصل بالإنترنت لإنشاء نسخة قاعدة البيانات.');
      }
      setState(() => busy = true);
      final data = await widget.api.get('/api/backup');
      final directory = await getApplicationDocumentsDirectory();
      final file = File(
        p.join(
          directory.path,
          'hisab-database-backup-${DateTime.now().toUtc().toIso8601String().replaceAll(':', '-')}.json',
        ),
      );
      await file.writeAsString(
        const JsonEncoder.withIndent('  ').convert(data),
        flush: true,
      );
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(file.path)],
          text: 'نسخة قاعدة بيانات حساب الكاملة',
        ),
      );
      setState(() => message = 'تم إنشاء نسخة كاملة من قاعدة بيانات الخادم.');
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Future<void> restore() async {
    try {
      final picked = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['json'],
      );
      if (picked.isEmpty) return;
      final bytes = await picked.single.readAsBytes();
      final data = jsonDecode(utf8.decode(bytes));
      if (data is! Map) throw const FormatException('الملف ليس نسخة صالحة.');
      if (!mounted) return;
      final isServerBackup = data['format'] == 'hisab-database-backup';
      if (isServerBackup && !widget.canManageServerBackup) {
        throw Exception(
          'استعادة قاعدة البيانات الكاملة متاحة لمالك النشاط فقط.',
        );
      }
      if (isServerBackup && !widget.online) {
        throw Exception('اتصل بالإنترنت لاستعادة قاعدة بيانات الخادم.');
      }
      final yes = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(
            isServerBackup
                ? 'استعادة قاعدة البيانات كاملة؟'
                : 'استعادة النسخة المحلية؟',
          ),
          content: isServerBackup
              ? Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'سيتم استبدال بيانات جميع الأنشطة على الخادم بهذه النسخة. هذا الإجراء لا يمكن التراجع عنه.',
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: confirmController,
                      textDirection: TextDirection.ltr,
                      decoration: const InputDecoration(
                        labelText: 'اكتب RESTORE_DATABASE للتأكيد',
                      ),
                    ),
                  ],
                )
              : const Text(
                  'سيتم استبدال ذاكرة التخزين المؤقت وطابور المزامنة على هذا الجهاز بمحتوى الملف.',
                ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('إلغاء'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(
                ctx,
                !isServerBackup || confirmController.text == 'RESTORE_DATABASE',
              ),
              child: const Text('استعادة'),
            ),
          ],
        ),
      );
      if (yes != true) return;
      if (isServerBackup) {
        setState(() => busy = true);
        await widget.api.post('/api/backup', {
          'confirmation': 'RESTORE_DATABASE',
          'backup': data,
        });
        await LocalStore.instance.clearLocalData();
        await widget.onLocalDataChanged();
        setState(() => message = 'تمت استعادة قاعدة بيانات الخادم بالكامل.');
      } else {
        await LocalStore.instance.restoreBackup(
          Map<String, dynamic>.from(data),
        );
        await widget.onLocalDataChanged();
        setState(() => message = 'تمت استعادة بيانات الجهاز.');
      }
    } catch (e) {
      setState(() => error = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  void dispose() {
    url.dispose();
    confirmController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('الإعدادات والنسخ الاحتياطي')),
        body: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            TextField(
              controller: url,
              enabled: widget.api.canEditServer,
              textDirection: TextDirection.ltr,
              decoration: InputDecoration(
                labelText: 'رابط الخادم',
                helperText: widget.api.canEditServer
                    ? 'استخدم رابط HTTPS عاماً وليس localhost'
                    : 'يدار رابط الخادم تلقائياً في نسخة الإنتاج',
                border: const OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 8),
            FilledButton(
              onPressed: widget.api.canEditServer ? saveUrl : null,
              child: const Text('حفظ رابط الخادم'),
            ),
            const SizedBox(height: 8),
            Text(
              'الاتصال السحابي: Supabase عبر API الخادم. $offlinePolicyLabel.',
              style: const TextStyle(color: muted),
            ),
            const Divider(height: 32),
            const Text(
              'نسخة الجهاز المحلية',
              style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17),
            ),
            const Text(
              'تضم ردود API المخزنة والعمليات التي تنتظر المزامنة. لا تتضمن قاعدة بيانات الخادم كاملة.',
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: backup,
              icon: const Icon(Icons.backup_outlined),
              label: const Text('تصدير نسخة الجهاز'),
            ),
            OutlinedButton.icon(
              onPressed: restore,
              icon: const Icon(Icons.restore),
              label: const Text('استعادة نسخة الجهاز'),
            ),
            if (widget.canManageServerBackup) ...[
              const Divider(height: 32),
              const Text(
                'نسخة قاعدة بيانات الخادم',
                style: TextStyle(fontWeight: FontWeight.bold, fontSize: 17),
              ),
              const Text(
                'تشمل جداول النظام وبيانات الأنشطة. الاستعادة تستبدل قاعدة النظام كاملة ولا تعمل دون اتصال.',
              ),
              OutlinedButton.icon(
                onPressed: !widget.online || busy ? null : serverBackup,
                icon: const Icon(Icons.cloud_download_outlined),
                label: const Text('تصدير نسخة كاملة من الخادم'),
              ),
              OutlinedButton.icon(
                onPressed: !widget.online || busy ? null : restore,
                icon: const Icon(Icons.cloud_upload_outlined),
                label: const Text('استعادة نسخة كاملة إلى الخادم'),
              ),
            ],
            if (message.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(message, style: const TextStyle(color: brand)),
              ),
            if (error.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(error, style: const TextStyle(color: Colors.red)),
              ),
            const Divider(height: 32),
            OutlinedButton(
              onPressed: widget.onLogout,
              child: const Text('تسجيل الخروج'),
            ),
          ],
        ),
      );
}
