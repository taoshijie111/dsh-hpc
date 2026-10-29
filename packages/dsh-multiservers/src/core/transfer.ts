import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Client, SFTPWrapper } from "ssh2";
import { execRemote } from "./ssh.js";
import { MultiserversError, shellQuote } from "./types.js";

export type TransferResult = {
  path: string;
  files: number;
  bytes: number;
  resumed: boolean;
  skipped: boolean;
  sha256: string | null;
  verified: boolean;
};

export type TransferOptions = {
  overwrite: boolean;
  signal?: AbortSignal;
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

function isRemoteDirectory(sftp: SFTPWrapper, path: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(path, (error, stats) => {
      if (error) return resolve(false);
      resolve(Boolean((stats as { isDirectory?: () => boolean }).isDirectory?.()));
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

function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.unlink(path, () => resolve());
  });
}

function rename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (error) => (error ? reject(error) : resolve()));
  });
}

function mkdirRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let current = path.startsWith("/") ? "" : ".";
  return parts.reduce(
    (chain, part) =>
      chain.then(
        () =>
          new Promise<void>((resolve) => {
            current = `${current}/${part}`;
            sftp.mkdir(current, () => resolve());
          }),
      ),
    Promise.resolve(),
  );
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

async function remoteSha256(client: Client, path: string): Promise<string | null> {
  const result = await execRemote(client, `sha256sum -- ${shellQuote(path)}`, { timeoutMs: 120_000 });
  if (result.code !== 0) return null;
  const match = /^([0-9a-f]{64})\s/.exec(result.stdout.trim());
  return match ? match[1]! : null;
}

function shouldAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MultiserversError("Transfer cancelled");
}

async function uploadFile(
  client: Client,
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  options: TransferOptions,
): Promise<{ bytes: number; resumed: boolean; skipped: boolean; sha256: string; verified: boolean }> {
  const localSize = statSync(localPath).size;
  const localSha = await digestFile(localPath);
  const finalSize = await statSize(sftp, remotePath);
  if (finalSize === localSize) {
    const existing = await remoteSha256(client, remotePath);
    if (existing === localSha) return { bytes: 0, resumed: false, skipped: true, sha256: localSha, verified: true };
    if (!options.overwrite) {
      throw new MultiserversError(
        `Remote file "${remotePath}" already exists with different content. Pass overwrite=true to replace it.`,
      );
    }
  } else if (finalSize !== null && finalSize > localSize) {
    throw new MultiserversError(`Remote file "${remotePath}" is larger than the local file; refusing to truncate.`);
  }

  const partPath = `${remotePath}.part`;
  const partSize = await statSize(sftp, partPath);
  const offset = partSize !== null && partSize < localSize ? partSize : 0;
  if (partSize !== null && partSize >= localSize) await unlink(sftp, partPath);

  const handle = await openHandle(sftp, partPath, offset > 0 ? "r+" : "w");
  try {
    const chunkSize = 256 * 1024;
    let position = offset;
    while (position < localSize) {
      shouldAbort(options.signal);
      const end = Math.min(position + chunkSize, localSize) - 1;
      const chunk = await readChunk(localPath, position, end);
      await writeAt(sftp, handle, chunk, position);
      position += chunk.length;
    }
  } finally {
    await closeHandle(sftp, handle);
  }

  const partSha = await remoteSha256(client, partPath);
  if (partSha !== null && partSha !== localSha) {
    await unlink(sftp, partPath);
    throw new MultiserversError(`Upload checksum mismatch for ${remotePath}; the staged file was discarded.`);
  }
  await unlink(sftp, remotePath);
  await rename(sftp, partPath, remotePath);
  return { bytes: localSize - offset, resumed: offset > 0, skipped: false, sha256: localSha, verified: partSha !== null };
}

function walkLocal(root: string, base = ""): Array<{ absolute: string; relative: string }> {
  const directory = base ? join(root, base) : root;
  const files: Array<{ absolute: string; relative: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = base ? posix.join(base, entry.name) : entry.name;
    const absolute = join(root, relative);
    if (entry.isDirectory()) files.push(...walkLocal(root, relative));
    else if (entry.isFile()) files.push({ absolute, relative });
  }
  return files;
}

async function walkRemote(
  sftp: SFTPWrapper,
  root: string,
  base = "",
): Promise<Array<{ relative: string; isDirectory: boolean }>> {
  const directory = base ? posix.join(root, base) : root;
  const list = await new Promise<Array<{ filename: string; attrs: { isDirectory?: () => boolean } }>>(
    (resolve, reject) => {
      sftp.readdir(directory, (error, entries) =>
        error ? reject(error) : resolve(entries as unknown as Array<{ filename: string; attrs: { isDirectory?: () => boolean } }>),
      );
    },
  );
  const result: Array<{ relative: string; isDirectory: boolean }> = [];
  for (const entry of list) {
    if (entry.filename === "." || entry.filename === "..") continue;
    const relative = base ? posix.join(base, entry.filename) : entry.filename;
    if (entry.attrs.isDirectory?.()) {
      result.push({ relative, isDirectory: true });
      result.push(...(await walkRemote(sftp, root, relative)));
    } else {
      result.push({ relative, isDirectory: false });
    }
  }
  return result;
}

/** Upload a file or a directory tree; each file is staged as `.part` then renamed. */
export async function uploadWithResume(
  client: Client,
  localPath: string,
  remotePath: string,
  options: TransferOptions,
): Promise<TransferResult> {
  if (!existsSync(localPath)) throw new MultiserversError(`Local path not found: ${localPath}`);
  const sftp = await sftpOf(client);
  if (!statSync(localPath).isDirectory()) {
    return { path: remotePath, files: 1, ...(await uploadFile(client, sftp, localPath, remotePath, options)) };
  }

  const files = walkLocal(localPath);
  await mkdirRemote(sftp, remotePath);
  let bytes = 0;
  let resumed = false;
  let skippedAll = files.length > 0;
  let verifiedAll = true;
  let lastSha: string | null = null;
  for (const file of files) {
    shouldAbort(options.signal);
    const target = posix.join(remotePath, file.relative);
    await mkdirRemote(sftp, posix.dirname(target));
    const result = await uploadFile(client, sftp, file.absolute, target, options);
    bytes += result.bytes;
    resumed ||= result.resumed;
    skippedAll &&= result.skipped;
    verifiedAll &&= result.verified;
    lastSha = result.sha256;
  }
  return {
    path: remotePath,
    files: files.length,
    bytes,
    resumed,
    skipped: skippedAll,
    sha256: lastSha,
    verified: verifiedAll,
  };
}

async function downloadFile(
  client: Client,
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  options: TransferOptions,
): Promise<{ bytes: number; resumed: boolean; skipped: boolean; sha256: string | null; verified: boolean }> {
  const remoteSize = await statSize(sftp, remotePath);
  if (remoteSize === null) throw new MultiserversError(`Remote file not found: ${remotePath}`);
  const remoteSha = await remoteSha256(client, remotePath);
  const localSize = existsSync(localPath) ? statSync(localPath).size : null;
  if (localSize === remoteSize && remoteSha !== null) {
    const localSha = await digestFile(localPath);
    if (localSha === remoteSha) {
      return { bytes: 0, resumed: false, skipped: true, sha256: remoteSha, verified: true };
    }
    if (!options.overwrite) {
      throw new MultiserversError(`Local file "${localPath}" differs from the remote file. Pass overwrite=true.`);
    }
  }

  const partPath = `${localPath}.part`;
  mkdirSync(dirname(localPath), { recursive: true });
  const partSize = existsSync(partPath) ? statSync(partPath).size : null;
  const offset = partSize !== null && partSize < remoteSize ? partSize : 0;
  if (partSize !== null && partSize >= remoteSize) unlinkSync(partPath);

  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(partPath, offset > 0 ? { flags: "a" } : { flags: "w" });
    const input = sftp.createReadStream(remotePath, { start: offset });
    input.on("error", reject);
    out.on("error", reject);
    out.on("close", () => resolve());
    input.pipe(out);
    options.signal?.addEventListener("abort", () => {
      input.destroy();
      out.destroy();
      reject(new MultiserversError("Transfer cancelled"));
    });
  });

  const partSha = await digestFile(partPath);
  if (remoteSha !== null && partSha !== remoteSha) {
    unlinkSync(partPath);
    throw new MultiserversError(`Download checksum mismatch for ${remotePath}; the staged file was discarded.`);
  }
  if (existsSync(localPath)) unlinkSync(localPath);
  renameSync(partPath, localPath);
  return {
    bytes: remoteSize - offset,
    resumed: offset > 0,
    skipped: false,
    sha256: remoteSha,
    verified: remoteSha !== null,
  };
}

/** Download a file or a directory tree; each file is staged locally as `.part`. */
export async function downloadWithResume(
  client: Client,
  remotePath: string,
  localPath: string,
  options: TransferOptions,
): Promise<TransferResult> {
  const sftp = await sftpOf(client);
  if (!(await isRemoteDirectory(sftp, remotePath))) {
    return { path: localPath, files: 1, ...(await downloadFile(client, sftp, remotePath, localPath, options)) };
  }

  const entries = await walkRemote(sftp, remotePath);
  mkdirSync(localPath, { recursive: true });
  let bytes = 0;
  let resumed = false;
  let skippedAll = entries.some((entry) => !entry.isDirectory);
  let verifiedAll = true;
  let lastSha: string | null = null;
  for (const entry of entries) {
    shouldAbort(options.signal);
    const target = join(localPath, entry.relative);
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const result = await downloadFile(client, sftp, posix.join(remotePath, entry.relative), target, options);
    bytes += result.bytes;
    resumed ||= result.resumed;
    skippedAll &&= result.skipped;
    verifiedAll &&= result.verified;
    lastSha = result.sha256;
  }
  return {
    path: localPath,
    files: entries.filter((entry) => !entry.isDirectory).length,
    bytes,
    resumed,
    skipped: skippedAll,
    sha256: lastSha,
    verified: verifiedAll,
  };
}
