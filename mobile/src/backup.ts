import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import * as SQLite from "expo-sqlite";
import { restoreFlutterJsonBackup, restoreLocalDatabase, serializeLocalDatabase } from "./local-db";

const BACKUP_DIRECTORY = `${FileSystem.documentDirectory ?? ""}backups/`;
const BACKUP_PREFIX = "hisab-mobile-backup-";

export type LocalBackup = {
  name: string;
  uri: string;
  createdAt: string;
  sizeBytes: number;
};

async function ensureDirectory(): Promise<void> {
  if (!FileSystem.documentDirectory) throw new Error("مساحة الملفات غير متاحة على هذا الجهاز.");
  const info = await FileSystem.getInfoAsync(BACKUP_DIRECTORY);
  if (!info.exists) await FileSystem.makeDirectoryAsync(BACKUP_DIRECTORY, { intermediates: true });
}

function fileName(kind: "local" | "safety"): string {
  return `${BACKUP_PREFIX}${kind}-${Date.now()}.sqlite`;
}

export async function listLocalBackups(): Promise<LocalBackup[]> {
  await ensureDirectory();
  const names = await FileSystem.readDirectoryAsync(BACKUP_DIRECTORY);
  const backups: LocalBackup[] = [];
  for (const name of names.filter((entry) => entry.startsWith(BACKUP_PREFIX) && entry.endsWith(".sqlite"))) {
    const uri = `${BACKUP_DIRECTORY}${name}`;
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    if (!info.exists || info.isDirectory) continue;
    const filenameParts = name.slice(BACKUP_PREFIX.length).split("-");
    const timestamp = Number(filenameParts[filenameParts.length - 1]?.replace(".sqlite", ""));
    if (!Number.isFinite(timestamp)) continue;
    const createdAt = new Date(timestamp).toISOString();
    backups.push({ name, uri, createdAt, sizeBytes: info.size ?? 0 });
  }
  return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function saveSnapshot(kind: "local" | "safety"): Promise<LocalBackup> {
  await ensureDirectory();
  const snapshot = await serializeLocalDatabase();
  const name = fileName(kind);
  const uri = `${BACKUP_DIRECTORY}${name}`;
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < snapshot.length; index += chunkSize) {
    binary += String.fromCharCode(...snapshot.subarray(index, index + chunkSize));
  }
  await FileSystem.writeAsStringAsync(uri, btoa(binary), {
    encoding: FileSystem.EncodingType.Base64,
  });
  const info = await FileSystem.getInfoAsync(uri, { size: true });
  return { name, uri, createdAt: new Date().toISOString(), sizeBytes: "size" in info ? info.size ?? snapshot.byteLength : snapshot.byteLength };
}

export function createLocalBackup(): Promise<LocalBackup> {
  return saveSnapshot("local");
}

async function readSnapshot(uri: string): Promise<Uint8Array> {
  const encoded = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function shareLocalBackup(backup: LocalBackup): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("مشاركة الملفات غير مدعومة على هذا الجهاز.");
  await Sharing.shareAsync(backup.uri, {
    mimeType: "application/vnd.sqlite3",
    dialogTitle: "تصدير نسخة حساب الاحتياطية",
  });
}

export async function pickAndRestoreBackup(): Promise<LocalBackup | null> {
  const selection = await DocumentPicker.getDocumentAsync({
    type: ["application/vnd.sqlite3", "application/octet-stream", "*/*"],
    copyToCacheDirectory: true,
  });
  if (selection.canceled) return null;
  const selected = selection.assets[0];
  if (!selected) return null;

  if (/\.json$/i.test(selected.name)) {
    const raw = await FileSystem.readAsStringAsync(selected.uri);
    const payload: unknown = JSON.parse(raw);
    if (!payload || typeof payload !== "object" || (payload as { format?: unknown }).format !== "hisab-mobile-backup") {
      throw new Error("ملف JSON لا يبدو نسخة احتياطية من تطبيق حساب.");
    }
    await saveSnapshot("safety");
    await restoreFlutterJsonBackup(payload);
    return {
      name: selected.name,
      uri: selected.uri,
      createdAt: selected.lastModified ? new Date(selected.lastModified).toISOString() : new Date().toISOString(),
      sizeBytes: selected.size ?? raw.length,
    };
  }

  // Decode and integrity-check before creating the safety copy. The restore
  // itself validates required tables and applies them in one SQLite transaction.
  const importedBytes = await readSnapshot(selected.uri);
  const validation = await SQLite.deserializeDatabaseAsync(importedBytes);
  try {
    const result = await validation.getFirstAsync<{ integrity_check: string }>("PRAGMA integrity_check");
    if (result?.integrity_check !== "ok") throw new Error("ملف النسخة تالف ولا يمكن استعادته.");
  } finally {
    await validation.closeAsync();
  }

  await saveSnapshot("safety");
  await restoreLocalDatabase(importedBytes);
  return {
    name: selected.name,
    uri: selected.uri,
    createdAt: selected.lastModified ? new Date(selected.lastModified).toISOString() : new Date().toISOString(),
    sizeBytes: selected.size ?? importedBytes.byteLength,
  };
}

export async function restoreSavedBackup(backup: LocalBackup): Promise<void> {
  const bytes = await readSnapshot(backup.uri);
  await saveSnapshot("safety");
  await restoreLocalDatabase(bytes);
}

export async function deleteLocalBackup(backup: LocalBackup): Promise<void> {
  await FileSystem.deleteAsync(backup.uri, { idempotent: true });
}
