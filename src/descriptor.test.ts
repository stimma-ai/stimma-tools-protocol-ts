import { describe, expect, it } from "vitest";
import { ToolDescriptor } from "./protocol.js";
import { Tool } from "./tool.js";

describe("ToolDescriptor model_vendor / model", () => {
  it("serializes model fields when present", () => {
    const desc = new ToolDescriptor({
      id: "flux-dev:text-to-image",
      name: "Flux Dev",
      taskTypes: ["text-to-image"],
      modelVendor: "black-forest-labs",
      model: "flux2-klein-9b",
    });
    const d = desc.toDict();
    expect(d.model_vendor).toBe("black-forest-labs");
    expect(d.model).toBe("flux2-klein-9b");
  });

  it("omits model fields when unset", () => {
    const desc = new ToolDescriptor({
      id: "t",
      name: "T",
      taskTypes: ["text-to-image"],
    });
    const d = desc.toDict();
    expect(d.model_vendor).toBeUndefined();
    expect(d.model).toBeUndefined();
    expect("model_vendor" in d).toBe(false);
    expect("model" in d).toBe(false);
  });

  it("propagates model fields through Tool.toDescriptor()", () => {
    const tool = new Tool({
      slug: "qwen:text-to-image",
      displayName: "Qwen Image",
      taskTypes: ["text-to-image"],
      execute: async () => ({ assets: [] }),
      modelVendor: "alibaba",
      model: "qwen-image-2512",
    });
    const desc = tool.toDescriptor();
    expect(desc.modelVendor).toBe("alibaba");
    expect(desc.model).toBe("qwen-image-2512");

    const d = desc.toDict();
    expect(d.model_vendor).toBe("alibaba");
    expect(d.model).toBe("qwen-image-2512");
  });
});
