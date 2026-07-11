# stimma-tools-protocol

[![CI](https://github.com/stimma-ai/stimma-tools-protocol-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/stimma-ai/stimma-tools-protocol-ts/actions/workflows/ci.yml)

TypeScript framework for building Stimma Tool Protocol (STP) providers.

STP providers expose tools (image generation, editing, etc.) to the Stimma application over JSON-RPC. This library handles the protocol plumbing so you can focus on implementing tools.

## Installation

```bash
npm install stimma-tools-protocol
```

## Usage

```typescript
import {
  defineTool, Provider, runProvider,
  setupLogging, createArgumentParser,
} from "stimma-tools-protocol";
import type { ExecutionContext } from "stimma-tools-protocol";

const myTool = defineTool({
  slug: "my-tool",
  displayName: "My Tool",
  taskTypes: "text-to-image",
  parameters: [
    { name: "prompt", type: "string", required: true },
    { name: "steps", type: "integer", default: 30 },
  ],
  execute: async (context, parameters) => {
    const prompt = parameters.prompt as string;
    const steps = parameters.steps as number;

    await context.reportProgress(0.5);

    // Your generation logic here
    const data = generateImage(prompt, steps);
    const assetId = await context.assets.upload(data, ".png");

    return { asset_id: assetId };
  },
});

const parser = createArgumentParser("My Provider");
const args = parser.parse();
setupLogging(args.logLevel);

const provider = new Provider({
  config: {
    providerId: "my-provider",
    providerName: "My Provider",
    maxConcurrent: 2,
  },
});

await runProvider(provider, args);
```

## Running

```bash
# Stdio mode (Stimma spawns as subprocess)
npx tsx my_provider.ts --stdio

# WebSocket mode (standalone server)
npx tsx my_provider.ts --websocket --port 8765
```

## Features

- `defineTool()` for defining tools with typed parameters
- `STANDARD_TASK_TYPES` export for recognized STP task types, including `video-to-video`
- Automatic JSON Schema generation
- Progress reporting
- Asset upload/download
- Stdio and WebSocket transports
- Job queuing with configurable concurrency
- Cancellation support via AbortSignal

## Examples

See `examples/hello-world/` for a working provider.

## License

Apache License 2.0. See [LICENSE](LICENSE).
