import fs from "fs";
import path from "path";
import { sqlite } from "./storage";
import { log } from "./index";

const BACKUP_DIR = path.resolve(process.cwd(), "backups");
const RETENTION_DAYS = 14;

export interface BackupMetadata {
  filename: string;
  filepath: string;
  sizeBytes: number;
  createdAt: string;
}

/** Ensure backup directory exists */
function ensureBackupDir(): string {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
  return BACKUP_DIR;
}

/** Perform an automated or manual WAL-safe SQLite backup */
export async function performDatabaseBackup(): Promise<BackupMetadata> {
  const dir = ensureBackupDir();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `aurea_backup_${timestamp}.db`;
  const filepath = path.join(dir, filename);

  log(`Starting SQLite database backup to ${filename}...`, "backup");

  try {
    // WAL-safe online backup via better-sqlite3
    await sqlite.backup(filepath);
    const stats = fs.statSync(filepath);

    log(`Backup completed successfully: ${filename} (${(stats.size / (1024 * 1024)).toFixed(2)} MB)`, "backup");

    // Clean up old backups according to retention policy
    cleanOldBackups();

    return {
      filename,
      filepath,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    };
  } catch (err: any) {
    log(`Backup failed: ${err.message}`, "backup");
    throw err;
  }
}

/** Clean up backups older than RETENTION_DAYS */
export function cleanOldBackups(): number {
  const dir = ensureBackupDir();
  const files = fs.readdirSync(dir);
  const now = Date.now();
  const maxAgeMs = RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  for (const file of files) {
    if (!file.startsWith("aurea_backup_") || !file.endsWith(".db")) continue;
    const fullPath = path.join(dir, file);
    try {
      const stats = fs.statSync(fullPath);
      if (now - stats.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
        deletedCount++;
        log(`Removed old backup: ${file}`, "backup");
      }
    } catch {
      // Ignore file stat errors
    }
  }

  return deletedCount;
}

/** List all available backups */
export function listBackups(): BackupMetadata[] {
  const dir = ensureBackupDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir);
  const backups: BackupMetadata[] = [];

  for (const file of files) {
    if (!file.startsWith("aurea_backup_") || !file.endsWith(".db")) continue;
    const fullPath = path.join(dir, file);
    try {
      const stats = fs.statSync(fullPath);
      backups.push({
        filename: file,
        filepath: fullPath,
        sizeBytes: stats.size,
        createdAt: stats.mtime.toISOString(),
      });
    } catch {
      // Ignore invalid files
    }
  }

  return backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Start 24-hour automated backup scheduler */
let backupTimer: NodeJS.Timeout | null = null;

export function startBackupScheduler(intervalHours = 24) {
  if (backupTimer) return;
  const intervalMs = intervalHours * 60 * 60 * 1000;

  // Run initial backup immediately asynchronously on startup
  setTimeout(() => {
    performDatabaseBackup().catch((e) => log(`Scheduled backup error: ${e.message}`, "backup"));
  }, 10000); // 10s after startup

  backupTimer = setInterval(() => {
    performDatabaseBackup().catch((e) => log(`Scheduled backup error: ${e.message}`, "backup"));
  }, intervalMs);

  log(`Automated DB Backup scheduler initialized (${intervalHours}h interval)`, "backup");
}
