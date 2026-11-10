import { transaction } from "@/db/client";
import type { Session } from "@/server/auth";
import { createBusinessBackup } from "./cloud-backup";
import { ensureCloudSettings, hasVerifiedCloudIdentity, isBackupDue } from "./cloud-sync";

export type AutoBackupResult = {
  attempted: boolean;
  created: boolean;
  backupId: string | null;
  duplicate: boolean;
};

/**
 * Creates an automatic cloud backup when the configured interval has elapsed.
 *
 * Only verified Supabase identities may create cloud backups. The check is
 * deliberately silent for legacy sessions so normal offline/online operation
 * keeps working; the sync routes surface the "link your account" message.
 */
export async function runAutoBackupIfDue(
  session: Session,
  options: { force?: boolean } = {},
): Promise<AutoBackupResult> {
  if (!hasVerifiedCloudIdentity(session)) {
    return { attempted: false, created: false, backupId: null, duplicate: false };
  }

  const settings = await transaction((tx) => ensureCloudSettings(tx, session));
  if (!options.force && !isBackupDue(settings)) {
    return { attempted: false, created: false, backupId: null, duplicate: false };
  }

  const result = await transaction((tx) => createBusinessBackup(tx, session, "auto"));
  return {
    attempted: true,
    created: !result.duplicate,
    backupId: result.backup.id,
    duplicate: result.duplicate,
  };
}
