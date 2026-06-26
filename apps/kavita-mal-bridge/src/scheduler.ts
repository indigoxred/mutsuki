export interface BridgeSchedulerResult {
  skipped: boolean;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export class BridgeScheduler {
  lastResult: BridgeSchedulerResult | undefined;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly options: {
      intervalMs: number;
      runSync: () => Promise<unknown>;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runNow();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
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
      await this.options.runSync();
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
