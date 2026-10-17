//! Cache for computed results (PSD, FFT, stats, correlations).
//!
//! Keyed by `(signal_name, operation, params_hash)`; invalidated per signal or globally.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};

use super::correlation::CorrelationResult;
use super::spectrum::{PsdResult, SpectrumResult};
use super::stats::StatRow;

#[derive(Clone)]
pub enum CacheValue {
    Stats(Arc<Vec<StatRow>>),
    Correlation(Arc<CorrelationResult>),
    Fft(Arc<SpectrumResult>),
    Psd(Arc<PsdResult>),
}

pub type CacheKey = (String, String, String);

pub const ALL_SIGNALS: &str = "__all__";

pub fn params_hash(params: &[(&str, f64)]) -> String {
    if params.is_empty() {
        return "default".into();
    }
    let mut sorted: Vec<(&str, u64)> = params.iter().map(|(k, v)| (*k, v.to_bits())).collect();
    sorted.sort();
    let mut h = DefaultHasher::new();
    sorted.hash(&mut h);
    format!("{:012x}", h.finish() & 0xffff_ffff_ffff)
}

#[derive(Default)]
pub struct CacheManager {
    store: Mutex<HashMap<CacheKey, CacheValue>>,
}

impl CacheManager {
    pub fn make_key(signal: &str, op: &str, params: &[(&str, f64)]) -> CacheKey {
        (signal.to_string(), op.to_string(), params_hash(params))
    }

    pub fn get(&self, key: &CacheKey) -> Option<CacheValue> {
        self.store.lock().unwrap().get(key).cloned()
    }

    pub fn set(&self, key: CacheKey, value: CacheValue) {
        self.store.lock().unwrap().insert(key, value);
    }

    pub fn has(&self, key: &CacheKey) -> bool {
        self.store.lock().unwrap().contains_key(key)
    }

    /// Drops results for one signal and every aggregate result that includes it.
    pub fn invalidate_signal(&self, signal: &str) {
        self.store.lock().unwrap().retain(|k, _| k.0 != signal && k.0 != ALL_SIGNALS);
    }

    pub fn invalidate_operation(&self, op: &str) {
        self.store.lock().unwrap().retain(|k, _| k.1 != op);
    }

    pub fn invalidate_all(&self) {
        self.store.lock().unwrap().clear();
    }

    pub fn size(&self) -> usize {
        self.store.lock().unwrap().len()
    }
}
