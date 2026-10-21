//! Small helper for spreading independent work over the CPU cores.

/// `f(0..n)` on all cores (at most 8), a few items at a time so large temporaries stay bounded.
/// Results come back in order.
pub fn par_map<T: Send>(n: usize, f: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let workers = std::thread::available_parallelism().map_or(4, |c| c.get()).min(8);
    if workers <= 1 || n <= 1 {
        return (0..n).map(f).collect();
    }
    let mut out = Vec::with_capacity(n);
    let mut start = 0;
    while start < n {
        let end = (start + workers).min(n);
        let f = &f;
        let batch: Vec<T> = std::thread::scope(|s| {
            let handles: Vec<_> = (start..end).map(|i| s.spawn(move || f(i))).collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        out.extend(batch);
        start = end;
    }
    out
}

/// Number of chunks to cut `n` items into so each core gets a few (1 for small inputs).
pub fn chunks_for(n: usize, min_chunk: usize) -> usize {
    let cores = std::thread::available_parallelism().map_or(4, |c| c.get()).min(8);
    (n / min_chunk.max(1)).clamp(1, cores)
}
