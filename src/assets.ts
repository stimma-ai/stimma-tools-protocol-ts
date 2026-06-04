/**
 * Asset management for STP providers.
 *
 * Supports:
 * - Filesystem assets for stdio transport (via ASSET_PATH env var)
 * - HTTP assets for websocket transport (via asset_endpoint)
 * - Local asset server for websocket transport (provider hosts assets)
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getLogger } from "./logger.js";

const logger = getLogger("stimma_tools.assets");

// Asset IDs are opaque tokens from a fixed charset; reject anything else before touching the disk.
const ASSET_ID_RE = /^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9]{1,12}$/;

export function validAssetId(assetId: string): boolean {
  return typeof assetId === "string" && ASSET_ID_RE.test(assetId);
}

// --- Asset Manager Interface ---

export interface AssetManager {
  upload(data: Buffer | Uint8Array, extension?: string): Promise<string>;
  download(assetId: string): Promise<Buffer>;
  delete(assetId: string): Promise<boolean>;
  exists(assetId: string): Promise<boolean>;
}

// --- Filesystem Asset Manager ---

export class FilesystemAssetManager implements AssetManager {
  private _assetPath: string;

  constructor(assetPath?: string) {
    this._assetPath =
      assetPath ?? process.env.ASSET_PATH ?? "/tmp/stimma-assets";
  }

  async init(): Promise<void> {
    await fs.mkdir(this._assetPath, { recursive: true });
    logger.debug(`Filesystem asset manager using: ${this._assetPath}`);
  }

  private _getPath(assetId: string): string {
    // Sanitize to prevent path traversal
    const safeName = path.basename(assetId);
    return path.join(this._assetPath, safeName);
  }

  async upload(
    data: Buffer | Uint8Array,
    extension: string = ".bin",
  ): Promise<string> {
    await this.init();
    const assetId = `${randomUUID()}${extension}`;
    const filePath = this._getPath(assetId);
    await fs.writeFile(filePath, data);
    logger.debug(`Uploaded asset: ${assetId} (${data.length} bytes)`);
    return assetId;
  }

  async download(assetId: string): Promise<Buffer> {
    // Check if it's an absolute path that exists (stdio mode passes full paths)
    if (path.isAbsolute(assetId)) {
      try {
        const data = await fs.readFile(assetId);
        logger.debug(
          `Downloaded from absolute path: ${assetId} (${data.length} bytes)`,
        );
        return data;
      } catch {
        // Fall through to asset directory lookup
      }
    }

    const filePath = this._getPath(assetId);
    try {
      const data = await fs.readFile(filePath);
      logger.debug(`Downloaded asset: ${assetId} (${data.length} bytes)`);
      return data;
    } catch {
      throw new Error(`Asset not found: ${assetId}`);
    }
  }

  async delete(assetId: string): Promise<boolean> {
    const filePath = this._getPath(assetId);
    try {
      await fs.unlink(filePath);
      logger.debug(`Deleted asset: ${assetId}`);
      return true;
    } catch {
      return false;
    }
  }

  async exists(assetId: string): Promise<boolean> {
    if (path.isAbsolute(assetId)) {
      try {
        await fs.access(assetId);
        return true;
      } catch {
        // Fall through
      }
    }
    try {
      await fs.access(this._getPath(assetId));
      return true;
    } catch {
      return false;
    }
  }

  get assetPath(): string {
    return this._assetPath;
  }
}

// --- HTTP Asset Manager ---

export class HttpAssetManager implements AssetManager {
  private _baseUrl: string;
  private _assetEndpoint: string;
  private _authToken?: string;

  constructor(opts: {
    baseUrl: string;
    assetEndpoint: string;
    authToken?: string;
  }) {
    this._baseUrl = opts.baseUrl.replace(/\/$/, "");
    this._assetEndpoint = opts.assetEndpoint.replace(/\/$/, "");
    this._authToken = opts.authToken;
  }

  private _getUrl(assetId: string): string {
    return `${this._baseUrl}${this._assetEndpoint}/${assetId}`;
  }

  private _getHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this._authToken) {
      headers["Authorization"] = `Bearer ${this._authToken}`;
    }
    if (contentType) {
      headers["Content-Type"] = contentType;
    }
    return headers;
  }

  async upload(
    data: Buffer | Uint8Array,
    extension: string = ".bin",
  ): Promise<string> {
    const assetId = `${randomUUID()}${extension}`;
    const url = this._getUrl(assetId);

    const contentTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
      ".bin": "application/octet-stream",
    };
    const contentType =
      contentTypes[extension.toLowerCase()] ?? "application/octet-stream";

    const resp = await fetch(url, {
      method: "PUT",
      headers: this._getHeaders(contentType),
      body: data,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to upload asset: ${resp.status} ${text}`);
    }

    logger.debug(`Uploaded asset: ${assetId} (${data.length} bytes)`);
    return assetId;
  }

  async download(assetId: string): Promise<Buffer> {
    const url = this._getUrl(assetId);
    const resp = await fetch(url, {
      headers: this._getHeaders(),
    });

    if (resp.status === 404) {
      throw new Error(`Asset not found: ${assetId}`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to download asset: ${resp.status} ${text}`);
    }

    const arrayBuffer = await resp.arrayBuffer();
    const data = Buffer.from(arrayBuffer);
    logger.debug(`Downloaded asset: ${assetId} (${data.length} bytes)`);
    return data;
  }

  async delete(assetId: string): Promise<boolean> {
    const url = this._getUrl(assetId);
    const resp = await fetch(url, {
      method: "DELETE",
      headers: this._getHeaders(),
    });

    if (resp.status === 404) return false;
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to delete asset: ${resp.status} ${text}`);
    }

    logger.debug(`Deleted asset: ${assetId}`);
    return true;
  }

  async exists(assetId: string): Promise<boolean> {
    const url = this._getUrl(assetId);
    const resp = await fetch(url, {
      method: "HEAD",
      headers: this._getHeaders(),
    });
    return resp.status === 200;
  }
}

// --- Local Asset Server ---

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export class LocalAssetServer implements AssetManager {
  private _assetPath: string;

  constructor(assetPath?: string) {
    if (assetPath) {
      this._assetPath = assetPath;
    } else {
      this._assetPath = path.join(
        tmpdir(),
        `stimma-provider-assets-${randomUUID()}`,
      );
    }
  }

  async init(): Promise<void> {
    await fs.mkdir(this._assetPath, { recursive: true });
    logger.info(`Local asset server using: ${this._assetPath}`);
  }

  private _getPath(assetId: string): string {
    const safeName = path.basename(assetId);
    return path.join(this._assetPath, safeName);
  }

  async upload(
    data: Buffer | Uint8Array,
    extension: string = ".bin",
  ): Promise<string> {
    await this.init();
    const assetId = `${randomUUID()}${extension}`;
    const filePath = this._getPath(assetId);
    await fs.writeFile(filePath, data);
    logger.debug(`Uploaded asset: ${assetId} (${data.length} bytes)`);
    return assetId;
  }

  async download(assetId: string): Promise<Buffer> {
    const filePath = this._getPath(assetId);
    try {
      const data = await fs.readFile(filePath);
      logger.debug(`Downloaded asset: ${assetId} (${data.length} bytes)`);
      return data;
    } catch {
      throw new Error(`Asset not found: ${assetId}`);
    }
  }

  async delete(assetId: string): Promise<boolean> {
    const filePath = this._getPath(assetId);
    try {
      await fs.unlink(filePath);
      logger.debug(`Deleted asset: ${assetId}`);
      return true;
    } catch {
      return false;
    }
  }

  async exists(assetId: string): Promise<boolean> {
    try {
      await fs.access(this._getPath(assetId));
      return true;
    } catch {
      return false;
    }
  }

  get assetPath(): string {
    return this._assetPath;
  }

  /**
   * Get HTTP route handlers for serving assets.
   * Returns route definitions compatible with WebSocketTransport.addRoutes().
   */
  getHttpRoutes(endpointPath: string = "/assets") {
    const self = this;
    const pattern = new RegExp(`^${endpointPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(.+)$`);

    async function handleGet(
      _req: IncomingMessage,
      res: ServerResponse,
      match: RegExpMatchArray,
    ): Promise<void> {
      const assetId = decodeURIComponent(match[1]);
      if (!validAssetId(assetId)) {
        res.writeHead(400);
        res.end("Malformed asset_id");
        return;
      }
      try {
        const data = await self.download(assetId);
        const ext = path.extname(assetId).toLowerCase();
        const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end(`Asset not found: ${assetId}`);
      }
    }

    async function handlePut(
      req: IncomingMessage,
      res: ServerResponse,
      match: RegExpMatchArray,
    ): Promise<void> {
      const assetId = decodeURIComponent(match[1]);
      if (!validAssetId(assetId)) {
        res.writeHead(400);
        res.end("Malformed asset_id");
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const data = Buffer.concat(chunks);
      const filePath = self._getPath(assetId);
      await self.init();
      await fs.writeFile(filePath, data);
      logger.debug(
        `Received asset via HTTP PUT: ${assetId} (${data.length} bytes)`,
      );
      res.writeHead(201);
      res.end("Created");
    }

    async function handleDelete(
      _req: IncomingMessage,
      res: ServerResponse,
      match: RegExpMatchArray,
    ): Promise<void> {
      const assetId = decodeURIComponent(match[1]);
      if (!validAssetId(assetId)) {
        res.writeHead(400);
        res.end("Malformed asset_id");
        return;
      }
      if (await self.delete(assetId)) {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404);
        res.end(`Asset not found: ${assetId}`);
      }
    }

    async function handleHead(
      _req: IncomingMessage,
      res: ServerResponse,
      match: RegExpMatchArray,
    ): Promise<void> {
      const assetId = decodeURIComponent(match[1]);
      if (!validAssetId(assetId)) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (await self.exists(assetId)) {
        res.writeHead(200);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    }

    return [
      { method: "GET", path: pattern, handler: handleGet },
      { method: "PUT", path: pattern, handler: handlePut },
      { method: "DELETE", path: pattern, handler: handleDelete },
      { method: "HEAD", path: pattern, handler: handleHead },
    ];
  }

  async cleanup(): Promise<void> {
    try {
      await fs.rm(this._assetPath, { recursive: true, force: true });
      logger.info(`Cleaned up asset directory: ${this._assetPath}`);
    } catch {
      // ignore
    }
  }
}

// --- Factory ---

export function createAssetManager(opts: {
  transportType: "stdio" | "websocket";
  assetPath?: string;
  baseUrl?: string;
  assetEndpoint?: string;
  authToken?: string;
}): AssetManager {
  if (opts.transportType === "stdio") {
    return new FilesystemAssetManager(opts.assetPath);
  } else if (opts.transportType === "websocket") {
    return new LocalAssetServer(opts.assetPath);
  } else {
    throw new Error(`Unknown transport type: ${opts.transportType}`);
  }
}
