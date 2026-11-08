import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:http/http.dart' as http;

import 'app_config.dart';
import 'local_store.dart';

class ApiException implements Exception {
  ApiException(this.message, this.status);
  final String message;
  final int status;
  @override
  String toString() => message;
}

class CachedData {
  const CachedData(this.data, {required this.cached, this.updatedAt});
  final dynamic data;
  final bool cached;
  final String? updatedAt;
}

class ApiConfigurationException implements Exception {
  const ApiConfigurationException(this.message);
  final String message;
  @override
  String toString() => message;
}

class ApiService {
  ApiService(this.store);
  final LocalStore store;
  final http.Client _client = http.Client();
  String? _baseUrl;
  String? _token;
  String? configurationError;

  bool get hasBaseUrl => _baseUrl?.isNotEmpty == true;
  bool get canEditServer =>
      !AppConfig.isProduction || AppConfig.allowServerOverride;

  /// Errors that mean "the server could not be reached", as opposed to a
  /// rejected credential or a server-side failure.
  static bool isConnectivityError(Object error) =>
      error is SocketException ||
      error is http.ClientException ||
      error is TimeoutException;

  static bool canUseOfflineFallback(Object error) =>
      isConnectivityError(error) || error is ApiConfigurationException;

  Future<void> initialize() async {
    final saved = await store.serverUrl;
    final managed = AppConfig.productionApiBaseUrl;
    final candidates = <String?>[
      if (canEditServer) saved,
      managed,
    ];
    configurationError = null;
    _baseUrl = '';
    for (final candidate in candidates) {
      if (candidate == null || candidate.trim().isEmpty) continue;
      try {
        final normalized = AppConfig.validateBaseUrl(candidate);
        if (AppConfig.isProduction &&
            !AppConfig.allowServerOverride &&
            managed != null &&
            normalized != managed) {
          continue;
        }
        _baseUrl = normalized;
        break;
      } on FormatException catch (error) {
        configurationError ??= error.message;
      }
    }
    if (!hasBaseUrl) {
      configurationError ??= AppConfig.isProduction
          ? 'لم يتم إعداد رابط API في نسخة الإنتاج. أعد تثبيت النسخة الصحيحة أو تواصل مع الدعم.'
          : 'لم يتم إعداد رابط API. أدخل رابط خادم التطوير.';
    }
    _token = await store.token;
  }

  String get baseUrl => _baseUrl ?? '';
  void setToken(String? value) => _token = value;

  Future<void> setBaseUrl(String input) async {
    if (!canEditServer) {
      throw const ApiConfigurationException(
        'رابط الخادم مدار بواسطة نسخة الإنتاج ولا يمكن تغييره من التطبيق.',
      );
    }
    final normalized = AppConfig.validateBaseUrl(input);
    _baseUrl = normalized;
    await store.setServerUrl(normalized);
    configurationError = null;
  }

  Uri _uri(String path) {
    if (!hasBaseUrl) {
      throw const ApiConfigurationException(
        'رابط API غير مضبوط. أدخل رابط الخادم المنشور عبر HTTPS في إعداد الاتصال.',
      );
    }
    return Uri.parse('$baseUrl/${path.replaceFirst(RegExp(r'^/+'), '')}');
  }

  Future<dynamic> _request(
    String path, {
    String method = 'GET',
    Object? body,
    bool login = false,
  }) async {
    final headers = <String, String>{'content-type': 'application/json'};
    if (_token != null && !login) headers['authorization'] = 'Bearer $_token';
    if (login) headers['x-hisab-client'] = 'react-native';
    final request = http.Request(method, _uri(path))..headers.addAll(headers);
    if (body != null) request.body = jsonEncode(body);
    final streamed =
        await _client.send(request).timeout(const Duration(seconds: 20));
    final response = await http.Response.fromStream(streamed);
    dynamic payload;
    if (response.body.isNotEmpty &&
        response.headers['content-type']?.contains('application/json') ==
            true) {
      payload = jsonDecode(response.body);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final message = payload is Map && payload['error'] is String
          ? payload['error'] as String
          : response.statusCode == 401
              ? 'انتهت الجلسة. اتصل بالإنترنت وسجّل الدخول مجدداً.'
              : 'تعذر تنفيذ الطلب.';
      throw ApiException(message, response.statusCode);
    }
    return payload;
  }

  Future<dynamic> get(String path) => _request(path);

  Future<bool> checkServer() async {
    try {
      final result = await _request('/api/health');
      return result is Map && result['status'] == 'ok';
    } on ApiException catch (error) {
      return error.status < 500;
    } on SocketException {
      return false;
    } on http.ClientException {
      return false;
    } on TimeoutException {
      return false;
    } on ApiConfigurationException {
      return false;
    }
  }

  Future<CachedData> getCached(String path) async {
    try {
      final result = await get(path);
      await store.cache(path, result);
      return CachedData(
        result,
        cached: false,
        updatedAt: DateTime.now().toUtc().toIso8601String(),
      );
    } on ApiException {
      rethrow;
    } on SocketException {
      return _cachedOrThrow(path);
    } on http.ClientException {
      return _cachedOrThrow(path);
    } on TimeoutException {
      return _cachedOrThrow(path);
    }
  }

  Future<CachedData> _cachedOrThrow(String path) async {
    final cached = await store.readCache(path);
    if (cached == null) {
      throw const SocketException(
        'لا يوجد اتصال ولا توجد بيانات محفوظة لهذا القسم.',
      );
    }
    return CachedData(
      cached['data'],
      cached: true,
      updatedAt: cached['updatedAt']?.toString(),
    );
  }

  Future<dynamic> login(String email, String password) => _request(
        '/api/auth/login',
        method: 'POST',
        body: {'email': email, 'password': password},
        login: true,
      );

  /// Confirms the cached bearer token against the server and returns the
  /// refreshed session payload when it is still valid.
  Future<Map<String, dynamic>?> currentSession() async {
    final result = await get('/api/auth/me');
    if (result is Map && result['session'] is Map) {
      return Map<String, dynamic>.from(result['session'] as Map);
    }
    return null;
  }

  String idempotencyKey() =>
      'flutter-${DateTime.now().microsecondsSinceEpoch}-${Random.secure().nextInt(1 << 32)}';

  Future<List<Map<String, dynamic>>> pendingForModule(String moduleId) async {
    final paths = switch (moduleId) {
      'pos' => {'/api/sales'},
      'products' => {'/api/products'},
      'inventory' => {'/api/inventory/adjust'},
      'purchases' => {'/api/purchases'},
      'customers' => {'/api/customers'},
      'debts' => {'/api/debts', '/api/payments'},
      'suppliers' => {'/api/suppliers'},
      'supplier-debts' => {'/api/payments'},
      'expenses' => {'/api/expenses'},
      'cashbox' => {'/api/cashbox/manual'},
      'stocktaking' => {'/api/stocktaking'},
      _ => <String>{},
    };
    final rows = await store.queue();
    return rows.where((row) => paths.contains(row['path'])).map((row) {
      final body = Map<String, dynamic>.from(
        jsonDecode(row['body']! as String) as Map,
      )..remove('idempotencyKey');
      return {
        ...body,
        '_localStatus': row['status'] == 'failed'
            ? 'تعذرت المزامنة: ${row['error'] ?? 'خطأ غير معروف'}'
            : 'بانتظار المزامنة',
        '_localCreatedAt': row['created_at'],
      };
    }).toList();
  }

  String? _operationType(String path) => const {
        '/api/sales': 'sale.create',
        '/api/purchases': 'purchase.create',
        '/api/expenses': 'expense.create',
        '/api/payments': 'payment.create',
        '/api/customers': 'customer.create',
        '/api/suppliers': 'supplier.create',
        '/api/products': 'product.create',
        '/api/debts': 'debt.create',
        '/api/inventory/adjust': 'inventory.adjust',
        '/api/cashbox/manual': 'cashbox.manual',
        '/api/stocktaking': 'stocktaking.create',
      }[path];

  Future<Map<String, dynamic>> _submitOperation(
    String path,
    Map<String, dynamic> body,
  ) async {
    final response = await _request(
      '/api/sync',
      method: 'POST',
      body: {
        'deviceId': await store.deviceId,
        'operations': [
          {
            'operationId': body['idempotencyKey'],
            'type': _operationType(path),
            'payload': body,
          },
        ],
      },
    );
    if (response is! Map ||
        response['results'] is! List ||
        (response['results'] as List).isEmpty) {
      throw const FormatException('استجابة المزامنة غير صالحة.');
    }
    return Map<String, dynamic>.from(
      (response['results'] as List).first as Map,
    );
  }

  Future<bool> post(
    String path,
    Map<String, dynamic> body, {
    bool queueOffline = false,
  }) async {
    if (_operationType(path) != null) {
      final prepared = {
        ...body,
        'idempotencyKey':
            body['idempotencyKey']?.toString() ?? idempotencyKey(),
      };
      try {
        final result = await _submitOperation(path, prepared);
        if (result['status'] != 'done') {
          throw ApiException(
            result['error']?.toString() ?? 'رفض الخادم العملية.',
            400,
          );
        }
        return false;
      } on SocketException {
        return _queue(path, prepared, queueOffline);
      } on http.ClientException {
        return _queue(path, prepared, queueOffline);
      } on TimeoutException {
        return _queue(path, prepared, queueOffline);
      }
    }
    try {
      await _request(path, method: 'POST', body: body);
      return false;
    } on SocketException {
      return _queue(path, body, queueOffline);
    } on http.ClientException {
      return _queue(path, body, queueOffline);
    } on TimeoutException {
      return _queue(path, body, queueOffline);
    }
  }

  Future<bool> _queue(
    String path,
    Map<String, dynamic> body,
    bool queueOffline,
  ) async {
    if (!queueOffline ||
        _operationType(path) == null ||
        (body['idempotencyKey']?.toString().length ?? 0) < 8) {
      throw const SocketException(
        'هذه العملية تحتاج اتصالاً بالخادم ولا يمكن حفظها بأمان دون اتصال.',
      );
    }
    await store.enqueue(body['idempotencyKey'].toString(), path, body);
    return true;
  }

  Future<dynamic> patch(String path, Map<String, dynamic> body) =>
      _request(path, method: 'PATCH', body: body);

  Future<({int done, int failed})> sync() async {
    await store.retryFailed();
    var done = 0;
    var failed = 0;
    final deviceId = await store.deviceId;
    final queued = await store.queue();
    for (var offset = 0; offset < queued.length; offset += 50) {
      final batch = queued.skip(offset).take(50).toList();
      try {
        final response = await _request(
          '/api/sync',
          method: 'POST',
          body: {
            'deviceId': deviceId,
            'operations': batch
                .map(
                  (row) => {
                    'operationId': row['id'],
                    'type': _operationType(row['path']! as String),
                    'payload': jsonDecode(row['body']! as String),
                  },
                )
                .toList(),
          },
        );
        final results = (response as Map)['results'] as List;
        for (final item in results) {
          final result = Map<String, dynamic>.from(item as Map);
          final id = result['operationId'] as String;
          if (result['status'] == 'done') {
            await store.removeQueued(id);
            done++;
          } else {
            await store.failQueued(
              id,
              result['error']?.toString() ?? 'تعذرت مزامنة العملية',
            );
            failed++;
          }
        }
      } catch (error) {
        for (final row in batch) {
          await store.failQueued(row['id']! as String, error.toString());
          failed++;
        }
        break;
      }
    }
    return (done: done, failed: failed);
  }
}
