import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  CloudBackupInfo,
  createCloudBackup,
  listCloudBackups,
  restoreCloudBackup,
} from "./api";
import {
  createLocalBackup,
  deleteLocalBackup,
  listLocalBackups,
  LocalBackup,
  pickAndRestoreBackup,
  restoreSavedBackup,
  shareLocalBackup,
} from "./backup";

const COLORS = { brand: "#176b57", ink: "#172522", muted: "#697773", border: "#dce5e1", white: "#fff", bg: "#f3f6f5", red: "#a52b2b" };

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return "الحجم غير معروف";
  if (bytes < 1024) return `${bytes} بايت`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} كيلوبايت`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} ميغابايت`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "تاريخ غير معروف" : date.toLocaleString("ar");
}

function Button({ title, onPress, secondary, danger, disabled }: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.button, secondary && styles.secondary, danger && styles.danger, disabled && styles.disabled, pressed && !disabled && styles.pressed]}
    >
      <Text style={[styles.buttonText, secondary && styles.secondaryText, danger && styles.dangerText]}>{title}</Text>
    </Pressable>
  );
}

function confirm(title: string, message: string, action: () => Promise<void>): void {
  Alert.alert(title, message, [
    { text: "إلغاء", style: "cancel" },
    { text: "تأكيد", style: "destructive", onPress: () => void action() },
  ]);
}

export function BackupRestoreScreen({
  online,
  cloudEnabled,
  isOwner,
  onBack,
  onRestored,
}: {
  online: boolean;
  cloudEnabled: boolean;
  isOwner: boolean;
  onBack: () => void;
  onRestored: () => Promise<void>;
}) {
  const [localBackups, setLocalBackups] = useState<LocalBackup[]>([]);
  const [cloudBackups, setCloudBackups] = useState<CloudBackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const local = await listLocalBackups();
      setLocalBackups(local);
      if (online && cloudEnabled && isOwner) {
        try {
          setCloudBackups(await listCloudBackups());
        } catch {
          setCloudBackups([]);
        }
      }
    } catch (error) {
      Alert.alert("تعذر قراءة النسخ", error instanceof Error ? error.message : "خطأ غير متوقع");
    } finally {
      setLoading(false);
    }
  }, [cloudEnabled, isOwner, online]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(action: () => Promise<void>, success?: string) {
    setBusy(true);
    try {
      await action();
      if (success) Alert.alert("تم", success);
      await refresh();
    } catch (error) {
      Alert.alert("تعذر تنفيذ العملية", error instanceof Error ? error.message : "خطأ غير متوقع");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button"><Text style={styles.back}>رجوع</Text></Pressable>
        <Text style={styles.heading}>النسخ الاحتياطي والاستعادة</Text>
        <View style={styles.headerSpacer} />
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>نسخة الجهاز</Text>
          <Text style={styles.muted}>تُحفظ نسخة كاملة من قاعدة SQLite داخل الجهاز. قبل الاستعادة تُنشأ نسخة أمان تلقائياً.</Text>
          <View style={styles.actions}>
            <Button title={busy ? "جارٍ التنفيذ…" : "إنشاء نسخة محلية"} disabled={busy} onPress={() => void run(async () => { await createLocalBackup(); }, "تم إنشاء النسخة المحلية.")} />
            <Button title="استيراد واستعادة ملف" secondary disabled={busy} onPress={() => void run(async () => {
              const restored = await pickAndRestoreBackup();
              if (restored) await onRestored();
            }, "تمت الاستعادة وإنشاء نسخة أمان.")} />
          </View>
        </View>

        <Text style={styles.sectionTitle}>النسخ المحفوظة على الجهاز</Text>
        {loading ? <ActivityIndicator color={COLORS.brand} /> : localBackups.length === 0 ? <Text style={styles.empty}>لا توجد نسخ محلية حتى الآن.</Text> : localBackups.map((backup) => (
          <View key={backup.uri} style={styles.card}>
            <Text style={styles.cardTitle}>{backup.name.includes("safety") ? "نسخة أمان" : "نسخة محلية"}</Text>
            <Text style={styles.meta}>{formatDate(backup.createdAt)} · {formatBytes(backup.sizeBytes)}</Text>
            <View style={styles.actions}>
              <Button title="تصدير" secondary disabled={busy} onPress={() => void run(() => shareLocalBackup(backup))} />
              <Button title="استعادة" secondary disabled={busy} onPress={() => confirm("استعادة النسخة؟", "سيتم إنشاء نسخة أمان من قاعدة البيانات الحالية قبل الاستعادة.", () => run(async () => { await restoreSavedBackup(backup); await onRestored(); }, "اكتملت الاستعادة."))} />
              <Button title="حذف" danger disabled={busy} onPress={() => confirm("حذف النسخة؟", "لن يؤثر هذا على قاعدة البيانات الحالية.", () => run(() => deleteLocalBackup(backup), "تم حذف ملف النسخة."))} />
            </View>
          </View>
        ))}

        <Text style={styles.sectionTitle}>النسخ السحابية</Text>
        {!online ? <Text style={styles.empty}>تحتاج اتصالاً بالإنترنت لعرض النسخ السحابية.</Text> : !cloudEnabled ? <Text style={styles.empty}>يجب ربط الحساب بمزامنة Supabase لعرض النسخ السحابية.</Text> : !isOwner ? <Text style={styles.empty}>إدارة النسخ السحابية متاحة لمالك النشاط فقط.</Text> : (
          <>
            <Button title="إنشاء نسخة سحابية الآن" disabled={busy} onPress={() => void run(async () => {
              const created = await createCloudBackup();
              setCloudBackups((current) => [created, ...current]);
            }, "تم إنشاء النسخة السحابية.")} />
            {cloudBackups.map((backup) => (
              <View key={backup.id} style={styles.card}>
                <Text style={styles.cardTitle}>{backup.kind === "safety" ? "نسخة أمان سحابية" : "نسخة سحابية"}</Text>
                <Text style={styles.meta}>{formatDate(backup.createdAt)} · {formatBytes(backup.sizeBytes)}</Text>
                <Button title="استعادة من السحابة" secondary disabled={busy || backup.status !== "completed"} onPress={() => confirm("استعادة النسخة السحابية؟", "سيتم إنشاء نسخة أمان سحابية قبل الاستعادة. بعد ذلك حدّث بيانات الهاتف بالمزامنة.", () => run(async () => {
                  await restoreCloudBackup(backup.id);
                  await onRestored();
                  setCloudBackups(await listCloudBackups());
                }, "تمت الاستعادة السحابية."))} />
              </View>
            ))}
            {cloudBackups.length === 0 && !loading ? <Text style={styles.empty}>لا توجد نسخ سحابية متاحة.</Text> : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: COLORS.bg },
  header: { minHeight: 56, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, backgroundColor: COLORS.white, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  back: { color: COLORS.brand, fontWeight: "700", paddingVertical: 10 },
  heading: { color: COLORS.ink, fontSize: 17, fontWeight: "700", textAlign: "center" },
  headerSpacer: { width: 38 },
  content: { padding: 16, paddingBottom: 36, gap: 12 },
  notice: { backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, padding: 16, gap: 10 },
  noticeTitle: { color: COLORS.ink, fontWeight: "700", fontSize: 16 },
  muted: { color: COLORS.muted, lineHeight: 21 },
  sectionTitle: { color: COLORS.ink, fontSize: 16, fontWeight: "700", marginTop: 10 },
  card: { backgroundColor: COLORS.white, borderWidth: 1, borderColor: COLORS.border, borderRadius: 14, padding: 14, gap: 8 },
  cardTitle: { color: COLORS.ink, fontWeight: "700" },
  meta: { color: COLORS.muted, fontSize: 12 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  button: { borderRadius: 9, backgroundColor: COLORS.brand, paddingVertical: 10, paddingHorizontal: 12, alignItems: "center", justifyContent: "center" },
  buttonText: { color: COLORS.white, fontWeight: "700", fontSize: 13 },
  secondary: { backgroundColor: COLORS.white, borderColor: COLORS.border, borderWidth: 1 },
  secondaryText: { color: COLORS.brand },
  danger: { backgroundColor: "#fff", borderColor: "#e8caca", borderWidth: 1 },
  dangerText: { color: COLORS.red },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.8 },
  empty: { color: COLORS.muted, textAlign: "center", padding: 16, backgroundColor: COLORS.white, borderRadius: 12 },
});
