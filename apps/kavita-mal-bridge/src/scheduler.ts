export interface BridgeSchedulerResult {
  skipped: boolean;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export class BridgeScheduler {
  lastResult: BridgeSchedulerResult | undefined;
  currentIntervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly runSync: () => Promise<unknown>;

  constructor(options: { intervalMs: number; runSync: () => Promise<unknown> }) {
    this.currentIntervalMs = options.intervalMs;
    this.runSync = options.runSync;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runNow();
    }, this.currentIntervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  updateIntervalMs(intervalMs: number): void {
    if (
      !Number.isSafeInteger(intervalMs) ||
      intervalMs <= 0 ||
      intervalMs === this.currentIntervalMs
    ) {
      return;
    }
    const wasRunning = this.timer !== undefined;
    this.stop();
    this.currentIntervalMs = intervalMs;
    if (wasRunning) this.start();
  }

  async runNow(): Promise<BridgeSchedulerResult> {
    const startedAt = new Date().toISOString();
    if (this.running) {
      this.lastResult = {
        skipped: true,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      return this.lastResult;
    }
    this.running = true;
    try {
      await this.runSync();
      const result = {
        skipped: false,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
      if (!this.lastResult?.skipped) this.lastResult = result;
      return result;
    } catch (error) {
      const result = {
        skipped: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown scheduler error.",
      };
      if (!this.lastResult?.skipped) this.lastResult = result;
      return result;
    } finally {
      this.running = false;
    }
  }
}
