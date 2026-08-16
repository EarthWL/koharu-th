use koharu_ml::{HardwareBackend, detect_best_backend, dml_is_available};

#[test]
fn test_dml_availability_logic() {
    let available = dml_is_available();
    println!("DirectML availability: {}", available);

    // On non-Windows platforms, DirectML must always be unavailable.
    if !cfg!(target_os = "windows") {
        assert!(!available, "DirectML should only be available on Windows");
    }
}

#[test]
fn test_detect_best_backend_selection() {
    let best = detect_best_backend();
    println!("Best detected hardware backend: {:?}", best);

    // If DirectML is available, the picked backend must be either CUDA or DirectML (never CPU unless none is found).
    if dml_is_available() && !koharu_ml::cuda_is_available() {
        assert_eq!(
            best,
            HardwareBackend::DirectMl(0),
            "DirectML should be selected when CUDA is unavailable but DirectML is available"
        );
    }
}
