import { StatusBar } from "expo-status-bar";
import * as Network from "expo-network";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createRecord,
  getCachedJson,
  loginRequest,
  patchJson,
  postJson,
  syncOutbox,
  type CachedResult,
} from "./src/api";
import { pendingRequestCount, readCache, writeCache } from "./src/local-db";
import { APP_MODULES, FIELD_LABELS, ROLE_PERMISSIONS, type AppModule } from "./src/modules";
import {
  clearAuthenticatedSession,
  getCachedSession,
  getServerUrl,
  saveAuthenticatedSession,
  saveServerUrl,
  type MobileSession,
} from "./src/secure-storage";

type Screen =
  | { name: "home" }
  | { name: "settings" }
  | { name: "module"; module: AppModule }
  | { name: "create"; module: AppModule }
  | { name: "pos" }
  | { name: "ai" };

type PosUnit = {
  unitId: string;
  unitName: string;
  factorMilli: string;
  isBase: boolean;
};

type PosProduct = {
  id: string;
  name: string;
  sku: string;
  retailPriceMinor: string;
  qtyMilli: string;
  minStockMilli?: string;
  units: PosUnit[];
};

type PosData = {
  products: PosProduct[];
  customers: Array<{ id: string; name: string }>;
  cashboxes: Array<{ id: string; name: string; isDefault: boolean }>;
  business: { offlineSellLimitMilli: string };
};

type DataSection = { title: string; rows: Record<string, unknown>[] };

const COLORS = {
  brand: "#176b57",
  dark: "#123f35",
  background: "#f3f6f5",
  ink: "#172522",
  muted: "#697773",
  border: "#dce5e1",
  white: "#ffffff",
  amber: "#fff2cc",
  red: "#a52b2b",
};

const REPORT_TYPES = [
  { id: "sales", name: "المبيعات" },
  { id: "products", name: "المنتجات" },
  { id: "pnl", name: "الأرباح والخسائر" },
  { id: "inventory", name: "تقييم المخزون" },
  { id: "trial", name: "ميزان المراجعة" },
  { id: "balance", name: "الميزانية" },
  { id: "cashflow", name: "التدفق النقدي" },
  { id: "expenses", name: "المصروفات" },
  { id: "lowstock", name: "المخزون المنخفض" },
  { id: "documents", name: "المستندات" },
];

function randomKey(): string {
  return `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function minorToInput(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const amount = `${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  return negative ? `-${amount}` : amount;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (typeof value === "object") {
    if (Array.isArray(value)) return `${value.length} عناصر`;
    return JSON.stringify(value);
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date.toLocaleString("ar");
  }
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function makeSections(data: unknown, module: AppModule): DataSection[] {
  if (Array.isArray(data)) {
    return [{ title: module.title, rows: data.filter(isRecord) }];
  }
  if (!isRecord(data)) return [];

  if (module.collection && Array.isArray(data[module.collection])) {
    return [
      {
        title: module.title,
        rows: (data[module.collection] as unknown[]).filter(isRecord),
      },
    ];
  }

  const sections = Object.entries(data)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([key, rows]) => ({
      title: FIELD_LABELS[key] ?? key,
      rows: rows.filter(isRecord),
    }));
  const summary = Object.fromEntries(
    Object.entries(data).filter(([, value]) => !Array.isArray(value)),
  );
  if (Object.keys(summary).length > 0) {
    sections.unshift({ title: "ملخص", rows: [summary] });
  }
  return sections;
}

function readableField(key: string): string {
  return FIELD_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

function ActionButton({
  title,
  onPress,
  disabled,
  secondary,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabledButton,
        pressed && !disabled && styles.pressedButton,
      ]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryButtonText]}>{title}</Text>
    </Pressable>
  );
}

function Input({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  multiline,
  ltr,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "email-address" | "decimal-pad" | "numeric";
  multiline?: boolean;
  ltr?: boolean;
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="#9aa7a2"
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType ?? "default"}
        multiline={multiline}
        autoCapitalize={keyboardType === "email-address" ? "none" : "sentences"}
        autoCorrect={keyboardType !== "email-address"}
        textAlign={ltr ? "left" : "right"}
        style={[styles.input, multiline && styles.multilineInput]}
      />
    </View>
  );
}

function Header({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      <View style={styles.headerSide}>
        {onBack ? (
          <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8}>
            <Text style={styles.headerBack}>رجوع</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.headerTitle}>{title}</Text>
      <View style={[styles.headerSide, styles.headerRight]}>{right}</View>
    </View>
  );
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [serverUrl, setServerUrl] = useState("");
  const [session, setSession] = useState<MobileSession | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [online, setOnline] = useState(false);
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);

  const refreshPending = useCallback(async () => {
    setPending(await pendingRequestCount());
  }, []);

  const sync = useCallback(async () => {
    if (!online || !session) return;
    setSyncing(true);
    try {
      const result = await syncOutbox();
      await refreshPending();
      if (result.failed > 0) {
        Alert.alert("اكتملت المزامنة جزئياً", `تمت مزامنة ${result.done} وبقيت ${result.failed} عملية.`);
      }
    } catch (error) {
      Alert.alert("تعذر بدء المزامنة", error instanceof Error ? error.message : "خطأ غير متوقع");
    } finally {
      setSyncing(false);
    }
  }, [online, refreshPending, session]);

  useEffect(() => {
    let active = true;
    void Promise.all([getServerUrl(), getCachedSession(), pendingRequestCount()]).then(
      ([url, cachedSession, count]) => {
        if (!active) return;
        setServerUrl(url);
        setSession(cachedSession);
        setPending(count);
        setBooting(false);
      },
    ).catch((error: unknown) => {
      if (!active) return;
      setBooting(false);
      Alert.alert("تعذر فتح قاعدة البيانات المحلية", error instanceof Error ? error.message : "خطأ غير متوقع");
    });

    const syncIfAuthenticated = async () => {
      if (!(await getCachedSession())) return;
      const result = await syncOutbox();
      await refreshPending();
      if (result.failed > 0) {
        Alert.alert("مزامنة معلّقة", `تعذرت مزامنة ${result.failed} عملية. ستبقى محفوظة على الجهاز.`);
      }
    };
    void Network.getNetworkStateAsync().then((state) => {
      if (!active) return;
      setOnline(state.isConnected === true);
      if (state.isConnected === true) {
        void syncIfAuthenticated().catch((error: unknown) => {
          Alert.alert("تعذر بدء المزامنة", error instanceof Error ? error.message : "خطأ غير متوقع");
        });
      }
    });
    const subscription = Network.addNetworkStateListener((state) => {
      const connected = state.isConnected === true;
      setOnline(connected);
      if (connected) {
        void syncIfAuthenticated().catch((error: unknown) => {
          Alert.alert("تعذر بدء المزامنة", error instanceof Error ? error.message : "خطأ غير متوقع");
        });
      }
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [refreshPending]);

  const allowedModules = useMemo(() => {
    const permissions = ROLE_PERMISSIONS[session?.role ?? ""] ?? [];
    return APP_MODULES.filter((module) => !module.permission || permissions.includes(module.permission));
  }, [session?.role]);

  function openModule(module: AppModule) {
    if (module.id === "pos") setScreen({ name: "pos" });
    else if (module.id === "ai") setScreen({ name: "ai" });
    else setScreen({ name: "module", module });
  }

  async function submitLogin(email: string, password: string) {
    const response = await loginRequest<{ token?: string; session?: MobileSession }>(email, password);
    if (!response.token || !response.session) {
      throw new Error("استجابة تسجيل الدخول لا تحتوي على جلسة تطبيق صالحة.");
    }
    await saveAuthenticatedSession(response.token, response.session);
    setSession(response.session);
    await refreshPending();
  }

  async function saveConnection(value: string) {
    const url = await saveServerUrl(value);
    setServerUrl(url);
    setScreen({ name: "home" });
  }

  async function logout() {
    await clearAuthenticatedSession();
    setSession(null);
    setScreen({ name: "home" });
  }

  if (booting) {
    return (
      <SafeAreaView style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.brand} />
        <Text style={styles.mutedText}>جارٍ فتح قاعدة البيانات المحلية...</Text>
        <StatusBar style="dark" />
      </SafeAreaView>
    );
  }

  if (!session && screen.name === "settings") {
    return (
      <ConnectionScreen
        initialUrl={serverUrl}
        onBack={() => setScreen({ name: "home" })}
        onSave={saveConnection}
      />
    );
  }

  if (!session) {
    return (
      <AuthScreen
        initialUrl={serverUrl}
        onSaveConnection={saveConnection}
        onLogin={submitLogin}
        onSetup={() => setScreen({ name: "settings" })}
      />
    );
  }

  if (screen.name === "settings") {
    return (
      <ConnectionScreen
        initialUrl={serverUrl}
        onBack={() => setScreen({ name: "home" })}
        onSave={saveConnection}
      />
    );
  }

  if (screen.name === "module") {
    return (
      <ModuleScreen
        key={screen.module.id}
        module={screen.module}
        online={online}
        onBack={() => setScreen({ name: "home" })}
        onCreate={() => setScreen({ name: "create", module: screen.module })}
      />
    );
  }

  if (screen.name === "create") {
    return (
      <CreateRecordScreen
        key={screen.module.id}
        module={screen.module}
        online={online}
        onBack={() => setScreen({ name: "module", module: screen.module })}
        onSaved={() => setScreen({ name: "module", module: screen.module })}
      />
    );
  }

  if (screen.name === "pos") {
    return (
      <PosScreen
        online={online}
        onBack={() => setScreen({ name: "home" })}
        onSaved={refreshPending}
      />
    );
  }

  if (screen.name === "ai") {
    return <AssistantScreen onBack={() => setScreen({ name: "home" })} />;
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="حساب" />
      <ScrollView contentContainerStyle={styles.homeContent}>
        <Card style={styles.welcomeCard}>
          <Text style={styles.welcomeTitle}>مرحباً {session.name}</Text>
          <Text style={styles.welcomeSub}>{session.businessName}</Text>
          <View style={styles.connectionRow}>
            <View style={[styles.dot, { backgroundColor: online ? "#3aa978" : "#c78222" }]} />
            <Text style={styles.connectionText}>{online ? "الشبكة متاحة" : "دون اتصال — البيانات المحفوظة متاحة"}</Text>
          </View>
          {pending > 0 ? (
            <View style={styles.pendingBox}>
              <Text style={styles.pendingText}>{pending} عملية بانتظار المزامنة</Text>
              <ActionButton title={syncing ? "جارٍ..." : "مزامنة الآن"} onPress={() => void sync()} disabled={!online || syncing} />
            </View>
          ) : null}
        </Card>

        <View style={styles.sectionHeadingRow}>
          <Text style={styles.sectionTitle}>أقسام التطبيق</Text>
          <Text style={styles.mutedText}>{allowedModules.length} قسم</Text>
        </View>
        <View style={styles.moduleGrid}>
          {allowedModules.map((module, index) => (
            <Pressable
              key={module.id}
              onPress={() => openModule(module)}
              style={({ pressed }) => [styles.moduleTile, pressed && styles.pressedButton]}
            >
              <View style={[styles.moduleIcon, { backgroundColor: index % 2 ? "#e8f3ef" : "#eaf0fb" }]}>
                <Text style={styles.moduleIconText}>{module.title.slice(0, 1)}</Text>
              </View>
              <Text style={styles.moduleTitle}>{module.title}</Text>
            </Pressable>
          ))}
        </View>

        <Card>
          <Text style={styles.cardTitle}>الحساب والجهاز</Text>
          <Text style={styles.bodyText}>{session.email} · {session.role}</Text>
          <Text style={styles.smallMuted} numberOfLines={1}>{serverUrl}</Text>
          <View style={styles.rowButtons}>
            <ActionButton title="إعداد الخادم" secondary onPress={() => setScreen({ name: "settings" })} />
            <ActionButton title="تسجيل الخروج" secondary onPress={() => void logout()} />
          </View>
        </Card>
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function AuthScreen({
  initialUrl,
  onSaveConnection,
  onLogin,
  onSetup,
}: {
  initialUrl: string;
  onSaveConnection: (value: string) => Promise<void>;
  onLogin: (email: string, password: string) => Promise<void>;
  onSetup: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function login() {
    setLoading(true);
    setError("");
    try {
      await onSaveConnection(url);
      await onLogin(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تسجيل الدخول");
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.authContent} keyboardShouldPersistTaps="handled">
          <View style={styles.logoBox}><Text style={styles.logoText}>ح</Text></View>
          <Text style={styles.authTitle}>حساب</Text>
          <Text style={styles.authSub}>تطبيق المحاسبة والمخزون</Text>
          <Card style={styles.authCard}>
            <Input label="عنوان الخادم" value={url} onChangeText={setUrl} placeholder="https://accounting.example.com" ltr />
            <Input label="البريد الإلكتروني" value={email} onChangeText={setEmail} placeholder="name@example.com" keyboardType="email-address" ltr />
            <Input label="كلمة المرور" value={password} onChangeText={setPassword} secureTextEntry />
            {error ? <Text style={styles.errorText}>{error}</Text> : null}
            <ActionButton title={loading ? "جارٍ تسجيل الدخول..." : "تسجيل الدخول"} onPress={() => void login()} disabled={loading || !email || !password} />
            <Text style={styles.smallMuted}>يلزم تسجيل الدخول مرة واحدة على الأقل قبل استخدام البيانات المحفوظة دون اتصال.</Text>
            <Pressable onPress={onSetup} style={styles.textButton}>
              <Text style={styles.linkText}>إعداد عنوان الخادم</Text>
            </Pressable>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function ConnectionScreen({
  initialUrl,
  onBack,
  onSave,
}: {
  initialUrl: string;
  onBack: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSave(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر حفظ عنوان الخادم");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="اتصال الخادم" onBack={onBack} />
      <View style={styles.pageContent}>
        <Card>
          <Text style={styles.bodyText}>أدخل رابط API المنشور عبر HTTPS. لا تستخدم localhost أو عنوان الكمبيوتر المحلي في نسخة الإنتاج.</Text>
          <Input label="عنوان الخادم" value={url} onChangeText={setUrl} placeholder="https://accounting.example.com" ltr />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <ActionButton title={saving ? "جارٍ الحفظ..." : "حفظ العنوان"} onPress={() => void save()} disabled={saving} />
        </Card>
      </View>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function ModuleScreen({
  module,
  online,
  onBack,
  onCreate,
}: {
  module: AppModule;
  online: boolean;
  onBack: () => void;
  onCreate: () => void;
}) {
  const [result, setResult] = useState<CachedResult<unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [reportType, setReportType] = useState("sales");
  const [reportFrom, setReportFrom] = useState("");
  const [reportTo, setReportTo] = useState("");
  const [appliedReportFrom, setAppliedReportFrom] = useState("");
  const [appliedReportTo, setAppliedReportTo] = useState("");
  const [reportDateError, setReportDateError] = useState("");
  const reportQuery = [
    `type=${reportType}`,
    appliedReportFrom ? `from=${appliedReportFrom}` : "",
    appliedReportTo ? `to=${appliedReportTo}` : "",
  ].filter(Boolean).join("&");
  const endpoint = module.id === "reports" ? `/api/reports?${reportQuery}` : module.endpoint;

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const data = await getCachedJson<unknown>(endpoint);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تحميل بيانات القسم");
      const cached = await readCache<unknown>(endpoint);
      if (cached) setResult({ data: cached.value, cached: true, updatedAt: cached.updatedAt });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  const sections = useMemo(
    () => makeSections(result?.data, module).map((section) => ({
      ...section,
      rows: section.rows.filter((row) => !search || JSON.stringify(row).toLowerCase().includes(search.toLowerCase())),
    })),
    [module, result?.data, search],
  );

  return (
    <SafeAreaView style={styles.screen}>
      <Header
        title={module.title}
        onBack={onBack}
        right={
          <View style={styles.headerActions}>
            {module.id !== "invoices" && module.id !== "reports" ? (
              <Pressable onPress={onCreate} hitSlop={8}>
                <Text style={styles.headerBack}>إضافة</Text>
              </Pressable>
            ) : null}
            <Text style={styles.onlineLabel}>{online ? "متصل" : "دون اتصال"}</Text>
          </View>
        }
      />
      {module.id === "reports" ? (
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reportTabs}>
            {REPORT_TYPES.map((item) => (
              <Pressable
                key={item.id}
                onPress={() => setReportType(item.id)}
                style={[styles.choiceChip, reportType === item.id && styles.choiceChipSelected]}
              >
                <Text style={[styles.choiceText, reportType === item.id && styles.choiceTextSelected]}>{item.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
          <View style={styles.reportDateRow}>
            <TextInput value={reportTo} onChangeText={setReportTo} placeholder="إلى YYYY-MM-DD" placeholderTextColor="#9aa7a2" style={styles.reportDateInput} />
            <TextInput value={reportFrom} onChangeText={setReportFrom} placeholder="من YYYY-MM-DD" placeholderTextColor="#9aa7a2" style={styles.reportDateInput} />
          </View>
          <View style={styles.reportApplyButton}>
            <ActionButton
              title="تطبيق الفترة"
              onPress={() => {
                const validDate = (value: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);
                if (!validDate(reportFrom) || !validDate(reportTo)) {
                  setReportDateError("أدخل التاريخ بصيغة YYYY-MM-DD.");
                  return;
                }
                setReportDateError("");
                setAppliedReportFrom(reportFrom);
                setAppliedReportTo(reportTo);
              }}
              secondary
            />
          </View>
          {reportDateError ? <Text style={styles.inlineError}>{reportDateError}</Text> : null}
        </View>
      ) : null}
      <TextInput value={search} onChangeText={setSearch} placeholder="بحث في البيانات" placeholderTextColor="#9aa7a2" style={styles.searchInput} textAlign="right" />
      {result?.cached ? (
        <Text style={styles.cacheNotice}>بيانات محفوظة محلياً · {result.updatedAt ? new Date(result.updatedAt).toLocaleString("ar") : ""}</Text>
      ) : null}
      {error ? <Text style={styles.inlineError}>{error}</Text> : null}
      {loading && !result ? (
        <View style={styles.centered}><ActivityIndicator color={COLORS.brand} /><Text style={styles.mutedText}>جارٍ تحميل البيانات...</Text></View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.pageContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} />}
        >
          {sections.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text style={styles.sectionTitle}>{section.title} ({section.rows.length})</Text>
              {section.rows.slice(0, 100).map((row, index) => {
                const fields = Object.entries(row).filter(([key]) => !/password|secret|token|hash/i.test(key)).slice(0, 7);
                return (
                  <Card key={String(row.id ?? row.invoiceNo ?? index)}>
                    {fields.map(([key, value]) => (
                      <View key={key} style={styles.dataRow}>
                        <Text style={styles.dataValue} numberOfLines={2}>{formatValue(value)}</Text>
                        <Text style={styles.dataLabel}>{readableField(key)}</Text>
                      </View>
                    ))}
                  </Card>
                );
              })}
              {section.rows.length === 0 ? <Text style={styles.emptyText}>لا توجد بيانات محفوظة في هذا القسم.</Text> : null}
            </View>
          ))}
          {!sections.length ? <Text style={styles.emptyText}>لا توجد بيانات لعرضها.</Text> : null}
          <Text style={styles.smallMuted}>يمكن إنشاء السجلات المدعومة من زر «إضافة». تُحفَظ عمليات البيع والمشتريات والمصروفات والدفعات محلياً عند انقطاع الاتصال.</Text>
        </ScrollView>
      )}
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function PosScreen({
  online,
  onBack,
  onSaved,
}: {
  online: boolean;
  onBack: () => void;
  onSaved: () => Promise<void>;
}) {
  const [result, setResult] = useState<CachedResult<PosData> | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setResult(await getCachedJson<PosData>("/api/pos/data"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر تحميل المنتجات");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const products = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (result?.data.products ?? []).filter((product) =>
      !query || product.name.toLowerCase().includes(query) || product.sku.toLowerCase().includes(query),
    );
  }, [result?.data.products, search]);

  const cartTotal = useMemo(() => {
    return Object.entries(cart).reduce((sum, [id, quantity]) => {
      const product = result?.data.products.find((item) => item.id === id);
      return sum + BigInt(product?.retailPriceMinor ?? "0") * BigInt(quantity);
    }, 0n);
  }, [cart, result?.data.products]);

  const cartBaseByProduct = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const product of result?.data.products ?? []) {
      const quantity = cart[product.id] ?? 0;
      if (!quantity) continue;
      const unit = product.units.find((item) => item.isBase) ?? product.units[0];
      map.set(product.id, BigInt(quantity) * BigInt(unit?.factorMilli ?? "1000"));
    }
    return map;
  }, [cart, result?.data.products]);

  async function submitSale() {
    if (!result || Object.keys(cart).length === 0) return;
    const items = Object.entries(cart).flatMap(([productId, quantity]) => {
      const product = result.data.products.find((item) => item.id === productId);
      const unit = product?.units.find((item) => item.isBase) ?? product?.units[0];
      return product && unit
        ? [{ productId, unitId: unit.unitId, qty: String(quantity), priceTier: "retail" }]
        : [];
    });
    if (items.length !== Object.keys(cart).length) {
      setError("تعذر تحديد وحدة البيع لأحد المنتجات.");
      return;
    }
    const shortage = Object.entries(cart).find(([productId, quantity]) => {
      const product = result.data.products.find((item) => item.id === productId);
      if (!product) return false;
      const unit = product.units.find((item) => item.isBase) ?? product.units[0];
      return BigInt(quantity) * BigInt(unit?.factorMilli ?? "1000") > BigInt(product.qtyMilli);
    });
    if (shortage) {
      const product = result.data.products.find((item) => item.id === shortage[0]);
      const unit = product?.units.find((item) => item.isBase) ?? product?.units[0];
      const available = product ? BigInt(product.qtyMilli) : 0n;
      setError(
        `الكمية المطلوبة أكبر من المخزون المتوفر${product ? ` للمنتج ${product.name}` : ""}. الكمية المتبقية: ${(
          Number(available) / 1000
        ).toLocaleString("ar")} ${unit?.unitName ?? ""}`,
      );
      return;
    }
    if (!online) {
      const baseQuantity = Object.entries(cart).reduce((sum, [productId, quantity]) => {
        const product = result.data.products.find((item) => item.id === productId);
        const unit = product?.units.find((item) => item.isBase) ?? product?.units[0];
        return sum + BigInt(quantity) * BigInt(unit?.factorMilli ?? "1000");
      }, 0n);
      const limit = BigInt(result.data.business?.offlineSellLimitMilli ?? "0");
      if (limit > 0n && baseQuantity > limit) {
        setError("تجاوزت كمية البيع حد العمل دون اتصال المسموح به.");
        return;
      }
    }

    setSaving(true);
    setError("");
    setMessage("");
    try {
      const body: Record<string, unknown> = {
        items,
        paymentType: "cash",
        paid: minorToInput(cartTotal),
        idempotencyKey: randomKey(),
        offline: !online,
        notes: "تطبيق الجوال",
      };
      const saved = await createRecord<{ invoiceNo?: string }>("/api/sales", body);
      if (saved.queued || !online) {
        const nextData = {
          ...result.data,
          products: result.data.products.map((product) => {
            const quantity = cart[product.id] ?? 0;
            const unit = product.units.find((item) => item.isBase) ?? product.units[0];
            const delta = BigInt(quantity) * BigInt(unit?.factorMilli ?? "1000");
            return { ...product, qtyMilli: (BigInt(product.qtyMilli) - delta).toString() };
          }),
        };
        setResult({ ...result, data: nextData, cached: true });
        await writeCache("/api/pos/data", nextData);
      }
      setCart({});
      setMessage(saved.queued ? "حُفظت الفاتورة محلياً وستُزامن عند عودة الاتصال." : "تم تسجيل الفاتورة بنجاح.");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر حفظ الفاتورة");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="نقطة البيع" onBack={onBack} right={<Text style={styles.onlineLabel}>{online ? "متصل" : "دون اتصال"}</Text>} />
      <View style={styles.posSearchWrap}>
        <TextInput value={search} onChangeText={setSearch} placeholder="ابحث عن منتج أو رمز" placeholderTextColor="#9aa7a2" style={styles.searchInput} textAlign="right" />
      </View>
      {result?.cached ? <Text style={styles.cacheNotice}>كتالوج مخزّن محلياً</Text> : null}
      {error ? <Text style={styles.inlineError}>{error}</Text> : null}
      {message ? <Text style={styles.successNotice}>{message}</Text> : null}
      {loading ? (
        <View style={styles.centered}><ActivityIndicator color={COLORS.brand} /><Text style={styles.mutedText}>جارٍ تحميل المنتجات...</Text></View>
      ) : (
        <>
          <FlatList
            data={products}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.posList}
            renderItem={({ item }) => {
              const quantity = cart[item.id] ?? 0;
              const unit = item.units.find((entry) => entry.isBase) ?? item.units[0];
              const unitFactor = BigInt(unit?.factorMilli ?? "1000");
              const available = BigInt(item.qtyMilli || "0");
              const inCart = cartBaseByProduct.get(item.id) ?? 0n;
              const remaining = available > inCart ? available - inCart : 0n;
              const out = available <= 0n;
              const maxed = remaining < unitFactor;
              const fmt = (milli: bigint) => (Number(milli) / 1000).toLocaleString("ar");
              return (
                <Card style={styles.productCard}>
                  <View style={styles.productInfo}>
                    <Text style={styles.cardTitle}>{item.name}</Text>
                    <Text style={styles.smallMuted}>{item.sku} · {item.units[0]?.unitName ?? "وحدة"}</Text>
                    <Text style={styles.smallMuted}>المخزون المتوفر: {fmt(available)} {unit?.unitName ?? ""}</Text>
                    {quantity ? <Text style={styles.smallMuted}>الكمية في السلة: {fmt(inCart)} {unit?.unitName ?? ""}</Text> : null}
                    <Text style={[styles.smallMuted, remaining === 0n && { color: COLORS.red }]}>المتبقي: {fmt(remaining)} {unit?.unitName ?? ""}</Text>
                    {out ? (
                      <Text style={[styles.smallMuted, { color: COLORS.red }]}>نفدت الكمية</Text>
                    ) : maxed ? (
                      <Text style={[styles.smallMuted, { color: COLORS.red }]}>وصلت للحد الأقصى المتاح</Text>
                    ) : null}
                    <Text style={styles.priceText}>{(Number(item.retailPriceMinor) / 100).toLocaleString("ar")} ر.ي</Text>
                  </View>
                  <View style={styles.quantityControls}>
                    <Pressable style={styles.quantityButton} onPress={() => setCart((value) => {
                      const next = { ...value };
                      if ((next[item.id] ?? 0) <= 1) delete next[item.id];
                      else next[item.id] -= 1;
                      return next;
                    })}><Text style={styles.quantityButtonText}>−</Text></Pressable>
                    <Text style={styles.quantityText}>{quantity}</Text>
                    <Pressable
                      style={[styles.quantityButton, (out || maxed) && { opacity: 0.4 }]}
                      disabled={out || maxed}
                      onPress={() => setCart((value) => ({ ...value, [item.id]: (value[item.id] ?? 0) + 1 }))}
                    ><Text style={styles.quantityButtonText}>+</Text></Pressable>
                  </View>
                </Card>
              );
            }}
            ListEmptyComponent={<Text style={styles.emptyText}>لا توجد منتجات مطابقة أو بيانات محفوظة.</Text>}
          />
          <View style={styles.checkoutBar}>
            <View>
              <Text style={styles.smallMuted}>الإجمالي</Text>
              <Text style={styles.checkoutTotal}>{(Number(cartTotal) / 100).toLocaleString("ar")} ر.ي</Text>
            </View>
            <ActionButton title={saving ? "جارٍ الحفظ..." : "حفظ الفاتورة"} onPress={() => void submitSale()} disabled={saving || cartTotal === 0n} />
          </View>
        </>
      )}
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

type LookupParty = { id: string; name: string };
type LookupUnit = { id: string; name: string };
type LookupProduct = {
  id: string;
  name: string;
  units: PosUnit[];
};
type LookupData = {
  units?: LookupUnit[];
  products?: LookupProduct[];
  customers?: LookupParty[];
  suppliers?: LookupParty[];
  cashboxes?: Array<{ id: string; name: string; isDefault?: boolean }>;
};

function ChoiceList({
  title,
  items,
  selected,
  onSelect,
}: {
  title: string;
  items: Array<{ id: string; name: string }>;
  selected: string;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={styles.inputGroup}>
      <Text style={styles.inputLabel}>{title}</Text>
      {items.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.choiceRow}>
          {items.slice(0, 40).map((item) => (
            <Pressable
              key={item.id}
              onPress={() => onSelect(item.id)}
              style={[styles.choiceChip, selected === item.id && styles.choiceChipSelected]}
            >
              <Text style={[styles.choiceText, selected === item.id && styles.choiceTextSelected]}>{item.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <Text style={styles.smallMuted}>لا توجد خيارات محفوظة. اتصل بالخادم وافتح القسم المرتبط أولاً.</Text>
      )}
    </View>
  );
}

function CreateRecordScreen({
  module,
  online,
  onBack,
  onSaved,
}: {
  module: AppModule;
  online: boolean;
  onBack: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [lookups, setLookups] = useState<LookupData>({});
  const [loadingLookups, setLoadingLookups] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const requiredLookups = useMemo(() => {
    switch (module.id) {
      case "products":
        return ["/api/catalog"];
      case "purchases":
        return ["/api/pos/data", "/api/suppliers"];
      case "debts":
      case "supplier-debts":
        return ["/api/customers", "/api/suppliers"];
      case "inventory":
        return ["/api/pos/data"];
      case "cashbox":
        return ["/api/cashbox"];
      case "settings":
        return ["/api/settings"];
      default:
        return [];
    }
  }, [module.id]);

  useEffect(() => {
    let active = true;
    if (!requiredLookups.length) return;
    setLoadingLookups(true);
    void (async () => {
      const loaded: Record<string, unknown> = {};
      for (const endpoint of requiredLookups) {
        try {
          loaded[endpoint] = (await getCachedJson<unknown>(endpoint)).data;
        } catch (err) {
          if (active) setError(err instanceof Error ? err.message : "تعذر تحميل بيانات الاختيار");
          break;
        }
      }
      if (active) {
        const pos = loaded["/api/pos/data"] as PosData | undefined;
        const catalog = loaded["/api/catalog"] as { units?: LookupUnit[] } | undefined;
        const parties = loaded["/api/customers"] as { customers?: LookupParty[] } | undefined;
        const suppliers = loaded["/api/suppliers"] as { suppliers?: LookupParty[] } | undefined;
        const cashboxData = loaded["/api/cashbox"] as { cashboxes?: LookupData["cashboxes"] } | undefined;
        const settings = loaded["/api/settings"] as {
          business?: {
            name?: string;
            phone?: string | null;
            address?: string | null;
            taxEnabled?: boolean;
            taxRateBp?: number;
          };
        } | undefined;
        setLookups({
          products: pos?.products,
          customers: parties?.customers,
          suppliers: suppliers?.suppliers,
          units: catalog?.units,
          cashboxes: cashboxData?.cashboxes,
        });
        if (settings?.business) {
          const business = settings.business;
          setValues((current) => ({
            ...current,
            name: business.name ?? "",
            phone: business.phone ?? "",
            address: business.address ?? "",
            taxEnabled: String(business.taxEnabled ?? false),
            taxRate: String((business.taxRateBp ?? 0) / 100),
          }));
        }
        const defaultCashbox = cashboxData?.cashboxes?.find((item) => item.isDefault);
        if (defaultCashbox) setValues((current) => ({ ...current, cashboxId: current.cashboxId || defaultCashbox.id }));
      }
      if (active) setLoadingLookups(false);
    })();
    return () => {
      active = false;
    };
  }, [requiredLookups]);

  const selectedProduct = lookups.products?.find((item) => item.id === values.productId);
  const productUnits = selectedProduct?.units.map((unit) => ({ id: unit.unitId, name: unit.unitName })) ?? [];
  const units = lookups.units ?? [];

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    setSaving(true);
    setError("");
    try {
      let queued = false;
      switch (module.id) {
        case "customers":
          await postJson("/api/customers", {
            name: values.name,
            phone: values.phone || null,
            address: values.address || null,
            creditLimit: values.creditLimit || "0",
          });
          break;
        case "suppliers":
          await postJson("/api/suppliers", {
            name: values.name,
            phone: values.phone || null,
            address: values.address || null,
            notes: values.notes || null,
          });
          break;
        case "products": {
          const unitId = values.unitId || units[0]?.id;
          if (!unitId) throw new Error("لا توجد وحدة قياس. أضف وحدة من إعدادات النظام أولاً.");
          await postJson("/api/products", {
            name: values.name,
            sku: values.sku,
            barcode: values.barcode || null,
            baseUnitId: unitId,
            purchaseCost: values.purchaseCost,
            retailPrice: values.retailPrice,
            wholesalePrice: values.wholesalePrice || values.retailPrice,
            minStock: values.minStock || "0",
            units: [{ unitId, factor: "1" }],
          });
          break;
        }
        case "expenses": {
          const result = await createRecord("/api/expenses", {
            category: values.category,
            description: values.description,
            amount: values.amount,
            idempotencyKey: randomKey(),
          });
          queued = result.queued;
          break;
        }
        case "purchases": {
          const product = selectedProduct;
          const unitId = values.unitId || product?.units.find((unit) => unit.isBase)?.unitId || product?.units[0]?.unitId;
          if (!values.supplierId || !product || !unitId) throw new Error("اختر مورداً ومنتجاً ووحدة قياس.");
          const result = await createRecord("/api/purchases", {
            supplierId: values.supplierId,
            items: [{ productId: product.id, unitId, qty: values.qty, unitCost: values.unitCost || "0" }],
            paid: values.paid || "0",
            idempotencyKey: randomKey(),
          });
          queued = result.queued;
          break;
        }
        case "debts":
        case "supplier-debts": {
          const supplierPayment = module.id === "supplier-debts";
          const partyId = values.partyId;
          if (!partyId) throw new Error("اختر الطرف أولاً.");
          const result = await createRecord("/api/payments", {
            direction: supplierPayment ? "supplier_payment" : "customer_receipt",
            ...(supplierPayment ? { supplierId: partyId } : { customerId: partyId }),
            amount: values.amount,
            method: "cash",
            cashboxId: values.cashboxId || null,
            idempotencyKey: randomKey(),
          });
          queued = result.queued;
          break;
        }
        case "inventory":
          if (!values.productId) throw new Error("اختر المنتج أولاً.");
          await postJson("/api/inventory/adjust", {
            productId: values.productId,
            direction: values.direction || "increase",
            qty: values.qty,
            unitCost: values.unitCost || undefined,
            reason: values.reason,
          });
          break;
        case "stocktaking":
          await postJson("/api/stocktaking", { title: values.title });
          break;
        case "cashbox":
          await postJson("/api/cashbox/manual", {
            cashboxId: values.cashboxId || null,
            direction: values.direction || "inflow",
            amount: values.amount,
            description: values.description,
          });
          break;
        case "users":
          await postJson("/api/users", {
            name: values.name,
            email: values.email,
            password: values.password,
            role: values.role || "cashier",
          });
          break;
        case "settings":
          await patchJson("/api/settings", {
            name: values.name || undefined,
            phone: values.phone || undefined,
            address: values.address || undefined,
            taxEnabled: values.taxEnabled ? values.taxEnabled === "true" : undefined,
            taxRateBp: values.taxRate ? Math.round(Number(values.taxRate) * 100) : undefined,
          });
          break;
        default:
          throw new Error("لا يوجد نموذج إنشاء لهذا القسم.");
      }
      Alert.alert(
        queued ? "حُفظت العملية دون اتصال" : "تم الحفظ",
        queued ? "ستُزامن العملية تلقائياً عند عودة الاتصال." : "تم حفظ البيانات بنجاح.",
        [{ text: "حسنًا", onPress: onSaved }],
      );
    } catch (err) {
      if (!online && !["expenses", "purchases", "debts", "supplier-debts"].includes(module.id)) {
        setError("هذه العملية تحتاج اتصالاً بالخادم.");
      } else {
        setError(err instanceof Error ? err.message : "تعذر حفظ البيانات");
      }
    } finally {
      setSaving(false);
    }
  }

  const supplierPayment = module.id === "supplier-debts";
  const partyOptions = supplierPayment ? lookups.suppliers ?? [] : lookups.customers ?? [];
  const formFields: React.ReactNode[] = [];

  if (module.id === "customers" || module.id === "suppliers") {
    formFields.push(<Input key="name" label="الاسم" value={values.name ?? ""} onChangeText={(value) => setValue("name", value)} />);
    formFields.push(<Input key="phone" label="الهاتف" value={values.phone ?? ""} onChangeText={(value) => setValue("phone", value)} keyboardType="numeric" />);
    formFields.push(<Input key="address" label="العنوان" value={values.address ?? ""} onChangeText={(value) => setValue("address", value)} />);
  }
  if (module.id === "customers") {
    formFields.push(<Input key="creditLimit" label="حد الائتمان" value={values.creditLimit ?? ""} onChangeText={(value) => setValue("creditLimit", value)} keyboardType="decimal-pad" />);
  }
  if (module.id === "products") {
    formFields.push(<Input key="name" label="اسم المنتج" value={values.name ?? ""} onChangeText={(value) => setValue("name", value)} />);
    formFields.push(<Input key="sku" label="رمز المنتج" value={values.sku ?? ""} onChangeText={(value) => setValue("sku", value)} ltr />);
    formFields.push(<Input key="barcode" label="الباركود (اختياري)" value={values.barcode ?? ""} onChangeText={(value) => setValue("barcode", value)} ltr />);
    formFields.push(<ChoiceList key="unit" title="الوحدة الأساسية" items={units} selected={values.unitId || units[0]?.id || ""} onSelect={(value) => setValue("unitId", value)} />);
    formFields.push(<Input key="purchaseCost" label="تكلفة الشراء" value={values.purchaseCost ?? ""} onChangeText={(value) => setValue("purchaseCost", value)} keyboardType="decimal-pad" />);
    formFields.push(<Input key="retailPrice" label="سعر البيع" value={values.retailPrice ?? ""} onChangeText={(value) => setValue("retailPrice", value)} keyboardType="decimal-pad" />);
    formFields.push(<Input key="wholesalePrice" label="سعر الجملة (اختياري)" value={values.wholesalePrice ?? ""} onChangeText={(value) => setValue("wholesalePrice", value)} keyboardType="decimal-pad" />);
    formFields.push(<Input key="minStock" label="حد التنبيه للمخزون" value={values.minStock ?? "0"} onChangeText={(value) => setValue("minStock", value)} keyboardType="decimal-pad" />);
  }
  if (module.id === "expenses") {
    formFields.push(<Input key="category" label="التصنيف" value={values.category ?? ""} onChangeText={(value) => setValue("category", value)} />);
    formFields.push(<Input key="description" label="الوصف" value={values.description ?? ""} onChangeText={(value) => setValue("description", value)} />);
    formFields.push(<Input key="amount" label="المبلغ" value={values.amount ?? ""} onChangeText={(value) => setValue("amount", value)} keyboardType="decimal-pad" />);
  }
  if (module.id === "purchases") {
    formFields.push(<ChoiceList key="supplier" title="المورد" items={lookups.suppliers ?? []} selected={values.supplierId ?? ""} onSelect={(value) => setValue("supplierId", value)} />);
    formFields.push(<ChoiceList key="product" title="المنتج" items={lookups.products ?? []} selected={values.productId ?? ""} onSelect={(value) => {
      setValues((current) => ({ ...current, productId: value, unitId: "" }));
    }} />);
    formFields.push(<ChoiceList key="unit" title="الوحدة" items={productUnits} selected={values.unitId || productUnits[0]?.id || ""} onSelect={(value) => setValue("unitId", value)} />);
    formFields.push(<Input key="qty" label="الكمية" value={values.qty ?? ""} onChangeText={(value) => setValue("qty", value)} keyboardType="decimal-pad" />);
    formFields.push(<Input key="unitCost" label="تكلفة الوحدة" value={values.unitCost ?? ""} onChangeText={(value) => setValue("unitCost", value || "0")} keyboardType="decimal-pad" />);
    formFields.push(<Input key="paid" label="المدفوع" value={values.paid ?? "0"} onChangeText={(value) => setValue("paid", value)} keyboardType="decimal-pad" />);
  }
  if (module.id === "debts" || module.id === "supplier-debts") {
    formFields.push(<ChoiceList key="party" title={supplierPayment ? "المورد" : "العميل"} items={partyOptions} selected={values.partyId ?? ""} onSelect={(value) => setValue("partyId", value)} />);
    formFields.push(<Input key="amount" label="مبلغ الدفعة" value={values.amount ?? ""} onChangeText={(value) => setValue("amount", value)} keyboardType="decimal-pad" />);
  }
  if (module.id === "inventory") {
    formFields.push(<ChoiceList key="product" title="المنتج" items={lookups.products ?? []} selected={values.productId ?? ""} onSelect={(value) => setValue("productId", value)} />);
    formFields.push(<ChoiceList key="direction" title="نوع الحركة" items={[{ id: "increase", name: "زيادة" }, { id: "decrease", name: "نقص" }, { id: "damage", name: "تالف" }]} selected={values.direction ?? "increase"} onSelect={(value) => setValue("direction", value)} />);
    formFields.push(<Input key="qty" label="الكمية" value={values.qty ?? ""} onChangeText={(value) => setValue("qty", value)} keyboardType="decimal-pad" />);
    formFields.push(<Input key="unitCost" label="تكلفة الوحدة (اختياري)" value={values.unitCost ?? ""} onChangeText={(value) => setValue("unitCost", value)} keyboardType="decimal-pad" />);
    formFields.push(<Input key="reason" label="سبب التسوية" value={values.reason ?? ""} onChangeText={(value) => setValue("reason", value)} />);
  }
  if (module.id === "stocktaking") {
    formFields.push(<Input key="title" label="عنوان جلسة الجرد" value={values.title ?? ""} onChangeText={(value) => setValue("title", value)} />);
  }
  if (module.id === "cashbox") {
    formFields.push(<ChoiceList key="cashbox" title="الصندوق" items={lookups.cashboxes ?? []} selected={values.cashboxId ?? ""} onSelect={(value) => setValue("cashboxId", value)} />);
    formFields.push(<ChoiceList key="direction" title="نوع الحركة" items={[{ id: "inflow", name: "إيداع" }, { id: "outflow", name: "سحب" }]} selected={values.direction ?? "inflow"} onSelect={(value) => setValue("direction", value)} />);
    formFields.push(<Input key="amount" label="المبلغ" value={values.amount ?? ""} onChangeText={(value) => setValue("amount", value)} keyboardType="decimal-pad" />);
    formFields.push(<Input key="description" label="الوصف" value={values.description ?? ""} onChangeText={(value) => setValue("description", value)} />);
  }
  if (module.id === "users") {
    formFields.push(<Input key="name" label="الاسم" value={values.name ?? ""} onChangeText={(value) => setValue("name", value)} />);
    formFields.push(<Input key="email" label="البريد الإلكتروني" value={values.email ?? ""} onChangeText={(value) => setValue("email", value)} keyboardType="email-address" ltr />);
    formFields.push(<Input key="password" label="كلمة المرور" value={values.password ?? ""} onChangeText={(value) => setValue("password", value)} secureTextEntry />);
    formFields.push(<ChoiceList key="role" title="الدور" items={[{ id: "accountant", name: "محاسب" }, { id: "cashier", name: "كاشير" }, { id: "inventory_manager", name: "مدير مخزون" }, { id: "viewer", name: "مشاهد" }]} selected={values.role ?? "cashier"} onSelect={(value) => setValue("role", value)} />);
  }
  if (module.id === "settings") {
    formFields.push(<Input key="name" label="اسم النشاط" value={values.name ?? ""} onChangeText={(value) => setValue("name", value)} />);
    formFields.push(<Input key="phone" label="الهاتف" value={values.phone ?? ""} onChangeText={(value) => setValue("phone", value)} keyboardType="numeric" />);
    formFields.push(<Input key="address" label="العنوان" value={values.address ?? ""} onChangeText={(value) => setValue("address", value)} />);
    formFields.push(<ChoiceList key="taxEnabled" title="الضريبة" items={[{ id: "true", name: "مفعّلة" }, { id: "false", name: "غير مفعّلة" }]} selected={values.taxEnabled ?? "false"} onSelect={(value) => setValue("taxEnabled", value)} />);
    formFields.push(<Input key="taxRate" label="نسبة الضريبة (%)" value={values.taxRate ?? "0"} onChangeText={(value) => setValue("taxRate", value)} keyboardType="decimal-pad" />);
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header title={`إضافة · ${module.title}`} onBack={onBack} />
      <ScrollView contentContainerStyle={styles.pageContent} keyboardShouldPersistTaps="handled">
        {!online && !["expenses", "purchases", "debts", "supplier-debts"].includes(module.id) ? (
          <Text style={styles.cacheNotice}>هذه العملية تتطلب اتصالاً بالخادم.</Text>
        ) : null}
        {loadingLookups ? <ActivityIndicator color={COLORS.brand} /> : null}
        {formFields}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        <ActionButton title={saving ? "جارٍ الحفظ..." : "حفظ"} onPress={() => void submit()} disabled={saving || loadingLookups || ( !online && !["expenses", "purchases", "debts", "supplier-debts"].includes(module.id))} />
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

function AssistantScreen({ onBack }: { onBack: () => void }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    setLoading(true);
    setAnswer("");
    setError("");
    try {
      const response = await postJson<Record<string, unknown>>("/api/ai/ask", { question });
      setAnswer(typeof response.answer === "string" ? response.answer : JSON.stringify(response));
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذر إرسال السؤال");
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Header title="المساعد الذكي" onBack={onBack} />
      <ScrollView contentContainerStyle={styles.pageContent}>
        <Card>
          <Text style={styles.bodyText}>اسأل عن بيانات نشاطك. يتطلب هذا القسم اتصالاً بالخادم.</Text>
          <Input label="سؤالك" value={question} onChangeText={setQuestion} placeholder="مثال: ما إجمالي مبيعات اليوم؟" multiline />
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <ActionButton title={loading ? "جارٍ التحليل..." : "إرسال السؤال"} onPress={() => void ask()} disabled={loading || question.trim().length < 2} />
        </Card>
        {answer ? <Card><Text style={styles.cardTitle}>الإجابة</Text><Text style={styles.bodyText}>{answer}</Text></Card> : null}
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: COLORS.background },
  homeContent: { padding: 16, paddingBottom: 36, gap: 16 },
  pageContent: { padding: 16, paddingBottom: 36, gap: 14 },
  authContent: { flexGrow: 1, justifyContent: "center", padding: 20, gap: 10 },
  card: { backgroundColor: COLORS.white, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, padding: 16, gap: 10 },
  welcomeCard: { backgroundColor: COLORS.dark, borderColor: COLORS.dark },
  welcomeTitle: { color: COLORS.white, textAlign: "right", fontSize: 21, fontWeight: "700" },
  welcomeSub: { color: "#c5e0d7", textAlign: "right", fontSize: 14 },
  connectionRow: { flexDirection: "row-reverse", alignItems: "center", gap: 8, marginTop: 6 },
  dot: { width: 9, height: 9, borderRadius: 8 },
  connectionText: { color: "#e5f1ed", textAlign: "right", fontSize: 12, flexShrink: 1 },
  pendingBox: { borderRadius: 12, backgroundColor: "#ffffff1c", padding: 10, gap: 10, marginTop: 4 },
  pendingText: { color: COLORS.white, textAlign: "right", fontWeight: "600" },
  sectionHeadingRow: { flexDirection: "row-reverse", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: { color: COLORS.ink, fontSize: 16, fontWeight: "700", textAlign: "right" },
  mutedText: { color: COLORS.muted, fontSize: 13, textAlign: "center" },
  moduleGrid: { flexDirection: "row-reverse", flexWrap: "wrap", gap: 10 },
  moduleTile: { width: "31.6%", minHeight: 100, backgroundColor: COLORS.white, borderRadius: 14, borderColor: COLORS.border, borderWidth: 1, padding: 10, alignItems: "center", justifyContent: "center", gap: 8 },
  moduleIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  moduleIconText: { color: COLORS.brand, fontSize: 19, fontWeight: "700" },
  moduleTitle: { color: COLORS.ink, fontSize: 12, fontWeight: "600", textAlign: "center" },
  header: { minHeight: 54, flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, backgroundColor: COLORS.white, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerSide: { width: 64, alignItems: "flex-start" },
  headerRight: { alignItems: "flex-end" },
  headerActions: { alignItems: "flex-end", gap: 5 },
  headerTitle: { flex: 1, textAlign: "center", color: COLORS.ink, fontSize: 17, fontWeight: "700" },
  headerBack: { color: COLORS.brand, fontSize: 14, fontWeight: "600" },
  onlineLabel: { color: COLORS.muted, fontSize: 11 },
  cardTitle: { color: COLORS.ink, textAlign: "right", fontSize: 15, fontWeight: "700" },
  bodyText: { color: COLORS.ink, textAlign: "right", fontSize: 14, lineHeight: 23 },
  smallMuted: { color: COLORS.muted, textAlign: "right", fontSize: 11, lineHeight: 18 },
  rowButtons: { flexDirection: "row-reverse", gap: 8, marginTop: 4 },
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 11, backgroundColor: COLORS.brand, alignItems: "center", justifyContent: "center" },
  secondaryButton: { backgroundColor: "#e9f1ee", borderWidth: 1, borderColor: COLORS.border },
  disabledButton: { opacity: 0.55 },
  pressedButton: { opacity: 0.8 },
  buttonText: { color: COLORS.white, fontWeight: "700", fontSize: 14, textAlign: "center" },
  secondaryButtonText: { color: COLORS.dark },
  inputGroup: { gap: 6 },
  inputLabel: { color: COLORS.ink, textAlign: "right", fontSize: 13, fontWeight: "600" },
  choiceRow: { flexDirection: "row-reverse", gap: 8, paddingVertical: 3 },
  choiceChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.white },
  choiceChipSelected: { backgroundColor: "#e5f2ed", borderColor: COLORS.brand },
  choiceText: { color: COLORS.ink, fontSize: 12 },
  choiceTextSelected: { color: COLORS.dark, fontWeight: "700" },
  reportTabs: { flexDirection: "row-reverse", gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  reportDateRow: { flexDirection: "row-reverse", gap: 8, paddingHorizontal: 12, paddingBottom: 8 },
  reportApplyButton: { paddingHorizontal: 12 },
  reportDateInput: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: COLORS.border, borderRadius: 9, paddingHorizontal: 10, color: COLORS.ink, backgroundColor: COLORS.white, textAlign: "left", fontSize: 12 },
  input: { minHeight: 46, borderWidth: 1, borderColor: COLORS.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: COLORS.ink, backgroundColor: COLORS.white },
  multilineInput: { minHeight: 100, textAlignVertical: "top" },
  authCard: { marginTop: 20, gap: 14 },
  logoBox: { alignSelf: "center", width: 56, height: 56, borderRadius: 17, backgroundColor: COLORS.brand, alignItems: "center", justifyContent: "center" },
  logoText: { color: COLORS.white, fontSize: 28, fontWeight: "800" },
  authTitle: { color: COLORS.ink, textAlign: "center", fontSize: 25, fontWeight: "800" },
  authSub: { color: COLORS.muted, textAlign: "center", fontSize: 14 },
  errorText: { color: COLORS.red, textAlign: "right", fontSize: 13, lineHeight: 20 },
  textButton: { alignItems: "center", paddingVertical: 8 },
  linkText: { color: COLORS.brand, fontSize: 13, fontWeight: "600" },
  searchInput: { margin: 12, minHeight: 44, borderWidth: 1, borderColor: COLORS.border, borderRadius: 11, paddingHorizontal: 12, color: COLORS.ink, backgroundColor: COLORS.white },
  cacheNotice: { color: "#735515", backgroundColor: COLORS.amber, marginHorizontal: 12, marginBottom: 4, padding: 9, borderRadius: 8, textAlign: "right", fontSize: 11 },
  inlineError: { color: COLORS.red, textAlign: "right", paddingHorizontal: 16, paddingVertical: 6, fontSize: 12 },
  successNotice: { color: COLORS.dark, textAlign: "right", backgroundColor: "#dff4e9", marginHorizontal: 12, padding: 10, borderRadius: 8, fontSize: 12 },
  section: { gap: 8, marginBottom: 8 },
  dataRow: { flexDirection: "row-reverse", justifyContent: "space-between", gap: 12, paddingVertical: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  dataLabel: { color: COLORS.muted, textAlign: "right", fontSize: 11, maxWidth: "42%" },
  dataValue: { color: COLORS.ink, textAlign: "left", fontSize: 12, flex: 1 },
  emptyText: { color: COLORS.muted, textAlign: "center", padding: 18, fontSize: 13 },
  posSearchWrap: { backgroundColor: COLORS.background },
  posList: { paddingHorizontal: 12, paddingBottom: 12, gap: 8 },
  productCard: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between" },
  productInfo: { flex: 1, alignItems: "flex-end", gap: 3 },
  priceText: { color: COLORS.brand, textAlign: "right", fontWeight: "700", fontSize: 13 },
  quantityControls: { flexDirection: "row", alignItems: "center", gap: 10, marginLeft: 10 },
  quantityButton: { width: 34, height: 34, borderRadius: 10, backgroundColor: "#e8f3ef", alignItems: "center", justifyContent: "center" },
  quantityButtonText: { color: COLORS.brand, fontWeight: "800", fontSize: 19 },
  quantityText: { color: COLORS.ink, minWidth: 18, textAlign: "center", fontWeight: "700" },
  checkoutBar: { flexDirection: "row-reverse", alignItems: "center", justifyContent: "space-between", padding: 14, backgroundColor: COLORS.white, borderTopWidth: 1, borderColor: COLORS.border },
  checkoutTotal: { color: COLORS.dark, textAlign: "right", fontSize: 18, fontWeight: "800" },
});
