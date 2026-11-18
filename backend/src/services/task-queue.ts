/** FIFO concurrency limit. A queued job is executed once; failures never resubmit it. */
export class TaskQueue {
  private active = 0
  private readonly pending: (() => void)[] = []

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Queue concurrency must be a positive integer')
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(() => {
        this.active++
        void Promise.resolve().then(job).then(resolve, reject).finally(() => {
          this.active--
          this.drain()
        })
      })
      this.drain()
    })
  }

  private drain() {
    while (this.active < this.concurrency && this.pending.length) this.pending.shift()!()
  }
}
