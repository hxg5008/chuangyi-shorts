/** Serial, keyed polling. Disposing also prevents an in-flight callback from scheduling again. */
export function createPollingScope({ setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let disposed = false
  const timers = new Set()
  const jobs = new Map()

  function later(callback, delay) {
    if (disposed) return null
    const timer = setTimer(() => {
      timers.delete(timer)
      if (!disposed) callback()
    }, delay)
    timers.add(timer)
    return timer
  }

  function stop(key) {
    const job = jobs.get(key)
    jobs.delete(key)
    if (job?.timer != null) {
      clearTimer(job.timer)
      timers.delete(job.timer)
    }
  }

  function start(key, tick, delay = 4000, immediate = false) {
    if (disposed || jobs.has(key)) return
    const job = { timer: null }
    jobs.set(key, job)
    async function run() {
      job.timer = null
      if (disposed || jobs.get(key) !== job) return
      let keepPolling = true
      try { keepPolling = (await tick()) !== false } catch { /* Retry temporary request failures. */ }
      if (disposed || jobs.get(key) !== job) return
      if (keepPolling) job.timer = later(run, delay)
      else jobs.delete(key)
    }
    if (immediate) void run()
    else job.timer = later(run, delay)
  }

  function dispose() {
    disposed = true
    jobs.clear()
    for (const timer of timers) clearTimer(timer)
    timers.clear()
  }

  return { start, stop, later, dispose, get active() { return !disposed } }
}
