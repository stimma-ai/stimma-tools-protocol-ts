/**
 * Tool definition and registry for STP tools.
 */

import { ToolDescriptor } from "./protocol.js";

// --- Layout DSL ---

export interface ParamRef {
  name: string;
  label?: string;
  fullWidth?: boolean;
  visibleWhen?: { param: string; value: unknown };
}

export interface GroupDef {
  label: string;
  params: ParamRef[];
  collapsed?: boolean;
}

/**
 * Reference to a parameter in a layout group.
 */
export function Param(
  name: string,
  opts?: { label?: string; fullWidth?: boolean; visibleWhen?: [string, unknown] },
): ParamRef {
  const ref: ParamRef = { name };
  if (opts?.label !== undefined) ref.label = opts.label;
  if (opts?.fullWidth) ref.fullWidth = true;
  if (opts?.visibleWhen) {
    ref.visibleWhen = { param: opts.visibleWhen[0], value: opts.visibleWhen[1] };
  }
  return ref;
}

function paramRefToDict(p: ParamRef): Record<string, unknown> {
  const d: Record<string, unknown> = { name: p.name };
  if (p.label !== undefined) d.label = p.label;
  if (p.fullWidth) d.full_width = true;
  if (p.visibleWhen) {
    d.visible_when = { param: p.visibleWhen.param, value: p.visibleWhen.value };
  }
  return d;
}

/**
 * A group of parameters with a label for UI organization.
 */
export function Group(
  label: string,
  params: ParamRef[],
  opts?: { collapsed?: boolean },
): GroupDef {
  return {
    label,
    params,
    collapsed: opts?.collapsed,
  };
}

function groupToDict(g: GroupDef): Record<string, unknown> {
  const d: Record<string, unknown> = {
    label: g.label,
    params: g.params.map(paramRefToDict),
  };
  if (g.collapsed) d.collapsed = true;
  return d;
}

// --- Tool Parameter Definition ---

export interface ToolParameterDef {
  name: string;
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description?: string;
  required?: boolean;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  items?: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
}

function parameterToSchema(p: ToolParameterDef): Record<string, unknown> {
  const schema: Record<string, unknown> = { type: p.type };
  if (p.description) schema.description = p.description;
  if (p.default !== undefined) schema.default = p.default;
  if (p.enum !== undefined) schema.enum = p.enum;
  if (p.minimum !== undefined) schema.minimum = p.minimum;
  if (p.maximum !== undefined) schema.maximum = p.maximum;
  if (p.items !== undefined) schema.items = p.items;
  if (p.uiHints) {
    for (const [key, value] of Object.entries(p.uiHints)) {
      schema[`x-${key}`] = value;
    }
  }
  return schema;
}

// --- ExecutionContext forward declaration (actual class in provider.ts) ---

export interface ExecutionContext {
  requestId: string;
  tool: Tool;
  parameters: Record<string, unknown>;
  assets: {
    upload(data: Buffer | Uint8Array, extension?: string): Promise<string>;
    download(assetId: string): Promise<Buffer>;
    delete(assetId: string): Promise<boolean>;
    exists(assetId: string): Promise<boolean>;
  };
  signal: AbortSignal;
  reportProgress(progress: number): Promise<void>;
}

export type ToolFunction = (
  context: ExecutionContext,
  parameters: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

// --- Tool ---

export class Tool {
  slug: string;
  displayName: string;
  taskTypes: string[];
  execute: ToolFunction;
  description: string;
  parameters: ToolParameterDef[];
  layout?: GroupDef[];
  metadata: Record<string, unknown>;
  displayPrice?: string;
  badges?: string[];

  constructor(opts: {
    slug: string;
    displayName: string;
    taskTypes: string[];
    execute: ToolFunction;
    description?: string;
    parameters?: ToolParameterDef[];
    layout?: GroupDef[];
    metadata?: Record<string, unknown>;
    displayPrice?: string;
    badges?: string[];
  }) {
    this.slug = opts.slug;
    this.displayName = opts.displayName;
    this.taskTypes = opts.taskTypes;
    this.execute = opts.execute;
    this.description = opts.description ?? "";
    this.parameters = opts.parameters ?? [];
    this.layout = opts.layout;
    this.metadata = opts.metadata ?? {};
    this.displayPrice = opts.displayPrice;
    this.badges = opts.badges;
  }

  toDescriptor(): ToolDescriptor {
    // Build parameter schema
    const paramProperties: Record<string, unknown> = {};
    const paramRequired: string[] = [];
    for (const p of this.parameters) {
      paramProperties[p.name] = parameterToSchema(p);
      if (p.required) paramRequired.push(p.name);
    }
    const parameterSchema: Record<string, unknown> = {
      type: "object",
      properties: paramProperties,
    };
    if (paramRequired.length > 0) {
      parameterSchema.required = paramRequired;
    }

    // Output schema (standard: list of produced assets)
    const outputSchema = {
      type: "object",
      required: ["assets"],
      properties: {
        assets: {
          type: "array",
          items: {
            type: "object",
            required: ["asset_id", "type"],
            properties: {
              asset_id: { type: "string" },
              type: { type: "string", enum: ["image", "video", "audio", "document"] },
              role: { type: "string" },
            },
          },
        },
      },
    };

    // Filter metadata to only JSON-serializable values
    const serializableMetadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.metadata)) {
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean" ||
        v === null ||
        Array.isArray(v) ||
        (typeof v === "object" && v !== null)
      ) {
        serializableMetadata[k] = v;
      }
    }

    // Inject first-class fields into metadata (top-level fields win over metadata)
    if (this.description && !("description" in serializableMetadata)) {
      serializableMetadata.description = this.description;
    }
    if (this.displayPrice && !("display_price" in serializableMetadata)) {
      serializableMetadata.display_price = this.displayPrice;
    }
    if (this.badges && !("badges" in serializableMetadata)) {
      serializableMetadata.badges = this.badges;
    }

    // Serialize layout
    const layoutList = this.layout ? this.layout.map(groupToDict) : undefined;

    return new ToolDescriptor({
      id: this.slug,
      name: this.displayName,
      taskTypes: this.taskTypes,
      parameterSchema,
      outputSchema,
      layout: layoutList,
      metadata: serializableMetadata,
    });
  }
}

// --- Tool Registry ---

export class ToolRegistry {
  private _tools: Map<string, Tool> = new Map();

  register(tool: Tool): void {
    this._tools.set(tool.slug, tool);
  }

  get(slug: string): Tool | undefined {
    return this._tools.get(slug);
  }

  list(): Tool[] {
    return Array.from(this._tools.values());
  }

  listDescriptors(): ToolDescriptor[] {
    return this.list().map((t) => t.toDescriptor());
  }

  clear(): void {
    this._tools.clear();
  }
}

// Global registry instance
const _registry = new ToolRegistry();

export function getRegistry(): ToolRegistry {
  return _registry;
}

// --- defineTool() ---

export interface DefineToolOptions {
  slug: string;
  displayName: string;
  taskType?: string;
  taskTypes?: string | string[];
  description?: string;
  parameters?: ToolParameterDef[];
  layout?: GroupDef[];
  metadata?: Record<string, unknown>;
  displayPrice?: string;
  badges?: string[];
  execute: ToolFunction;
  register?: boolean;
}

/**
 * Define and register a tool.
 *
 * @example
 * ```typescript
 * const myTool = defineTool({
 *   slug: "flux-t2i",
 *   displayName: "Flux Dev T2I",
 *   taskTypes: "text-to-image",
 *   parameters: [
 *     { name: "prompt", type: "string", required: true },
 *     { name: "steps", type: "integer", default: 30 },
 *   ],
 *   execute: async (context, parameters) => {
 *     return { asset_id: "result.png" };
 *   },
 * });
 * ```
 */
export function defineTool(opts: DefineToolOptions): Tool {
  // Resolve task types
  let resolvedTaskTypes: string[];
  if (opts.taskTypes !== undefined) {
    resolvedTaskTypes =
      typeof opts.taskTypes === "string" ? [opts.taskTypes] : [...opts.taskTypes];
  } else if (opts.taskType !== undefined) {
    resolvedTaskTypes = [opts.taskType];
  } else {
    throw new Error(`Tool ${opts.slug} must specify taskType or taskTypes`);
  }

  const tool = new Tool({
    slug: opts.slug,
    displayName: opts.displayName,
    taskTypes: resolvedTaskTypes,
    execute: opts.execute,
    description: opts.description,
    parameters: opts.parameters,
    layout: opts.layout,
    metadata: opts.metadata,
    displayPrice: opts.displayPrice,
    badges: opts.badges,
  });

  if (opts.register !== false) {
    _registry.register(tool);
  }

  return tool;
}
