export interface FinalResponseQueueItem {
  epoch: number;
  shadowId: string;
}

export class FinalResponseQueue<T extends FinalResponseQueueItem> {
  private readonly pending: T[] = [];

  constructor(
    private readonly options: {
      currentEpoch: () => number;
      maxParallel: () => number;
      activeCount: () => number;
      activeShadowIds: () => ReadonlySet<string>;
      canLaunch?: () => boolean;
      launch: (item: T) => void;
    },
  ) {}

  enqueue(items: readonly T[]): void {
    this.pending.push(...items);
    this.pump();
  }

  slotAvailable(): void {
    this.pump();
  }

  clear(): void {
    this.pending.length = 0;
  }

  private pump(): void {
    if (this.options.canLaunch && !this.options.canLaunch()) return;
    while (
      this.options.activeCount() < this.options.maxParallel() &&
      this.pending.length > 0
    ) {
      const epoch = this.options.currentEpoch();
      const activeShadowIds = this.options.activeShadowIds();
      const index = this.pending.findIndex(
        (item) => item.epoch !== epoch || !activeShadowIds.has(item.shadowId),
      );
      if (index < 0) return;
      const [item] = this.pending.splice(index, 1);
      if (!item || item.epoch !== epoch) continue;
      this.options.launch(item);
    }
  }
}
