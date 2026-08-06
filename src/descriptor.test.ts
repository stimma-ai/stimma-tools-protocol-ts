import { describe, expect, it } from "vitest";
import { ToolDescriptor } from "./protocol.js";
import { STANDARD_TASK_TYPES, Tool } from "./tool.js";

describe("standard task types", () => {
  it("includes video-to-video beside image-to-image", () => {
    expect(STANDARD_TASK_TYPES).toContain("image-to-image");
    expect(STANDARD_TASK_TYPES).toContain("reference-to-video");
    expect(STANDARD_TASK_TYPES).toContain("video-to-video");
  });
});

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

describe("x-accept-media parameter schema", () => {
  it("emits snake_case wire keys for acceptedMedia", () => {
    const tool = new Tool({
      slug: "transcribe:audio-to-text",
      displayName: "Transcribe",
      taskTypes: ["audio-to-text"],
      execute: async () => ({ assets: [] }),
      parameters: [
        {
          name: "audio",
          type: "string",
          acceptedMedia: {
            mimeTypes: ["audio/wav", "audio/mpeg"],
            transcodeTo: "audio/wav",
          },
        },
      ],
    });
    const d = tool.toDescriptor().toDict();
    const props = (d.parameter_schema as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect(props.audio["x-accept-media"]).toEqual({
      mime_types: ["audio/wav", "audio/mpeg"],
      transcode_to: "audio/wav",
    });
  });

  it("omits x-accept-media when unset", () => {
    const tool = new Tool({
      slug: "transcribe:audio-to-text",
      displayName: "Transcribe",
      taskTypes: ["audio-to-text"],
      execute: async () => ({ assets: [] }),
      parameters: [{ name: "audio", type: "string" }],
    });
    const d = tool.toDescriptor().toDict();
    const props = (d.parameter_schema as Record<string, unknown>)
      .properties as Record<string, Record<string, unknown>>;
    expect("x-accept-media" in props.audio).toBe(false);
  });
});

describe("cross-field required alternatives", () => {
  it("emits JSON Schema anyOf branches", () => {
    const tool = new Tool({
      slug: "reference-to-video",
      displayName: "Reference to Video",
      taskTypes: ["reference-to-video"],
      execute: async () => ({ assets: [] }),
      parameters: [
        { name: "input_images", type: "array" },
        { name: "input_videos", type: "array" },
        { name: "input_audios", type: "array" },
      ],
      requiredAny: [["input_images"], ["input_videos"], ["input_audios"]],
    });

    expect(tool.toDescriptor().parameterSchema.anyOf).toEqual([
      { required: ["input_images"], properties: { input_images: { minItems: 1 } } },
      { required: ["input_videos"], properties: { input_videos: { minItems: 1 } } },
      { required: ["input_audios"], properties: { input_audios: { minItems: 1 } } },
    ]);
  });
});
