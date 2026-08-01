// Manages a pool of independent ffmpeg-worker.js Worker instances so
// multiple renders can run concurrently without racing each other.
//
// Each ffmpeg-worker.js instance is already fully self-contained — its
// `ffmpeg`/`loaded`/`usingMT` state lives in that worker's own module scope,
// with no cross-worker sharing (confirmed: no BroadcastChannel/SharedWorker
// involved) — so running several of them side by side needs no changes to
// that file beyond one flag (forceST, below). What the OLD single-worker
// code (ffmpegWorker/renderVideoInWorker in app.js, pre-pool) got wrong for
// concurrency was reassigning `worker.onmessage` per call with no request
// correlation — fine for exactly one in-flight request, unsafe for two.
// PoolWorker fixes that by owning one persistent dispatcher per worker
// instance and only ever having one job assigned to it at a time (enforced
// by the pool's acquire/release), so there's still only ever one in-flight
// request per worker — just now there can be several workers at once.
//
// Running N *multi-threaded* ffmpeg cores at once would oversubscribe the
// CPU badly (each mt core spawns its own pthread pool sized to
// hardwareConcurrency) — so whenever the pool size is more than 1, every
// worker is forced onto the single-thread core instead (`forceST`).

const RENDER_STALL_TIMEOUT_MS = 45000;

class PoolWorker {
  constructor(base, fontBuf, forceST) {
    this.base = base;
    this.forceST = forceST;
    this.busy = false;
    this.usingMT = false;
    this._worker = null;
    this._fontBuf = fontBuf;
    this._readyPromise = null;
    this._pending = null; // {resolve, reject, onProgress, stallTimer}
    this._spawn();
  }

  _spawn() {
    this._worker = new Worker(this.base + "ffmpeg-worker.js");
    this._worker.onmessage = (e) => this._handleMessage(e);
    this._worker.onerror = (e) => this._handleFatalError(e);
  }

  ensureReady() {
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // Each worker needs its own copy of the font ArrayBuffer — transferring
    // detaches it from the sender, so the same buffer can't be handed to
    // more than one worker.
    const fontCopy = this._fontBuf.slice(0);
    this._worker.postMessage(
      { type: "ready", base: this.base, font: fontCopy, forceST: this.forceST },
      [fontCopy]
    );
    return this._readyPromise;
  }

  // Render one job. Resolves to a Uint8Array of the rendered MP4. forceST is
  // already established during ensureReady()'s handshake, so it doesn't
  // need to be resent here.
  render(payload, onProgress) {
    return this._run((worker) => {
      worker.postMessage(payload, [payload.bg.buffer, payload.audio.buffer]);
    }, onProgress, /* watchdog */ true);
  }

  // Re-encodes an unsupported-codec video to H.264. Caller streams frames in
  // via postFrame(); resolves to a Blob once postFinish() is called and the
  // worker replies. No stall watchdog here (mirrors the pre-pool behavior —
  // the frame loop itself is the caller's synchronous progress signal).
  postFrame(index, bytes) {
    this._worker.postMessage({ type: "convertFrame", index, data: bytes.buffer }, [bytes.buffer]);
  }
  transcodeFinish(fps, frameCount) {
    return this._run((worker) => {
      worker.postMessage({ type: "convertFinish", fps, frameCount });
    }, null, /* watchdog */ false);
  }

  _run(send, onProgress, watchdog) {
    return new Promise((resolve, reject) => {
      this._pending = { resolve, reject, onProgress, isTranscode: !watchdog };
      if (watchdog) this._resetStallTimer();
      send(this._worker);
    });
  }

  _resetStallTimer() {
    clearTimeout(this._stallTimer);
    this._stallTimer = setTimeout(() => {
      // Unrecoverably stuck mid-exec (synchronous WASM call) — replace this
      // pool slot's worker outright rather than leaving a job stalled forever.
      const pending = this._pending;
      this._pending = null;
      this._worker.terminate();
      this._readyPromise = null;
      this._spawn();
      if (pending) {
        pending.reject(new Error(
          "Rendering stalled with no progress for " + (RENDER_STALL_TIMEOUT_MS / 1000) +
          "s. This almost always means the background video's codec (e.g. AV1/VP9) " +
          "isn't supported by the in-browser renderer — re-encode it to H.264 and try again."
        ));
      }
    }, RENDER_STALL_TIMEOUT_MS);
  }

  _handleMessage(e) {
    const msg = e.data;
    if (msg.type === "ready") {
      this.usingMT = !!msg.mt;
      if (this._readyResolve) { this._readyResolve(); this._readyResolve = null; this._readyReject = null; }
    } else if (msg.type === "progress") {
      if (this._pending) {
        this._resetStallTimer();
        if (this._pending.onProgress) this._pending.onProgress(msg.progress || 0);
      }
    } else if (msg.type === "done") {
      clearTimeout(this._stallTimer);
      this._settle(null, new Uint8Array(msg.data));
    } else if (msg.type === "convertDone") {
      this._settle(null, new Blob([msg.data], { type: "video/mp4" }));
    } else if (msg.type === "error") {
      clearTimeout(this._stallTimer);
      if (this._readyReject) { this._readyReject(new Error(msg.message)); this._readyResolve = null; this._readyReject = null; return; }
      this._settle(new Error(msg.message), null);
    }
  }

  _settle(err, value) {
    const pending = this._pending;
    this._pending = null;
    if (!pending) return;
    if (err) pending.reject(err); else pending.resolve(value);
  }

  _handleFatalError(e) {
    const pending = this._pending;
    this._pending = null;
    const readyReject = this._readyReject;
    this._readyResolve = null;
    this._readyReject = null;
    const err = new Error("video worker failed: " + (e.message || "unknown"));
    if (readyReject) readyReject(err);
    if (pending) pending.reject(err);
  }
}

class FFmpegWorkerPool {
  constructor(size, base, fontBuf) {
    this.size = Math.max(1, size);
    this.base = base;
    this.fontBuf = fontBuf;
    // Only the single-thread core avoids the pthread-oversubscription risk
    // of running several multi-threaded cores at once — see file comment.
    this.forceST = this.size > 1;
    this._slots = [];
    this._waiters = [];
  }

  _slot(i) {
    if (!this._slots[i]) this._slots[i] = new PoolWorker(this.base, this.fontBuf, this.forceST);
    return this._slots[i];
  }

  // Warms every pool slot up front so the first batch of jobs doesn't pay
  // the ffmpeg-core load cost serially. Safe to call more than once.
  async warmUp(onEach) {
    const ready = [];
    for (let i = 0; i < this.size; i++) {
      const worker = this._slot(i);
      ready.push(worker.ensureReady().then(() => { if (onEach) onEach(i, this.size); }));
    }
    await Promise.all(ready);
  }

  // Every slot in a given pool made the same forceST decision, so any
  // warmed-up slot's usingMT reflects the whole pool.
  get usingMT() {
    return !!(this._slots[0] && this._slots[0].usingMT);
  }

  // Runs `taskFn(worker)` on the next available pool worker, queueing if all
  // slots are busy. `taskFn` must await everything it needs from the worker
  // before returning — the slot is released as soon as its promise settles.
  async submit(taskFn) {
    const worker = await this._acquire();
    try {
      await worker.ensureReady();
      return await taskFn(worker);
    } finally {
      this._release(worker);
    }
  }

  _acquire() {
    for (let i = 0; i < this.size; i++) {
      const worker = this._slot(i);
      if (!worker.busy) {
        worker.busy = true;
        return Promise.resolve(worker);
      }
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _release(worker) {
    worker.busy = false;
    const next = this._waiters.shift();
    if (next) {
      worker.busy = true;
      next(worker);
    }
  }

  // Terminates every underlying Worker. Only safe to call once nothing is
  // mid-flight on this pool — the caller (ensureFFmpeg in app.js) only does
  // this when growing to a larger pool size than currently allocated, which
  // otherwise would silently leak the smaller pool's Workers running forever
  // in the background.
  destroy() {
    for (const worker of this._slots) {
      if (worker && worker._worker) worker._worker.terminate();
    }
    this._slots = [];
    this._waiters = [];
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { FFmpegWorkerPool, PoolWorker };
}
