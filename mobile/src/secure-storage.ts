import * as SecureStore from "expo-secure-store";

export type MobileSession = {
  userId: string;
  businessId: string;
  email: string;
  name: string;
  role: string;
  businessName: string;
};

const SERVER_URL_KEY = "hisab_server_url";
const TOKEN_KEY = "hisab_session_token";
const SESSION_KEY = "hisab_cached_session";

export function normalizeServerUrl(value: string, allowLocalHttp = __DEV__): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/]+(?:\/.*)?$/i.test(trimmed)) {
    throw new Error("أدخل عنوان خادم صحيحاً، مثل https://accounting.example.com");
  }
  const parsed = new URL(trimmed);
  const hostname = parsed.hostname.toLowerCase();
  const isPrivateIpv4 =
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname);
  const isLocal =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".local") ||
    isPrivateIpv4;
  if (parsed.protocol !== "https:" && !(allowLocalHttp && parsed.protocol === "http:" && isLocal)) {
    throw new Error("يجب استخدام HTTPS عند الاتصال بخادم عبر الإنترنت.");
  }
  return trimmed;
}

export async function getServerUrl(): Promise<string> {
  const saved = await SecureStore.getItemAsync(SERVER_URL_KEY);
  const configured = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (configured) return normalizeServerUrl(configured, !__DEV__);
  return saved ? normalizeServerUrl(saved, __DEV__) : "";
}

export async function saveServerUrl(value: string): Promise<string> {
  const normalized = normalizeServerUrl(value, __DEV__);
  await SecureStore.setItemAsync(SERVER_URL_KEY, normalized);
  return normalized;
}

export async function getSessionToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function saveAuthenticatedSession(
  token: string,
  session: MobileSession,
): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

export async function getCachedSession(): Promise<MobileSession | null> {
  const value = await SecureStore.getItemAsync(SESSION_KEY);
  if (!value) return null;
  try {
    return JSON.parse(value) as MobileSession;
  } catch {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export async function clearAuthenticatedSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(TOKEN_KEY),
    SecureStore.deleteItemAsync(SESSION_KEY),
  ]);
}
