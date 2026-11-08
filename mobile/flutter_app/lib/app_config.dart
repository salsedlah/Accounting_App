import 'package:flutter/foundation.dart' show kReleaseMode;

/// Authentication policy controls what the app is allowed to do while the
/// production API is unreachable.
enum OfflineAuthPolicy {
  /// Always require a successful online login. Cached sessions are not used
  /// when the server cannot be reached.
  requireOnline,

  /// Allow the last verified session to be resumed offline for a limited
  /// grace period. Re-login requires the server.
  cachedSession,

  /// Allow the last verified session to be resumed offline and allow
  /// password login against the locally stored PBKDF2 verifier. This is the
  /// offline-first default for POS devices.
  cachedCredentials;

  static OfflineAuthPolicy parse(String value) {
    switch (value.trim().toLowerCase().replaceAll('_', '-')) {
      case 'require-online':
      case 'online-only':
        return OfflineAuthPolicy.requireOnline;
      case 'cached-session':
      case 'session':
        return OfflineAuthPolicy.cachedSession;
      case 'cached-credentials':
      case 'offline-credentials':
      case 'offline':
        return OfflineAuthPolicy.cachedCredentials;
      default:
        return OfflineAuthPolicy.cachedCredentials;
    }
  }

  bool get allowsOfflineSession => this != OfflineAuthPolicy.requireOnline;
  bool get allowsOfflinePasswordLogin =>
      this == OfflineAuthPolicy.cachedCredentials;
}

/// Compile-time production configuration.
///
/// Production builds must be created with an API endpoint, for example:
///
///   flutter build apk --release \
///     --dart-define=API_BASE_URL=https://accounting-api.example.com
///
/// No build falls back to localhost. Set a reachable development URL explicitly,
/// and provide the production HTTPS API URL when building a release.
class AppConfig {
  AppConfig._();

  static const String _compiledApiBaseUrl =
      String.fromEnvironment('API_BASE_URL');

  static const String offlineAuthPolicyName = String.fromEnvironment(
    'OFFLINE_AUTH_POLICY',
    defaultValue: 'cached-credentials',
  );

  static const int offlineSessionDays = int.fromEnvironment(
    'OFFLINE_SESSION_DAYS',
    defaultValue: 30,
  );

  static const int offlineCredentialDays = int.fromEnvironment(
    'OFFLINE_CREDENTIAL_DAYS',
    defaultValue: 90,
  );

  static const bool allowServerOverride = bool.fromEnvironment(
    'ALLOW_SERVER_OVERRIDE',
    defaultValue: true,
  );

  static bool get isProduction => kReleaseMode;

  static Duration get offlineSessionDuration =>
      Duration(days: offlineSessionDays < 1 ? 1 : offlineSessionDays);

  static Duration get offlineCredentialDuration =>
      Duration(days: offlineCredentialDays < 1 ? 1 : offlineCredentialDays);

  static OfflineAuthPolicy get offlineAuthPolicy =>
      OfflineAuthPolicy.parse(offlineAuthPolicyName);

  /// The API endpoint embedded in the build, or null when the build was not
  /// configured for production.
  static String? get productionApiBaseUrl {
    final value = _compiledApiBaseUrl.trim();
    if (value.isEmpty) return null;
    return validateBaseUrl(value);
  }

  /// Validate and normalise an API base URL.
  ///
  /// Release builds only accept public HTTPS endpoints. Debug builds may use
  /// HTTP on localhost/private networks for development, but never for a
  /// public internet host.
  static String validateBaseUrl(String value, {bool? production}) {
    final isProduction = production ?? kReleaseMode;
    final trimmed = value.trim().replaceFirst(RegExp(r'/+$'), '');
    final uri = Uri.tryParse(trimmed);
    if (uri == null ||
        !uri.hasAuthority ||
        !{'http', 'https'}.contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment) {
      throw const FormatException(
        'أدخل رابط خادم صحيحاً مثل https://accounting.example.com',
      );
    }

    final host = uri.host.toLowerCase();
    final isLoopback = host == 'localhost' ||
        host == '::1' ||
        host == '0.0.0.0' ||
        RegExp(r'^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$').hasMatch(host);
    final isPrivate = _isPrivateHost(host) || host.endsWith('.local');

    if (isProduction) {
      if (isLoopback || isPrivate) {
        throw const FormatException(
          'لا يمكن استخدام localhost أو عنوان شبكة محلية في نسخة الإنتاج. '
          'استخدم رابط خادم منشور عبر HTTPS.',
        );
      }
      if (uri.scheme != 'https') {
        throw const FormatException('يجب استخدام HTTPS لخادم الإنتاج.');
      }
    } else if (uri.scheme == 'http' && !isLoopback && !isPrivate) {
      throw const FormatException(
        'يجب استخدام HTTPS عند الاتصال بخادم عبر الإنترنت.',
      );
    }

    return trimmed;
  }

  static bool _isPrivateHost(String host) {
    if (RegExp(r'^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$').hasMatch(host)) return true;
    if (RegExp(r'^192\.168\.\d{1,3}\.\d{1,3}$').hasMatch(host)) return true;
    if (RegExp(r'^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$').hasMatch(host)) {
      return true;
    }
    if (RegExp(r'^169\.254\.\d{1,3}\.\d{1,3}$').hasMatch(host)) return true;
    return false;
  }
}
