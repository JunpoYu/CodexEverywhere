import { open } from "node:fs/promises";

/**
 * Flushes a directory entry after an atomic publish when the filesystem
 * supports it. Linux local filesystems normally do; some valid HPC/NFS/FUSE
 * mounts report that directory fsync itself is unsupported. Those explicit
 * capability errors do not undo the already-completed rename/link, while all
 * other I/O and permission failures remain fatal.
 */
export async function syncDirectoryForDurability(
  directoryPath: string,
): Promise<void> {
  const directory = await open(directoryPath, "r");
  try {
    try {
      await directory.sync();
    } catch (error) {
      if (!isUnsupportedDirectorySync(error)) throw error;
    }
  } finally {
    await directory.close();
  }
}

export function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}
