import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, statSync } from "node:fs";
import type { Client, SFTPWrapper } from "ssh2";
import { execRemote } from "./ssh.js";
import { MultiserversError, shellQuote } from "./types.js";

export type TransferResult = {
  remotePath: string;
  bytes: number;
  /** True when only the missing tail was transferred. */
  resumed: boolean;
  /** True when the file was already identical and nothing was written. */
  skipped: boolean;
  sha256: string | null;
  verified: boolean;
};

function digestFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sftpOf(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}

function statSize(sftp: SFTPWrapper, path: string): Promise<number | null> {
  return new Promise((resolve) => {
    sftp.stat(path, (error, stats) => {
      if (error) return resolve(null);
      resolve(Number((stats as { size?: number }).size ?? 0));
    });
  });
}

function openHandle(sftp: SFTPWrapper, path: string, flags: "r+" | "w"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (error, handle) => (error ? reject(error) : resolve(handle)));
  });
}

function writeAt(sftp: SFTPWrapper, handle: Buffer, chunk: Buffer, position: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, chunk, 0, chunk.length, position, (error) => (error ? reject(error) : resolve()));
  });
}

function closeHandle(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    sftp.close(handle, () => resolve());
  });
}

function readChunk(path: string, start: number, end: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end });
    stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** Remote sha256, or null when the host has no sha256sum. */
async function remoteSha256(client: Client, path: string): Promise<string | null> {
  const result = await execRemote(client, `sha256sum -- ${shellQuote(path)}`, { timeoutMs: 120_000 });
  if (result.code !== 0) return null;
  const match = /^([0-9a-f]{64})\s/.exec(result.stdout.trim());
  return match ? match[1]! : null;
}

/**
 * Upload a local file, resuming from the remote size when the destination is a
 * prefix of the local file, then verify both sides by sha256.
 *
 * Resume is deliberately conservative: an existing remote file that is the same
 * size but has different content is an error unless `overwrite` is set.
 */
export async function uploadWithResume(
  client: Client,
  localPath: string,
  remotePath: string,
  options: { overwrite: boolean },
): Promise<TransferResult> {
  if (!existsSync(localPath)) throw new MultiserversError(`Local file not found: ${localPath}`);
  const localSize = statSync(localPath).size;
  const localSha = await digestFile(localPath);
  const sftp = await sftpOf(client);
  const remoteSize = await statSize(sftp, remotePath);

  let offset = 0;
  let skipped = false;
  if (remoteSize === localSize) {
    const existing = await remoteSha256(client, remotePath);
    if (existing === localSha) {
      return { remotePath, bytes: 0, resumed: false, skipped: true, sha256: localSha, verified: true };
    }
    if (!options.overwrite) {
      throw new MultiserversError(
        `Remote file "${remotePath}" already exists with different content (same size). Pass overwrite=true to replace it.`,
      );
    }
    offset = 0;
  } else if (remoteSize !== null && remoteSize < localSize) {
    offset = remoteSize;
  } else if (remoteSize !== null) {
    throw new MultiserversError(
      `Remote file "${remotePath}" is larger than the local file (${remoteSize} > ${localSize}); refusing to truncate.`,
    );
  }

  const handle = await openHandle(sftp, remotePath, offset > 0 ? "r+" : "w");
  try {
    const chunkSize = 256 * 1024;
    let position = offset;
    while (position < localSize) {
      const end = Math.min(position + chunkSize, localSize) - 1;
      const chunk = await readChunk(localPath, position, end);
      await writeAt(sftp, handle, chunk, position);
      position += chunk.length;
    }
  } finally {
    await closeHandle(sftp, handle);
  }

  const remoteSha = await remoteSha256(client, remotePath);
  const verified = remoteSha !== null && remoteSha === localSha;
  if (remoteSha !== null && !verified) {
    throw new MultiserversError(
      `Upload checksum mismatch for ${remotePath}: local ${localSha}, remote ${remoteSha}. Re-upload with overwrite=true.`,
    );
  }
  return { remotePath, bytes: localSize - offset, resumed: offset > 0, skipped, sha256: localSha, verified };
}

/** Download a remote file, resuming from the local size, then verify by sha256. */
export async function downloadWithResume(
  client: Client,
  remotePath: string,
  localPath: string,
  options: { overwrite: boolean },
): Promise<TransferResult> {
  const sftp = await sftpOf(client);
  const remoteSize = await statSize(sftp, remotePath);
  if (remoteSize === null) throw new MultiserversError(`Remote file not found: ${remotePath}`);
  const remoteSha = await remoteSha256(client, remotePath);
  const localSize = existsSync(localPath) ? statSync(localPath).size : null;

  let offset = 0;
  if (localSize !== null && localSize === remoteSize) {
    const localSha = await digestFile(localPath);
    if (remoteSha !== null && localSha === remoteSha) {
      return { remotePath, bytes: 0, resumed: false, skipped: true, sha256: remoteSha, verified: true };
    }
    if (!options.overwrite) {
      throw new MultiserversError(
        `Local file "${localPath}" already exists with different content. Pass overwrite=true to replace it.`,
      );
    }
    offset = 0;
  } else if (localSize !== null && localSize < remoteSize) {
    offset = localSize;
  } else if (localSize !== null) {
    throw new MultiserversError(
      `Local file "${localPath}" is larger than the remote file (${localSize} > ${remoteSize}); refusing to truncate.`,
    );
  }

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(localPath, offset > 0 ? { flags: "a" } : { flags: "w" });
    const input = sftp.createReadStream(remotePath, { start: offset });
    input.on("error", reject);
    out.on("error", reject);
    out.on("close", () => resolve());
    input.pipe(out);
  });

  const localSha = await digestFile(localPath);
  const verified = remoteSha !== null && localSha === remoteSha;
  if (remoteSha !== null && !verified) {
    throw new MultiserversError(`Download checksum mismatch for ${remotePath}. Try again with overwrite=true.`);
  }
  return {
    remotePath,
    bytes: remoteSize - offset,
    resumed: offset > 0,
    skipped: false,
    sha256: remoteSha,
    verified,
  };
}
