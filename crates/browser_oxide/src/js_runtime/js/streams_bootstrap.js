// WHATWG Streams — ReadableStream / WritableStream / TransformStream.
//
// Scoped to the shape and one-read-cycle behaviour fingerprint-sensitive
// sites probe:
//   • `typeof ReadableStream === 'function'` — exists
//   • `new ReadableStream({...}).getReader().read()` — returns chunks
//   • `response.body.getReader()` — wired up in fetch_bootstrap
//   • `tee()` returns two independently-readable branches
//   • `pipeTo` / `pipeThrough` — flow through a writable sink
//
// NOT implemented: byte streams (`ReadableStreamBYOBReader`), HWM-based
// backpressure, strict state machine transitions, custom queuing
// strategies. A probe that exercises those would see slightly off
// behaviour; one that just does read()/close()/tee() sees Chrome-like
// output.

((globalThis) => {
    // Avoid double-install on re-run of bootstraps.
    const _boNs = (() => {
        try {
            const syms = Object.getOwnPropertySymbols(globalThis, 1);
            for (let i = 0; i < syms.length; i++) {
                const v = globalThis[syms[i]];
                if (v && v.__bo) return v;
            }
        } catch (_) {}
        return null;
    })();
    const _idl = (_boNs && _boNs.idl) || {
        own: (obj) => obj,
        read: () => undefined,
        fields: () => {},
    };
    if (_boNs && _boNs.realStreams && _boNs.realStreams === globalThis.ReadableStream) {
        return;
    }

    // -----------------------------------------------------------------
    // ReadableStream
    // -----------------------------------------------------------------

    const _readerDrain = (reader) => {
        // Called by the stream when state changes — resolve any
        // pending reads that can now be answered.
        if (!_idl.own(reader)._stream) return;
        const stream = _idl.own(reader)._stream;
        while (_idl.own(reader)._pending.length > 0) {
            if (_idl.own(stream)._queue.length > 0) {
                const p = _idl.own(reader)._pending.shift();
                p.resolve({ value: _idl.own(stream)._queue.shift(), done: false });
            } else if (_idl.own(stream)._state === "closed") {
                const p = _idl.own(reader)._pending.shift();
                p.resolve({ value: undefined, done: true });
            } else if (_idl.own(stream)._state === "errored") {
                const p = _idl.own(reader)._pending.shift();
                p.reject(_idl.own(stream)._error);
            } else {
                break;
            }
        }
        // Settle `closed` once the stream terminates.
        if (_idl.own(stream)._state === "closed" && _idl.own(reader)._closedResolve) {
            _idl.own(reader)._closedResolve();
            _idl.own(reader)._closedResolve = null;
            _idl.own(reader)._closedReject = null;
        } else if (_idl.own(stream)._state === "errored" && _idl.own(reader)._closedReject) {
            _idl.own(reader)._closedReject(_idl.own(stream)._error);
            _idl.own(reader)._closedResolve = null;
            _idl.own(reader)._closedReject = null;
        }
    };
    const _streamStart = (stream) => {
        if (_idl.own(stream)._started) return;
        _idl.own(stream)._started = true;
        const controller = new ReadableStreamDefaultController(stream);
        _idl.own(stream)._controller = controller;
        if (typeof _idl.own(stream)._underlyingSource.start === "function") {
            try {
                const r = _idl.own(stream)._underlyingSource.start(controller);
                if (r && typeof r.then === "function") {
                    r.catch((e) => controller.error(e));
                }
            } catch (e) {
                controller.error(e);
                return;
            }
        }
        // Trigger an initial pull so pull-based sources produce
        // their first chunk even if read() hasn't been called yet.
        _streamPull(stream);
    };
    const _streamPull = (stream) => {
        if (_idl.own(stream)._pullInFlight) return;
        if (_idl.own(stream)._state !== "readable") return;
        if (typeof _idl.own(stream)._underlyingSource.pull !== "function") return;
        _idl.own(stream)._pullInFlight = true;
        try {
            const r = _idl.own(stream)._underlyingSource.pull(_idl.own(stream)._controller);
            Promise.resolve(r)
                .then(() => {
                    _idl.own(stream)._pullInFlight = false;
                })
                .catch((e) => {
                    _idl.own(stream)._pullInFlight = false;
                    if (_idl.own(stream)._controller) _idl.own(stream)._controller.error(e);
                });
        } catch (e) {
            _idl.own(stream)._pullInFlight = false;
            _idl.own(stream)._controller && _idl.own(stream)._controller.error(e);
        }
    };
    const _streamDrain = (stream) => {
        if (_idl.own(stream)._reader) _readerDrain(_idl.own(stream)._reader);
    };

    class ReadableStreamDefaultController {
        #stream;
        constructor(stream) {
            this.#stream = stream;
        }
        get desiredSize() {
            // Unbounded queue — always "room for more".
            return 1;
        }
        enqueue(chunk) {
            if (_idl.own(this.#stream)._state !== "readable") {
                throw new TypeError(
                    "ReadableStreamDefaultController.enqueue called on " +
                        _idl.own(this.#stream)._state +
                        " stream"
                );
            }
            _idl.own(this.#stream)._queue.push(chunk);
            _streamDrain(this.#stream);
        }
        close() {
            if (_idl.own(this.#stream)._state !== "readable") return;
            _idl.own(this.#stream)._state = "closed";
            _streamDrain(this.#stream);
        }
        error(reason) {
            if (_idl.own(this.#stream)._state !== "readable") return;
            _idl.own(this.#stream)._state = "errored";
            _idl.own(this.#stream)._error = reason;
            _streamDrain(this.#stream);
        }
    }

    class ReadableStreamDefaultReader {
        constructor(stream) {
            const _st = _idl.own(this);
            if (_idl.own(stream)._locked) {
                throw new TypeError(
                    "ReadableStream is locked to another reader"
                );
            }
            _idl.own(stream)._locked = true;
            _idl.own(this)._stream = stream;
            // `_pending` is a FIFO of resolvers waiting for read()s
            // that arrived before a chunk was ready.
            _idl.own(this)._pending = [];
            _idl.own(this)._closedResolve = null;
            _idl.own(this)._closedReject = null;
            _st.closed = new Promise((resolve, reject) => {
                _idl.own(this)._closedResolve = resolve;
                _idl.own(this)._closedReject = reject;
            });
            // If the stream is already closed/errored when the reader
            // attaches, settle `closed` immediately so awaiters unblock.
            if (_idl.own(stream)._state === "closed") {
                _idl.own(this)._closedResolve();
            } else if (_idl.own(stream)._state === "errored") {
                _idl.own(this)._closedReject(_idl.own(stream)._error);
            }
        }
        read() {
            if (!_idl.own(this)._stream) {
                return Promise.reject(
                    new TypeError("reader released")
                );
            }
            const stream = _idl.own(this)._stream;
            if (_idl.own(stream)._state === "errored") {
                return Promise.reject(_idl.own(stream)._error);
            }
            if (_idl.own(stream)._queue.length > 0) {
                // Kick the pull machinery to refill — noop for
                // one-shot streams, useful for pull-based ones.
                queueMicrotask(() => _streamPull(stream));
                return Promise.resolve({
                    value: _idl.own(stream)._queue.shift(),
                    done: false,
                });
            }
            if (_idl.own(stream)._state === "closed") {
                return Promise.resolve({ value: undefined, done: true });
            }
            // Queue is empty but stream is still readable — wait for
            // the next enqueue / close.
            return new Promise((resolve, reject) => {
                _idl.own(this)._pending.push({ resolve, reject });
                queueMicrotask(() => _streamPull(stream));
            });
        }
        cancel(reason) {
            if (!_idl.own(this)._stream) return Promise.resolve();
            const stream = _idl.own(this)._stream;
            _idl.own(stream)._state = "closed";
            _idl.own(stream)._queue.length = 0;
            if (typeof _idl.own(stream)._underlyingSource?.cancel === "function") {
                try {
                    const r = _idl.own(stream)._underlyingSource.cancel(reason);
                    return Promise.resolve(r);
                } catch (e) {
                    return Promise.reject(e);
                }
            }
            _readerDrain(this);
            return Promise.resolve();
        }
        releaseLock() {
            if (!_idl.own(this)._stream) return;
            _idl.own(this._stream)._locked = false;
            _idl.own(this)._stream = null;
        }
    }
    _idl.fields(ReadableStreamDefaultReader.prototype, ["closed"]);

    class ReadableStream {
        constructor(underlyingSource, _strategy) {
            _idl.own(this)._underlyingSource = underlyingSource || {};
            _idl.own(this)._queue = [];
            _idl.own(this)._state = "readable";
            _idl.own(this)._error = null;
            _idl.own(this)._locked = false;
            _idl.own(this)._reader = null;
            _idl.own(this)._pullInFlight = false;
            _idl.own(this)._started = false;
            // Kick the `start` callback on a microtask so it sees a
            // fully-constructed controller + stream object.
            queueMicrotask(() => _streamStart(this));
        }
        get locked() {
            return _idl.own(this)._locked;
        }
        getReader(_options) {
            const reader = new ReadableStreamDefaultReader(this);
            _idl.own(this)._reader = reader;
            // Immediate drain in case the stream was already closed.
            _readerDrain(reader);
            return reader;
        }
        cancel(reason) {
            if (_idl.own(this)._state === "closed") return Promise.resolve();
            _idl.own(this)._state = "closed";
            _idl.own(this)._queue.length = 0;
            if (_idl.own(this)._reader) _readerDrain(_idl.own(this)._reader);
            if (typeof _idl.own(this)._underlyingSource.cancel === "function") {
                try {
                    const r = _idl.own(this)._underlyingSource.cancel(reason);
                    return Promise.resolve(r);
                } catch (e) {
                    return Promise.reject(e);
                }
            }
            return Promise.resolve();
        }
        tee() {
            // Spec: two independent ReadableStream branches that each
            // receive every chunk the source produces. We implement
            // this push-style: `pump()` reads from the source and
            // enqueues each chunk onto both branches' controllers.
            //
            // Controllers are captured via `start(c)` at construction,
            // and `pump()` only runs AFTER both branches' start
            // callbacks have fired — we queueMicrotask the pump so
            // the controller assignments happen first.
            const source = this;
            let b1Controller = null;
            let b2Controller = null;
            const sourceReader = source.getReader();

            const pump = () => {
                sourceReader.read().then(
                    ({ done, value }) => {
                        if (done) {
                            if (b1Controller) try { b1Controller.close(); } catch (_) {}
                            if (b2Controller) try { b2Controller.close(); } catch (_) {}
                            return;
                        }
                        if (b1Controller) try { b1Controller.enqueue(value); } catch (_) {}
                        if (b2Controller) try { b2Controller.enqueue(value); } catch (_) {}
                        pump();
                    },
                    (err) => {
                        if (b1Controller) try { b1Controller.error(err); } catch (_) {}
                        if (b2Controller) try { b2Controller.error(err); } catch (_) {}
                    }
                );
            };

            const b1s = new ReadableStream({
                start(c) { b1Controller = c; },
                cancel() { sourceReader.cancel(); },
            });
            const b2s = new ReadableStream({
                start(c) { b2Controller = c; },
                cancel() { sourceReader.cancel(); },
            });
            // Wait for both branches' `start` callbacks (queued in
            // their constructors) to run before pumping.
            queueMicrotask(() => queueMicrotask(pump));
            return [b1s, b2s];
        }
        pipeTo(destination, _options) {
            if (!(destination instanceof WritableStream)) {
                return Promise.reject(
                    new TypeError("pipeTo requires a WritableStream")
                );
            }
            const reader = this.getReader();
            const writer = destination.getWriter();
            return new Promise((resolve, reject) => {
                const step = () => {
                    reader.read().then(
                        ({ done, value }) => {
                            if (done) {
                                writer.close().then(resolve, reject);
                                return;
                            }
                            writer.write(value).then(step, reject);
                        },
                        (err) => {
                            writer.abort(err).then(
                                () => reject(err),
                                () => reject(err)
                            );
                        }
                    );
                };
                step();
            });
        }
        pipeThrough(transform, options) {
            if (!transform || !transform.readable || !transform.writable) {
                throw new TypeError("pipeThrough requires a TransformStream");
            }
            // Fire and forget — the caller consumes `transform.readable`.
            this.pipeTo(transform.writable, options).catch(() => {});
            return transform.readable;
        }
        [Symbol.asyncIterator]() {
            const reader = this.getReader();
            return {
                next() {
                    return reader.read();
                },
                return() {
                    reader.releaseLock();
                    return Promise.resolve({ value: undefined, done: true });
                },
                [Symbol.asyncIterator]() {
                    return this;
                },
            };
        }
    }


    // -----------------------------------------------------------------
    // WritableStream
    // -----------------------------------------------------------------

    class WritableStreamDefaultWriter {
        #stream;
        constructor(stream) {
            const _st = _idl.own(this);
            if (_idl.own(stream)._locked) {
                throw new TypeError(
                    "WritableStream is locked to another writer"
                );
            }
            _idl.own(stream)._locked = true;
            this.#stream = stream;
            _st.ready = Promise.resolve();
            _st.closed = new Promise((resolve, reject) => {
                _idl.own(stream)._closedResolve = resolve;
                _idl.own(stream)._closedReject = reject;
            });
        }
        get desiredSize() {
            return 1;
        }
        write(chunk) {
            if (!this.#stream) return Promise.reject(new TypeError("released"));
            if (_idl.own(this.#stream)._state !== "writable") {
                return Promise.reject(
                    new TypeError(
                        "write on " + _idl.own(this.#stream)._state + " stream"
                    )
                );
            }
            const sink = _idl.own(this.#stream)._underlyingSink;
            if (typeof sink.write === "function") {
                try {
                    const r = sink.write(chunk, _idl.own(this.#stream)._controller);
                    return Promise.resolve(r);
                } catch (e) {
                    return Promise.reject(e);
                }
            }
            return Promise.resolve();
        }
        close() {
            if (!this.#stream) return Promise.reject(new TypeError("released"));
            const stream = this.#stream;
            if (_idl.own(stream)._state !== "writable") {
                return Promise.reject(
                    new TypeError("close on " + _idl.own(stream)._state + " stream")
                );
            }
            _idl.own(stream)._state = "closed";
            const sink = _idl.own(stream)._underlyingSink;
            const result =
                typeof sink.close === "function"
                    ? Promise.resolve(sink.close())
                    : Promise.resolve();
            return result.then(() => {
                _idl.own(stream)._closedResolve && _idl.own(stream)._closedResolve();
            });
        }
        abort(reason) {
            if (!this.#stream) return Promise.resolve();
            const stream = this.#stream;
            _idl.own(stream)._state = "errored";
            const sink = _idl.own(stream)._underlyingSink;
            const result =
                typeof sink.abort === "function"
                    ? Promise.resolve(sink.abort(reason))
                    : Promise.resolve();
            return result.then(() => {
                _idl.own(stream)._closedReject && _idl.own(stream)._closedReject(reason);
            });
        }
        releaseLock() {
            if (!this.#stream) return;
            _idl.own(this.#stream)._locked = false;
            this.#stream = null;
        }
    }
    _idl.fields(WritableStreamDefaultWriter.prototype, ["closed", "ready"]);

    class WritableStreamDefaultController {
        #stream;
        constructor(stream) {
            this.#stream = stream;
        }
        error(reason) {
            _idl.own(this.#stream)._state = "errored";
            _idl.own(this.#stream)._error = reason;
        }
    }

    class WritableStream {
        constructor(underlyingSink, _strategy) {
            _idl.own(this)._underlyingSink = underlyingSink || {};
            _idl.own(this)._state = "writable";
            _idl.own(this)._error = null;
            _idl.own(this)._locked = false;
            _idl.own(this)._controller = new WritableStreamDefaultController(this);
            _idl.own(this)._closedResolve = null;
            _idl.own(this)._closedReject = null;
            if (typeof _idl.own(this)._underlyingSink.start === "function") {
                try {
                    _idl.own(this)._underlyingSink.start(_idl.own(this)._controller);
                } catch (e) {
                    _idl.own(this)._state = "errored";
                    _idl.own(this)._error = e;
                }
            }
        }
        get locked() {
            return _idl.own(this)._locked;
        }
        getWriter() {
            return new WritableStreamDefaultWriter(this);
        }
        abort(reason) {
            _idl.own(this)._state = "errored";
            _idl.own(this)._error = reason;
            const sink = _idl.own(this)._underlyingSink;
            return typeof sink.abort === "function"
                ? Promise.resolve(sink.abort(reason))
                : Promise.resolve();
        }
        close() {
            if (_idl.own(this)._state !== "writable") return Promise.resolve();
            _idl.own(this)._state = "closed";
            const sink = _idl.own(this)._underlyingSink;
            return typeof sink.close === "function"
                ? Promise.resolve(sink.close())
                : Promise.resolve();
        }
    }

    // -----------------------------------------------------------------
    // TransformStream
    // -----------------------------------------------------------------

    class TransformStream {
        constructor(transformer, _writableStrategy, _readableStrategy) {
            const _st = _idl.own(this);
            transformer = transformer || {};
            let readableController = null;
            let readableResolved;
            _st.readable = new ReadableStream({
                start(c) {
                    readableController = c;
                },
            });
            // Make sure `readable._pull` runs so `start` assigns the
            // controller before any write() comes in.
            // `writable.write(chunk)` calls `transformer.transform(chunk,
            // controller)` which is free to call `controller.enqueue` on
            // the readable side.
            _st.writable = new WritableStream({
                async write(chunk) {
                    if (typeof transformer.transform === "function") {
                        await transformer.transform(chunk, readableController);
                    } else {
                        readableController &&
                            readableController.enqueue(chunk);
                    }
                },
                close() {
                    if (typeof transformer.flush === "function") {
                        try {
                            transformer.flush(readableController);
                        } catch (_e) {}
                    }
                    readableController && readableController.close();
                },
                abort(e) {
                    readableController && readableController.error(e);
                },
            });
            if (typeof transformer.start === "function") {
                try {
                    transformer.start(readableController);
                } catch (_e) {}
            }
        }
    }
    _idl.fields(TransformStream.prototype, ["readable", "writable"]);

    // -----------------------------------------------------------------
    // Install globals — overwrite the earlier stubs.
    // -----------------------------------------------------------------
    globalThis.ReadableStream = ReadableStream;
    if (_boNs) _boNs.realStreams = ReadableStream;
    globalThis.ReadableStreamDefaultReader = ReadableStreamDefaultReader;
    globalThis.ReadableStreamDefaultController = ReadableStreamDefaultController;
    globalThis.WritableStream = WritableStream;
    globalThis.WritableStreamDefaultWriter = WritableStreamDefaultWriter;
    globalThis.WritableStreamDefaultController = WritableStreamDefaultController;
    globalThis.TransformStream = TransformStream;

    // Response.body integration lives in fetch_bootstrap.js — it's
    // defined as a getter on the Response class because the private
    // fields there aren't reachable from an external monkey-patch.
    // By the time any Response's body getter fires, ReadableStream is
    // installed via this script (which runs before any user JS).
})(globalThis);
