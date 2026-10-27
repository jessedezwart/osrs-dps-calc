import {
  OptimizeGearRequest, OptimizerWorkerRequest, OptimizerWorkerResponse,
} from '@/worker/CalcWorkerTypes';
import { JobOutcome, OptimizerJob } from '@/lib/optimizer';
import { DeferredPromise, WORKER_JSON_REPLACER, WORKER_JSON_REVIVER } from '@/utils';

interface QueuedJob {
  job: OptimizerJob;
  deferred: DeferredPromise<JobOutcome>;
}

/**
 * A pool of workers that run gear optimizer jobs in parallel. Each worker has its own GearOptimizer (and cache), which
 * is created again for every search by init().
 */
export default class OptimizerPool {
  private readonly workers: Worker[] = [];

  private readonly idle: Worker[] = [];

  private queue: QueuedJob[] = [];

  /** The running jobs, with the evaluations their worker had performed when the job started. */
  private readonly running = new Map<number, QueuedJob & { worker: Worker, evaluationsAtStart: number }>();

  /** The evaluations each worker has performed in the current search. */
  private readonly evaluations = new Map<Worker, number>();

  private onEvaluations?: (evaluations: number) => void;

  private nextId = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL('./optimizerWorker.ts', import.meta.url));
      worker.onmessage = (evt: MessageEvent<string>) => this.onMessage(worker, evt);
      worker.onerror = (evt: ErrorEvent) => this.onError(worker, evt);
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  get size(): number {
    return this.workers.length;
  }

  /** The total evaluations performed by all workers in the current search. */
  get totalEvaluations(): number {
    let total = 0;
    for (const e of this.evaluations.values()) total += e;
    return total;
  }

  /**
   * Starts a new search: every worker gets a fresh GearOptimizer for these inputs.
   * @param onEvaluations - called with the total evaluations whenever a worker reports progress
   */
  public init(data: OptimizeGearRequest['data'], onEvaluations?: (evaluations: number) => void) {
    this.onEvaluations = onEvaluations;
    this.evaluations.clear();
    const msg = JSON.stringify(<OptimizerWorkerRequest>{ type: 'init', data }, WORKER_JSON_REPLACER);
    for (const worker of this.workers) {
      worker.postMessage(msg);
    }
  }

  /** Runs the job on the next free worker, and returns its result and how many evaluations it took. */
  public run(job: OptimizerJob): Promise<JobOutcome> {
    const deferred = new DeferredPromise<JobOutcome>();
    this.queue.push({ job, deferred });
    this.dispatch();
    return deferred.promise;
  }

  /** Stops all workers, failing any jobs that haven't finished. The pool can't be used afterwards. */
  public terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    const error = new Error('The gear optimizer was cancelled');
    for (const { deferred } of [...this.running.values(), ...this.queue]) {
      deferred.reject(error);
    }
    this.running.clear();
    this.queue = [];
    this.idle.length = 0;
  }

  private dispatch() {
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop()!;
      const queued = this.queue.shift()!;
      const id = this.nextId;
      this.nextId += 1;
      this.running.set(id, { ...queued, worker, evaluationsAtStart: this.evaluations.get(worker) ?? 0 });
      worker.postMessage(JSON.stringify(<OptimizerWorkerRequest>{ type: 'job', id, job: queued.job }, WORKER_JSON_REPLACER));
    }
  }

  private onMessage(worker: Worker, evt: MessageEvent<string>) {
    const msg = JSON.parse(evt.data, WORKER_JSON_REVIVER) as OptimizerWorkerResponse;
    if (msg.type === 'progress') {
      this.evaluations.set(worker, msg.evaluations);
      this.onEvaluations?.(this.totalEvaluations);
      return;
    }

    const job = this.running.get(msg.id);
    if (!job) return;
    this.running.delete(msg.id);
    this.idle.push(worker);

    if (msg.type === 'error') {
      job.deferred.reject(new Error(msg.error));
    } else {
      this.evaluations.set(worker, msg.evaluations);
      job.deferred.resolve({ result: msg.result, evaluations: msg.evaluations - job.evaluationsAtStart });
    }
    this.dispatch();
  }

  private onError(worker: Worker, evt: ErrorEvent) {
    console.error('[OptimizerPool] Worker error', evt.message, evt);
    // fail whatever the worker was running, as it won't respond to it
    for (const [id, job] of this.running) {
      if (job.worker !== worker) continue;
      this.running.delete(id);
      this.idle.push(worker);
      job.deferred.reject(new Error(evt.message || 'The gear optimizer worker failed'));
    }
    this.dispatch();
  }
}
