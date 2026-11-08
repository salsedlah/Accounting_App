import 'package:flutter_test/flutter_test.dart';
import 'package:hisab_mobile/app_config.dart';

void main() {
  group('AppConfig.validateBaseUrl', () {
    test('accepts a public HTTPS endpoint in production', () {
      expect(
        AppConfig.validateBaseUrl(
          'https://accounting-api.example.com/',
          production: true,
        ),
        'https://accounting-api.example.com',
      );
    });

    test('rejects localhost in production', () {
      for (final url in [
        'http://localhost:3000',
        'https://127.0.0.1:3000',
        'http://0.0.0.0:3000',
        'http://[::1]:3000',
        'https://server.local',
      ]) {
        expect(
          () => AppConfig.validateBaseUrl(url, production: true),
          throwsFormatException,
          reason: url,
        );
      }
    });

    test('rejects private and non-HTTPS production endpoints', () {
      for (final url in [
        'http://accounting-api.example.com',
        'https://10.0.0.5',
        'https://192.168.1.20',
        'https://172.16.4.9',
        'https://169.254.2.1',
      ]) {
        expect(
          () => AppConfig.validateBaseUrl(url, production: true),
          throwsFormatException,
          reason: url,
        );
      }
    });

    test('allows local HTTP only in development', () {
      expect(
        AppConfig.validateBaseUrl(
          'http://127.0.0.1:3000',
          production: false,
        ),
        'http://127.0.0.1:3000',
      );
      expect(
        () => AppConfig.validateBaseUrl(
          'http://accounting-api.example.com',
          production: false,
        ),
        throwsFormatException,
      );
    });

    test('rejects URLs with credentials, query, or fragment', () {
      for (final url in [
        'https://user:pass@api.example.com',
        'https://api.example.com?x=1',
        'https://api.example.com#fragment',
      ]) {
        expect(
          () => AppConfig.validateBaseUrl(url, production: true),
          throwsFormatException,
          reason: url,
        );
      }
    });
  });

  group('OfflineAuthPolicy', () {
    test('parses supported names', () {
      expect(
        OfflineAuthPolicy.parse('require-online'),
        OfflineAuthPolicy.requireOnline,
      );
      expect(
        OfflineAuthPolicy.parse('cached_session'),
        OfflineAuthPolicy.cachedSession,
      );
      expect(
        OfflineAuthPolicy.parse('cached-credentials'),
        OfflineAuthPolicy.cachedCredentials,
      );
      expect(
        OfflineAuthPolicy.parse('unknown-value'),
        OfflineAuthPolicy.cachedCredentials,
      );
    });

    test('exposes capabilities', () {
      expect(OfflineAuthPolicy.requireOnline.allowsOfflineSession, isFalse);
      expect(
        OfflineAuthPolicy.cachedSession.allowsOfflinePasswordLogin,
        isFalse,
      );
      expect(
        OfflineAuthPolicy.cachedCredentials.allowsOfflineSession,
        isTrue,
      );
      expect(
        OfflineAuthPolicy.cachedCredentials.allowsOfflinePasswordLogin,
        isTrue,
      );
    });
  });
}
