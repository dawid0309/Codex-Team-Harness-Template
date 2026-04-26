import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

const root = process.env.S3_LITE_DATA_DIR ?? "/data";
const port = Number(process.env.S3_LITE_PORT ?? 9000);
const defaultBucket = process.env.S3_LITE_BUCKET ?? "langfuse";

function send(res, status, body = "", headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,PUT,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...headers,
  });
  res.end(body);
}

function escapeXml(value) {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function safePath(...parts) {
  const resolved = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error("Invalid object path.");
  }
  return resolved;
}

async function collectBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function listFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(full, rel)));
    } else if (entry.isFile()) {
      const info = await stat(full);
      files.push({ key: rel, size: info.size, modified: info.mtime.toISOString() });
    }
  }
  return files;
}

async function handle(req, res) {
  if (!req.url) {
    send(res, 400);
    return;
  }
  if (req.method === "OPTIONS") {
    send(res, 204);
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/minio/health/ready" || url.pathname === "/health") {
    send(res, 200, "ok");
    return;
  }

  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const bucket = parts.shift();
  const key = parts.join("/");
  if (!bucket) {
    send(res, 200, "s3-lite");
    return;
  }

  const bucketDir = safePath(bucket);
  if (!key) {
    if (req.method === "PUT" || req.method === "POST") {
      await mkdir(bucketDir, { recursive: true });
      send(res, 200);
      return;
    }
    if (req.method === "HEAD") {
      try {
        const info = await stat(bucketDir);
        send(res, info.isDirectory() ? 200 : 404);
      } catch {
        send(res, 404);
      }
      return;
    }
    if (req.method === "GET" && url.searchParams.has("list-type")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const files = (await listFiles(bucketDir)).filter((file) => file.key.startsWith(prefix));
      const contents = files
        .map(
          (file) =>
            `<Contents><Key>${escapeXml(file.key)}</Key><LastModified>${file.modified}</LastModified><Size>${file.size}</Size></Contents>`,
        )
        .join("");
      send(
        res,
        200,
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${escapeXml(bucket)}</Name>${contents}</ListBucketResult>`,
        { "Content-Type": "application/xml" },
      );
      return;
    }
    send(res, 200);
    return;
  }

  const objectPath = safePath(bucket, key);
  if (req.method === "PUT" || req.method === "POST") {
    const body = await collectBody(req);
    await mkdir(path.dirname(objectPath), { recursive: true });
    await writeFile(objectPath, body);
    const etag = createHash("md5").update(body).digest("hex");
    send(res, 200, "", { ETag: `"${etag}"` });
    return;
  }
  if (req.method === "GET") {
    try {
      const info = await stat(objectPath);
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Length": String(info.size),
        "Content-Type": "application/octet-stream",
      });
      createReadStream(objectPath).pipe(res);
    } catch {
      send(res, 404);
    }
    return;
  }
  if (req.method === "HEAD") {
    try {
      const info = await stat(objectPath);
      send(res, 200, "", { "Content-Length": String(info.size) });
    } catch {
      send(res, 404);
    }
    return;
  }
  if (req.method === "DELETE") {
    await rm(objectPath, { force: true });
    send(res, 204);
    return;
  }

  send(res, 405);
}

await mkdir(safePath(defaultBucket), { recursive: true });
createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(error);
    send(res, 500);
  });
}).listen(port, "0.0.0.0", () => {
  console.log(`s3-lite listening on ${port}`);
});
