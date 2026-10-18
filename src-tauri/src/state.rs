//! Application state shared by all Tauri commands.

use std::sync::atomic::AtomicBool;
use std::sync::{Mutex, RwLock};

use crate::core::cache::CacheManager;
use crate::core::compare::CompareManager;
use crate::core::correlation::CorrelationResult;
use crate::core::dataset::Dataset;
use crate::core::models::{ModelLibrary, StateSpaceResult};
use crate::core::simulation::SimulationResult;
use crate::core::validation::ValidationResult;

#[derive(Default)]
pub struct AppState {
    /// Variables imported from files (the analysis dataset is built from these).
    pub workspace: Mutex<crate::core::workspace::Workspace>,
    pub data: RwLock<Option<Dataset>>,
    pub cache: CacheManager,
    pub models: Mutex<ModelLibrary>,
    pub compare: Mutex<CompareManager>,
    /// Last correlation result computed in the Correlations tab (including lag analysis).
    pub correlation: Mutex<Option<CorrelationResult>>,
    /// Simulation runs shown in the Simulation tab: (model name, result).
    pub simulations: Mutex<Vec<(String, SimulationResult)>>,
    /// Last validation run: (model name, result).
    pub validation: Mutex<Option<(String, ValidationResult)>>,
    /// Results of the last System ID run (sorted by mean VAF).
    pub sysid_results: Mutex<Vec<StateSpaceResult>>,
    pub sysid_cancel: AtomicBool,
}
