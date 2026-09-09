import { FinalResponseQueue } from "./final-response-queue.js";
import type { ShadowReport } from "./types.js";

export interface CompletionReviewJob {
  epoch: number;
  shadowId: string;
}

export interface CompletionReviewRequest {
  readonly id: number;
  readonly epoch: number;
}

export interface CompletionReviewRun {
  accept(report: ShadowReport): void;
}

interface QueuedReview<TJob extends CompletionReviewJob>
  extends CompletionReviewJob {
  job: TJob;
  run: CompletionReviewRun;
}

interface ReviewState {
  requestId: number;
  epoch: number;
  remaining: number;
  reports: ShadowReport[];
  shadowIds: readonly string[];
}

export interface CompletionReviewHost<TJob extends CompletionReviewJob> {
  currentEpoch(): number;
  maxParallel(): number;
  activeCount(): number;
  activeShadowIds(): ReadonlySet<string>;
  canLaunch?: () => boolean;
  launch(job: TJob, run: CompletionReviewRun): void;
  deliver(reports: readonly ShadowReport[]): void;
  onReviewCompleted?: (shadowIds: readonly string[]) => void;
}

export class CompletionReview<TJob extends CompletionReviewJob> {
  private requestId = 0;
  private state?: ReviewState;
  private readonly requestByRun = new WeakMap<CompletionReviewRun, number>();
  private readonly queue: FinalResponseQueue<QueuedReview<TJob>>;

  constructor(private readonly host: CompletionReviewHost<TJob>) {
    this.queue = new FinalResponseQueue({
      currentEpoch: () => this.host.currentEpoch(),
      maxParallel: () => this.host.maxParallel(),
      activeCount: () => this.host.activeCount(),
      activeShadowIds: () => this.host.activeShadowIds(),
      canLaunch: () => (this.host.canLaunch ? this.host.canLaunch() : true),
      launch: ({ job, run }) => host.launch(job, run),
    });
  }

  begin(epoch: number): CompletionReviewRequest {
    this.invalidate();
    return { id: this.requestId, epoch };
  }

  isCurrent(request: CompletionReviewRequest): boolean {
    return (
      request.id === this.requestId &&
      request.epoch === this.host.currentEpoch()
    );
  }

  schedule(request: CompletionReviewRequest, jobs: readonly TJob[]): boolean {
    if (
      !this.isCurrent(request) ||
      this.state?.requestId === request.id ||
      jobs.some((job) => job.epoch !== request.epoch)
    ) {
      return false;
    }
    if (jobs.length === 0) {
      this.retire(request.id);
      return true;
    }
    this.state = {
      requestId: request.id,
      epoch: request.epoch,
      remaining: jobs.length,
      reports: [],
      shadowIds: jobs.map((job) => job.shadowId),
    };
    this.queue.enqueue(
      jobs.map((job) => {
        const run: CompletionReviewRun = {
          accept: (report) => this.accept(request.id, report),
        };
        this.requestByRun.set(run, request.id);
        return { epoch: job.epoch, shadowId: job.shadowId, job, run };
      }),
    );
    return true;
  }

  slotAvailable(): void {
    this.queue.slotAvailable();
  }

  complete(run?: CompletionReviewRun): void {
    if (!run) return;
    const requestId = this.requestByRun.get(run);
    this.requestByRun.delete(run);
    if (requestId === undefined || this.state?.requestId !== requestId) return;
    this.state.remaining -= 1;
    if (this.state.remaining > 0) return;

    const reports = this.state.reports;
    const shadowIds = this.state.shadowIds;
    this.retire(requestId);
    this.host.onReviewCompleted?.(shadowIds);
    if (reports.length > 0) this.host.deliver(reports);
  }

  cancel(request: CompletionReviewRequest): void {
    if (this.isCurrent(request)) this.retire(request.id);
  }

  invalidate(): void {
    this.requestId += 1;
    this.state = undefined;
    this.queue.clear();
  }

  private retire(requestId: number): void {
    if (requestId !== this.requestId) return;
    this.requestId += 1;
    this.state = undefined;
    this.queue.clear();
  }

  private accept(requestId: number, report: ShadowReport): void {
    if (
      this.state?.requestId !== requestId ||
      report.epoch !== this.state.epoch
    ) {
      return;
    }
    this.state.reports.push(report);
  }
}
