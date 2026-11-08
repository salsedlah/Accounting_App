import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

class LocalStore {
  LocalStore._();
  static final instance = LocalStore._();
  static const _secure = FlutterSecureStorage();
  static const _sessionVerifiedAtKey = 'hisab_session_verified_at';
  static const _offlineEmailKey = 'hisab_offline_email';
  static const _offlineSaltKey = 'hisab_offline_salt';
  static const _offlineVerifierKey = 'hisab_offline_verifier';
  static const _offlineIterationsKey = 'hisab_offline_iterations';
  static const _offlineSavedAtKey = 'hisab_offline_saved_at';
  static const _deviceIdKey = 'hisab_device_id';
  static const int _offlineIterations = 60000;
  Database? _database;

  Future<Database> get db async {
    if (_database != null) return _database!;
    final root = await getDatabasesPath();
    _database = await openDatabase(
      p.join(root, 'hisab_flutter.db'),
      version: 1,
      onCreate: (database, _) async {
        await database.execute(
          '''CREATE TABLE cached_responses (
        cache_key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL)''',
        );
        await database.execute('''CREATE TABLE outbox (
        id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL,
        created_at TEXT NOT NULL, status TEXT NOT NULL, error TEXT)''');
      },
    );
    return _database!;
  }

  Future<String?> get serverUrl async => _secure.read(key: 'hisab_server_url');
  Future<void> setServerUrl(String value) =>
      _secure.write(key: 'hisab_server_url', value: value);
  Future<String?> get token async => _secure.read(key: 'hisab_session_token');
  Future<Map<String, dynamic>?> get session async {
    final raw = await _secure.read(key: 'hisab_cached_session');
    if (raw == null) return null;
    try {
      return Map<String, dynamic>.from(jsonDecode(raw) as Map);
    } catch (_) {
      return null;
    }
  }

  Future<void> saveSession(String token, Map<String, dynamic> session) async {
    await _secure.write(key: 'hisab_session_token', value: token);
    await _secure.write(
      key: 'hisab_cached_session',
      value: jsonEncode(session),
    );
  }

  Future<void> clearSession() async {
    await _secure.delete(key: 'hisab_session_token');
    await _secure.delete(key: 'hisab_cached_session');
    await _secure.delete(key: _sessionVerifiedAtKey);
  }

  /// Records the last time the server positively confirmed the session.
  /// Offline access is measured from this timestamp.
  Future<void> markSessionVerified([DateTime? at]) async {
    await _secure.write(
      key: _sessionVerifiedAtKey,
      value: (at ?? DateTime.now()).toUtc().toIso8601String(),
    );
  }

  Future<DateTime?> get sessionVerifiedAt async {
    final raw = await _secure.read(key: _sessionVerifiedAtKey);
    if (raw == null) return null;
    return DateTime.tryParse(raw)?.toUtc();
  }

  /// Legacy sessions created before offline verification timestamps existed
  /// are grandfathered so an app update never locks an existing user out.
  Future<bool> canUseOfflineSession(Duration maxAge) async {
    final verifiedAt = await sessionVerifiedAt;
    if (verifiedAt == null) return true;
    return DateTime.now().toUtc().difference(verifiedAt) <= maxAge;
  }

  Future<bool> get hasOfflineCredentials async =>
      (await _secure.read(key: _offlineEmailKey)) != null &&
      (await _secure.read(key: _offlineVerifierKey)) != null &&
      (await _secure.read(key: _offlineSaltKey)) != null;

  /// Stores a PBKDF2-HMAC-SHA256 verifier for the last successfully
  /// authenticated account. The plain-text password is never persisted.
  Future<void> saveOfflineCredentials(String email, String password) async {
    final random = Random.secure();
    final salt = Uint8List.fromList(
      List<int>.generate(16, (_) => random.nextInt(256)),
    );
    final verifier = _pbkdf2Sha256(password, salt, _offlineIterations, 32);
    await Future.wait([
      _secure.write(key: _offlineEmailKey, value: email.trim().toLowerCase()),
      _secure.write(key: _offlineSaltKey, value: base64Encode(salt)),
      _secure.write(key: _offlineVerifierKey, value: base64Encode(verifier)),
      _secure.write(
        key: _offlineIterationsKey,
        value: '$_offlineIterations',
      ),
      _secure.write(
        key: _offlineSavedAtKey,
        value: DateTime.now().toUtc().toIso8601String(),
      ),
    ]);
  }

  Future<bool> canUseOfflineCredentials(Duration maxAge) async {
    final raw = await _secure.read(key: _offlineSavedAtKey);
    if (raw == null) return hasOfflineCredentials;
    final savedAt = DateTime.tryParse(raw)?.toUtc();
    if (savedAt == null) return false;
    return DateTime.now().toUtc().difference(savedAt) <= maxAge;
  }

  Future<bool> verifyOfflineCredentials(
    String email,
    String password,
  ) async {
    final savedEmail = await _secure.read(key: _offlineEmailKey);
    final saltValue = await _secure.read(key: _offlineSaltKey);
    final verifierValue = await _secure.read(key: _offlineVerifierKey);
    if (savedEmail == null || saltValue == null || verifierValue == null) {
      return false;
    }
    if (savedEmail != email.trim().toLowerCase()) return false;
    final iterations = int.tryParse(
          await _secure.read(key: _offlineIterationsKey) ?? '',
        ) ??
        _offlineIterations;
    final salt = base64Decode(saltValue);
    final expected = base64Decode(verifierValue);
    final actual = _pbkdf2Sha256(password, salt, iterations, expected.length);
    return _constantTimeEquals(expected, actual);
  }

  Future<void> clearOfflineCredentials() async {
    await Future.wait([
      _secure.delete(key: _offlineEmailKey),
      _secure.delete(key: _offlineSaltKey),
      _secure.delete(key: _offlineVerifierKey),
      _secure.delete(key: _offlineIterationsKey),
      _secure.delete(key: _offlineSavedAtKey),
    ]);
  }

  /// Stable identifier for this installation. It replaces the previous shared
  /// "flutter-device" value so server-side sync records are per-device.
  Future<String> get deviceId async {
    final existing = await _secure.read(key: _deviceIdKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final value = const Uuid().v4();
    await _secure.write(key: _deviceIdKey, value: value);
    return value;
  }

  static Uint8List _pbkdf2Sha256(
    String password,
    List<int> salt,
    int iterations,
    int length,
  ) {
    final hmac = Hmac(sha256, utf8.encode(password));
    final result = Uint8List(length);
    var offset = 0;
    var block = 1;
    while (offset < length) {
      final blockBytes = <int>[
        ...salt,
        (block >> 24) & 0xff,
        (block >> 16) & 0xff,
        (block >> 8) & 0xff,
        block & 0xff,
      ];
      var u = Uint8List.fromList(hmac.convert(blockBytes).bytes);
      final t = Uint8List.fromList(u);
      for (var i = 1; i < iterations; i++) {
        u = Uint8List.fromList(hmac.convert(u).bytes);
        for (var j = 0; j < t.length; j++) {
          t[j] ^= u[j];
        }
      }
      final take = min(t.length, length - offset);
      result.setRange(offset, offset + take, t);
      offset += take;
      block += 1;
    }
    return result;
  }

  static bool _constantTimeEquals(List<int> a, List<int> b) {
    if (a.length != b.length) return false;
    var difference = 0;
    for (var i = 0; i < a.length; i++) {
      difference |= a[i] ^ b[i];
    }
    return difference == 0;
  }

  Future<void> cache(String key, Object? value) async {
    final database = await db;
    await database.insert(
        'cached_responses',
        {
          'cache_key': key,
          'value': jsonEncode(value),
          'updated_at': DateTime.now().toUtc().toIso8601String(),
        },
        conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<Map<String, dynamic>?> readCache(String key) async {
    final rows = await (await db).query(
      'cached_responses',
      where: 'cache_key = ?',
      whereArgs: [key],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    return {
      'data': jsonDecode(rows.first['value']! as String),
      'updatedAt': rows.first['updated_at'],
    };
  }

  Future<void> decrementCachedPosStock(
      Map<String, int> baseMilliByProduct) async {
    if (baseMilliByProduct.isEmpty) return;
    final database = await db;
    await database.transaction((txn) async {
      final rows = await txn.query(
        'cached_responses',
        where: 'cache_key = ?',
        whereArgs: ['/api/pos/data'],
        limit: 1,
      );
      if (rows.isEmpty) return;
      final data = Map<String, dynamic>.from(
        jsonDecode(rows.first['value']! as String) as Map,
      );
      final products = (data['products'] as List? ?? [])
          .whereType<Map>()
          .map((product) => Map<String, dynamic>.from(product))
          .toList();
      for (final product in products) {
        final deduction = baseMilliByProduct[product['id']?.toString()];
        if (deduction == null) continue;
        final available =
            int.tryParse(product['qtyMilli']?.toString() ?? '') ?? 0;
        product['qtyMilli'] =
            (available - deduction).clamp(0, available).toString();
      }
      data['products'] = products;
      await txn.update(
        'cached_responses',
        {
          'value': jsonEncode(data),
          'updated_at': DateTime.now().toUtc().toIso8601String()
        },
        where: 'cache_key = ?',
        whereArgs: ['/api/pos/data'],
      );
    });
  }

  Future<void> enqueue(
    String id,
    String path,
    Map<String, dynamic> body,
  ) async {
    await (await db).insert(
        'outbox',
        {
          'id': id,
          'path': path,
          'body': jsonEncode(body),
          'created_at': DateTime.now().toUtc().toIso8601String(),
          'status': 'pending',
          'error': null,
        },
        conflictAlgorithm: ConflictAlgorithm.ignore);
  }

  Future<List<Map<String, Object?>>> queue() async =>
      (await db).query('outbox', orderBy: 'created_at ASC');
  Future<int> get pendingCount async =>
      Sqflite.firstIntValue(
        await (await db).rawQuery(
          "SELECT COUNT(*) FROM outbox WHERE status IN ('pending','failed')",
        ),
      ) ??
      0;
  Future<void> removeQueued(String id) async {
    await (await db).delete('outbox', where: 'id = ?', whereArgs: [id]);
  }

  Future<void> failQueued(String id, String error) async {
    await (await db).update(
      'outbox',
      {'status': 'failed', 'error': error},
      where: 'id = ?',
      whereArgs: [id],
    );
  }

  Future<void> retryFailed() async {
    await (await db).update(
        'outbox',
        {
          'status': 'pending',
          'error': null,
        },
        where: "status = 'failed'");
  }

  Future<void> clearLocalData() async {
    final database = await db;
    await database.transaction((txn) async {
      await txn.delete('cached_responses');
      await txn.delete('outbox');
    });
  }

  Future<File> exportBackup() async {
    final database = await db;
    final caches = await database.query('cached_responses');
    final queueRows = await database.query('outbox');
    final payload = <String, Object?>{
      'format': 'hisab-mobile-backup',
      'version': 1,
      'createdAt': DateTime.now().toUtc().toIso8601String(),
      'cache': caches
          .map((row) => {...row, 'value': jsonDecode(row['value']! as String)})
          .toList(),
      'outbox': queueRows
          .map((row) => {...row, 'body': jsonDecode(row['body']! as String)})
          .toList(),
    };
    final directory = await getApplicationDocumentsDirectory();
    final file = File(
      p.join(
        directory.path,
        'hisab-mobile-backup-${DateTime.now().toIso8601String().replaceAll(':', '-')}.json',
      ),
    );
    await file.writeAsString(
      const JsonEncoder.withIndent('  ').convert(payload),
      flush: true,
    );
    return file;
  }

  Future<void> restoreBackup(Map<String, dynamic> payload) async {
    if (payload['format'] != 'hisab-mobile-backup' ||
        payload['version'] != 1 ||
        payload['cache'] is! List ||
        payload['outbox'] is! List) {
      throw const FormatException(
        'ملف النسخة الاحتياطية غير صالح أو غير مدعوم.',
      );
    }
    final database = await db;
    await database.transaction((txn) async {
      await txn.delete('cached_responses');
      await txn.delete('outbox');
      for (final item in payload['cache'] as List) {
        final row = Map<String, dynamic>.from(item as Map);
        await txn.insert('cached_responses', {
          'cache_key': row['cache_key'],
          'value': jsonEncode(row['value']),
          'updated_at': row['updated_at'],
        });
      }
      for (final item in payload['outbox'] as List) {
        final row = Map<String, dynamic>.from(item as Map);
        await txn.insert('outbox', {
          'id': row['id'],
          'path': row['path'],
          'body': jsonEncode(row['body']),
          'created_at': row['created_at'],
          'status': row['status'],
          'error': row['error'],
        });
      }
    });
  }
}
