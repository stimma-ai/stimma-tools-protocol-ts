import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemAssetManager, LocalAssetServer, validAssetId } from "./assets.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("asset conformance", () => {
  it("round trips filesystem assets and confines relative IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stp-assets-"));
    const manager = new LocalAssetServer(dir);
    cleanups.push(() => manager.cleanup());
    const assetId = await manager.upload(Buffer.from("pixels"), ".png");

    expect(validAssetId(assetId)).toBe(true);
    await expect(manager.exists(assetId)).resolves.toBe(true);
    await expect(manager.download(assetId)).resolves.toEqual(Buffer.from("pixels"));
    await expect(manager.delete(assetId)).resolves.toBe(true);
    await expect(manager.exists(assetId)).resolves.toBe(false);
  });

  it("supports absolute host paths without escaping for relative IDs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stp-fs-assets-"));
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "host-data");
    const manager = new FilesystemAssetManager(join(dir, "shared"));

    await expect(manager.download(outside)).resolves.toEqual(Buffer.from("host-data"));
    await expect(manager.download("../outside.txt")).rejects.toThrow("Asset not found");
  });
});
