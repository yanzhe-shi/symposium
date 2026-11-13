/**
 * Runs a task when asked, but not more often than every `intervalMs`: the first request runs at
 * once, and requests that arrive while it runs or soon after are answered by one more run.
 * Used to push an agent's live diff while it edits, without running git on every keystroke.
 */
export class PacedTask {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private closed = false;

  constructor(
    private readonly task: () => Promise<void>,
    private readonly intervalMs: number,
  ) {}

  /** Asks for a run. */
  request(): void {
    if (this.closed) return;
    if (this.running || this.timer) {
      this.again = true;
      return;
    }
    this.start();
  }

  /** Stops pacing, waits for a run in progress, then runs one last time. */
  async finish(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
    await this.run();
  }

  private start(): void {
    this.again = false;
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.closed) return;
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.again) this.start();
      }, this.intervalMs);
      this.timer.unref();
    });
  }

  private async run(): Promise<void> {
    try {
      await this.task();
    } catch {
      // A failed run only means a stale view. The next request tries again.
    }
  }
}
