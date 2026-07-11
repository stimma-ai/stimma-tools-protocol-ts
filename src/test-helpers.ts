import { JsonRpcResponse, parseMessage } from "./protocol.js";
import type { Transport } from "./transport.js";

export class MemoryTransport implements Transport {
  private running = false;
  private incoming: Array<string | null> = [];
  private outgoing: string[] = [];
  private incomingWaiters: Array<(message: string | null) => void> = [];
  private outgoingWaiters: Array<(message: string) => void> = [];

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.pushIncoming(null);
  }

  async send(message: string): Promise<void> {
    const waiter = this.outgoingWaiters.shift();
    if (waiter) waiter(message);
    else this.outgoing.push(message);
  }

  async *receive(): AsyncGenerator<string, void, unknown> {
    while (this.running) {
      const message = await this.takeIncoming();
      if (message === null) return;
      yield message;
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  pushIncoming(message: string | null): void {
    const waiter = this.incomingWaiters.shift();
    if (waiter) waiter(message);
    else this.incoming.push(message);
  }

  async takeOutgoing(): Promise<string> {
    const message = this.outgoing.shift();
    if (message !== undefined) return message;
    return new Promise((resolve) => this.outgoingWaiters.push(resolve));
  }

  private async takeIncoming(): Promise<string | null> {
    const message = this.incoming.shift();
    if (message !== undefined) return message;
    return new Promise((resolve) => this.incomingWaiters.push(resolve));
  }

  async hostReceive(method?: string): Promise<Record<string, unknown>> {
    while (true) {
      const parsed = parseMessage(await this.takeOutgoing()).toDict();
      if (method === undefined || parsed.method === method) return parsed;
    }
  }

  hostRespond(request: Record<string, unknown>, result: unknown): void {
    this.pushIncoming(
      JsonRpcResponse.success(request.id as string | number, result).toJson(),
    );
  }
}
