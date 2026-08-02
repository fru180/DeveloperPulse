use rustfft::{num_complex::Complex32, Fft, FftPlanner};
use screencapturekit::cm::AudioBufferList;
use screencapturekit::error::{SCError, SCStreamErrorCode};
use screencapturekit::prelude::*;
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, State};

const DETAIL_FFT_SIZE: usize = 4096;
const TRANSIENT_FFT_SIZE: usize = 2048;
const SAMPLE_RATE: f32 = 48_000.0;
const ANALYSIS_UPDATE_INTERVAL_MS: usize = 25;
const ANALYSIS_UPDATE_SAMPLE_COUNT: usize =
    SAMPLE_RATE as usize * ANALYSIS_UPDATE_INTERVAL_MS / 1_000;
const SPECTRUM_BAND_COUNT: usize = 64;
const SPECTRUM_MIN_HZ: f32 = 40.0;
const SPECTRUM_MAX_HZ: f32 = 16_000.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisFrame {
    sequence: u64,
    captured_at_ms: u128,
    spectrum_db: Vec<f32>,
    transient_spectrum_db: Vec<f32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CaptureErrorCode {
    PermissionDenied,
    NoDisplay,
    CaptureFailed,
    AlreadyRunning,
    StateUnavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureCommandError {
    code: CaptureErrorCode,
    debug_message: String,
}

impl CaptureCommandError {
    fn new(code: CaptureErrorCode, debug_message: impl Into<String>) -> Self {
        Self {
            code,
            debug_message: debug_message.into(),
        }
    }
}

fn classify_shareable_content_error(error: SCError) -> CaptureCommandError {
    let code = match &error {
        SCError::NoShareableContent(_) | SCError::PermissionDenied(_) => {
            CaptureErrorCode::PermissionDenied
        }
        SCError::SCStreamError {
            code: SCStreamErrorCode::UserDeclined,
            ..
        } => CaptureErrorCode::PermissionDenied,
        _ => CaptureErrorCode::CaptureFailed,
    };
    CaptureCommandError::new(code, error.to_string())
}

struct CaptureSession {
    stop_tx: mpsc::Sender<()>,
    handle: thread::JoinHandle<()>,
}

#[derive(Default)]
struct CaptureState(Mutex<Option<CaptureSession>>);

struct SpectrumAnalyzer {
    samples: VecDeque<f32>,
    samples_since_emit: usize,
    sequence: u64,
    on_message: Channel<AnalysisFrame>,
    detail_transform: SpectrumTransform,
    transient_transform: SpectrumTransform,
}

impl SpectrumAnalyzer {
    fn new(on_message: Channel<AnalysisFrame>) -> Self {
        let mut planner = FftPlanner::<f32>::new();
        Self {
            samples: VecDeque::with_capacity(DETAIL_FFT_SIZE),
            samples_since_emit: ANALYSIS_UPDATE_SAMPLE_COUNT,
            sequence: 0,
            on_message,
            detail_transform: SpectrumTransform::new(DETAIL_FFT_SIZE, &mut planner),
            transient_transform: SpectrumTransform::new(TRANSIENT_FFT_SIZE, &mut planner),
        }
    }

    fn push(&mut self, samples: &[f32]) {
        for &sample in samples {
            if self.samples.len() == DETAIL_FFT_SIZE {
                self.samples.pop_front();
            }
            self.samples.push_back(sample);
        }

        if self.samples.is_empty()
            || !analysis_update_due(&mut self.samples_since_emit, samples.len())
        {
            return;
        }

        let recent_samples = self.samples.make_contiguous();
        let spectrum_db = self.detail_transform.analyze_recent(recent_samples);
        let transient_spectrum_db = self.transient_transform.analyze_recent(recent_samples);
        let captured_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = self.on_message.send(AnalysisFrame {
            sequence: self.sequence,
            captured_at_ms,
            spectrum_db,
            transient_spectrum_db,
        });
        self.sequence += 1;
    }
}

fn analysis_update_due(samples_since_emit: &mut usize, new_samples: usize) -> bool {
    *samples_since_emit = samples_since_emit.saturating_add(new_samples);
    if *samples_since_emit < ANALYSIS_UPDATE_SAMPLE_COUNT {
        return false;
    }
    *samples_since_emit %= ANALYSIS_UPDATE_SAMPLE_COUNT;
    true
}

struct AudioHandler {
    analyzer: Mutex<SpectrumAnalyzer>,
}

impl SCStreamOutputTrait for AudioHandler {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, output_type: SCStreamOutputType) {
        if output_type != SCStreamOutputType::Audio {
            return;
        }
        let Some(buffers) = sample.audio_buffer_list() else {
            return;
        };
        let mono = downmix_audio(&buffers);
        if let Ok(mut analyzer) = self.analyzer.lock() {
            analyzer.push(&mono);
        }
    }
}

fn bytes_as_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .filter(|sample| sample.is_finite())
        .collect()
}

fn downmix_audio(buffers: &AudioBufferList) -> Vec<f32> {
    if buffers.num_buffers() == 1 {
        let Some(buffer) = buffers.get(0) else {
            return Vec::new();
        };
        let channels = buffer.number_channels.max(1) as usize;
        let values = bytes_as_f32(buffer.data());
        return values
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect();
    }

    let channels: Vec<Vec<f32>> = buffers
        .iter()
        .map(|buffer| bytes_as_f32(buffer.data()))
        .collect();
    let frames = channels.iter().map(Vec::len).min().unwrap_or(0);
    (0..frames)
        .map(|index| {
            channels.iter().map(|channel| channel[index]).sum::<f32>() / channels.len() as f32
        })
        .collect()
}

struct SpectrumTransform {
    fft_size: usize,
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    spectrum: Vec<Complex32>,
    scratch: Vec<Complex32>,
    frequency_db: Vec<f32>,
}

impl SpectrumTransform {
    fn new(fft_size: usize, planner: &mut FftPlanner<f32>) -> Self {
        let fft = planner.plan_fft_forward(fft_size);
        let alpha = 0.16_f32;
        let a0 = (1.0 - alpha) / 2.0;
        let a1 = 0.5;
        let a2 = alpha / 2.0;
        let window = (0..fft_size)
            .map(|index| {
                let phase = 2.0 * std::f32::consts::PI * index as f32 / fft_size as f32;
                a0 - a1 * phase.cos() + a2 * (2.0 * phase).cos()
            })
            .collect();
        let scratch = vec![Complex32::default(); fft.get_inplace_scratch_len()];
        Self {
            fft_size,
            fft,
            window,
            spectrum: vec![Complex32::default(); fft_size],
            scratch,
            frequency_db: vec![f32::NEG_INFINITY; fft_size / 2],
        }
    }

    fn analyze_recent(&mut self, samples: &[f32]) -> Vec<f32> {
        let retained = samples.len().min(self.fft_size);
        let source_start = samples.len() - retained;
        let target_start = self.fft_size - retained;
        self.spectrum.fill(Complex32::default());
        for (target, (sample, window)) in self.spectrum[target_start..].iter_mut().zip(
            samples[source_start..]
                .iter()
                .zip(self.window[target_start..].iter()),
        ) {
            target.re = sample * window;
        }
        self.fft
            .process_with_scratch(&mut self.spectrum, &mut self.scratch);
        for (frequency_db, value) in self
            .frequency_db
            .iter_mut()
            .zip(self.spectrum[..self.fft_size / 2].iter())
        {
            let magnitude = value.norm() / self.fft_size as f32;
            *frequency_db = 20.0 * magnitude.log10();
        }
        aggregate_spectrum_data(&self.frequency_db, self.fft_size)
    }
}

fn db_power(db: f32) -> f32 {
    if !db.is_finite() || db <= -100.0 {
        0.0
    } else {
        10.0_f32.powf(db / 10.0)
    }
}

fn aggregate_spectrum_data(frequency_db: &[f32], fft_size: usize) -> Vec<f32> {
    let hz_per_bin = SAMPLE_RATE / fft_size as f32;
    let ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ;
    let mut output = vec![-100.0; SPECTRUM_BAND_COUNT];
    for (band_index, value) in output.iter_mut().enumerate() {
        let low = SPECTRUM_MIN_HZ * ratio.powf(band_index as f32 / SPECTRUM_BAND_COUNT as f32);
        let high =
            SPECTRUM_MIN_HZ * ratio.powf((band_index + 1) as f32 / SPECTRUM_BAND_COUNT as f32);
        let start = ((low / hz_per_bin - 0.5).floor() as usize).max(1);
        let end = ((high / hz_per_bin + 0.5).ceil() as usize)
            .max(start + 1)
            .min(frequency_db.len());
        if end <= start {
            continue;
        }
        let power = frequency_db[start..end]
            .iter()
            .enumerate()
            .map(|(offset, db)| {
                let index = start + offset;
                let bin_low = (index as f32 - 0.5) * hz_per_bin;
                let bin_high = (index as f32 + 0.5) * hz_per_bin;
                let overlap = (high.min(bin_high) - low.max(bin_low)).max(0.0);
                db_power(*db) * overlap / hz_per_bin
            })
            .sum::<f32>();
        if power > 0.0 {
            *value = (10.0 * power.log10()).max(-100.0);
        }
    }
    output
}

fn capture_loop(
    on_message: Channel<AnalysisFrame>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::SyncSender<Result<(), CaptureCommandError>>,
) {
    let result = (|| -> Result<(), CaptureCommandError> {
        let content = SCShareableContent::get().map_err(classify_shareable_content_error)?;
        let display = content.displays().into_iter().next().ok_or_else(|| {
            CaptureCommandError::new(
                CaptureErrorCode::NoDisplay,
                "No display is available for system audio capture.",
            )
        })?;
        let filter = SCContentFilter::create()
            .with_display(&display)
            .with_excluding_windows(&[])
            .build();
        let config = SCStreamConfiguration::new()
            .with_width(2)
            .with_height(2)
            .with_captures_audio(true)
            .with_excludes_current_process_audio(true)
            .with_sample_rate(SAMPLE_RATE as i32)
            .with_channel_count(2);
        let handler = AudioHandler {
            analyzer: Mutex::new(SpectrumAnalyzer::new(on_message.clone())),
        };
        let mut stream = SCStream::new(&filter, &config);
        stream.add_output_handler(handler, SCStreamOutputType::Audio);
        stream.start_capture().map_err(|error| {
            CaptureCommandError::new(
                CaptureErrorCode::CaptureFailed,
                format!("Could not start system audio capture: {error}"),
            )
        })?;
        let _ = ready_tx.send(Ok(()));
        let _ = stop_rx.recv();
        stream.stop_capture().map_err(|error| {
            CaptureCommandError::new(
                CaptureErrorCode::CaptureFailed,
                format!("Could not stop system audio capture: {error}"),
            )
        })?;
        Ok(())
    })();

    if let Err(message) = result {
        let _ = ready_tx.send(Err(message.clone()));
    }
}

#[tauri::command(async)]
fn start_system_audio(
    on_message: Channel<AnalysisFrame>,
    state: State<'_, CaptureState>,
) -> Result<(), CaptureCommandError> {
    let mut session = state.0.lock().map_err(|_| {
        CaptureCommandError::new(
            CaptureErrorCode::StateUnavailable,
            "Capture state is unavailable.",
        )
    })?;
    if session.is_some() {
        return Err(CaptureCommandError::new(
            CaptureErrorCode::AlreadyRunning,
            "System audio capture is already running.",
        ));
    }

    let (stop_tx, stop_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let handle = thread::spawn(move || capture_loop(on_message, stop_rx, ready_tx));
    match ready_rx.recv() {
        Ok(Ok(())) => {
            *session = Some(CaptureSession { stop_tx, handle });
            Ok(())
        }
        Ok(Err(message)) => {
            let _ = handle.join();
            Err(message)
        }
        Err(_) => {
            let _ = handle.join();
            Err(CaptureCommandError::new(
                CaptureErrorCode::CaptureFailed,
                "System audio capture stopped before it was ready.",
            ))
        }
    }
}

#[tauri::command(async)]
fn stop_system_audio(state: State<'_, CaptureState>) -> Result<(), CaptureCommandError> {
    let session = state
        .0
        .lock()
        .map_err(|_| {
            CaptureCommandError::new(
                CaptureErrorCode::StateUnavailable,
                "Capture state is unavailable.",
            )
        })?
        .take();
    if let Some(session) = session {
        let _ = session.stop_tx.send(());
        session.handle.join().map_err(|_| {
            CaptureCommandError::new(
                CaptureErrorCode::CaptureFailed,
                "The capture thread stopped unexpectedly.",
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
fn restart_app(app: AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            start_system_audio,
            stop_system_audio,
            restart_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running DeveloperPulse");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn analyze_samples(samples: &[f32], fft_size: usize) -> Vec<f32> {
        let mut planner = FftPlanner::<f32>::new();
        SpectrumTransform::new(fft_size, &mut planner).analyze_recent(samples)
    }

    #[test]
    fn classifies_shareable_content_permission_failures() {
        let errors = [
            SCError::NoShareableContent("TCC denied capture".to_string()),
            SCError::PermissionDenied("Screen Recording".to_string()),
            SCError::SCStreamError {
                code: SCStreamErrorCode::UserDeclined,
                message: None,
            },
        ];

        for error in errors {
            assert_eq!(
                classify_shareable_content_error(error).code,
                CaptureErrorCode::PermissionDenied
            );
        }
    }

    #[test]
    fn classifies_unexpected_shareable_content_failures_as_capture_failures() {
        assert_eq!(
            classify_shareable_content_error(SCError::InternalError(
                "Unexpected failure".to_string()
            ))
            .code,
            CaptureErrorCode::CaptureFailed
        );
    }

    #[test]
    fn silence_is_empty() {
        assert!(analyze_samples(&[0.0; DETAIL_FFT_SIZE], DETAIL_FFT_SIZE)
            .iter()
            .all(|value| *value <= -99.0));
    }

    #[test]
    fn sine_tone_peaks_in_expected_band() {
        let frequency = 700.0;
        let samples: Vec<f32> = (0..DETAIL_FFT_SIZE)
            .map(|index| {
                (2.0 * std::f32::consts::PI * frequency * index as f32 / SAMPLE_RATE).sin()
            })
            .collect();
        let spectrum = analyze_samples(&samples, DETAIL_FFT_SIZE);
        let peak = spectrum
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .unwrap()
            .0;
        let expected = ((frequency / SPECTRUM_MIN_HZ).ln()
            / (SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ).ln()
            * SPECTRUM_BAND_COUNT as f32)
            .floor() as usize;
        assert!(
            peak.abs_diff(expected) <= 1,
            "peak {peak}, expected {expected}"
        );
    }

    #[test]
    fn equal_sine_tones_have_similar_energy_across_the_spectrum() {
        let frequencies = [70.312_5, 703.125, 4_007.812_5, 9_984.375, 14_976.562_5];
        let levels: Vec<f32> = frequencies
            .iter()
            .map(|frequency| {
                let samples: Vec<f32> = (0..DETAIL_FFT_SIZE)
                    .map(|index| {
                        (2.0 * std::f32::consts::PI * frequency * index as f32 / SAMPLE_RATE).sin()
                    })
                    .collect();
                let spectrum = analyze_samples(&samples, DETAIL_FFT_SIZE);
                let power = spectrum
                    .into_iter()
                    .filter(|value| *value > -100.0)
                    .map(|value| 10.0_f32.powf(value / 10.0))
                    .sum::<f32>();
                10.0 * power.log10()
            })
            .collect();
        let lowest = levels.iter().copied().min_by(f32::total_cmp).unwrap();
        let highest = levels.iter().copied().max_by(f32::total_cmp).unwrap();
        assert!(
            highest - lowest < 3.0,
            "tone levels varied by {}dB: {levels:?}",
            highest - lowest
        );
    }

    #[test]
    fn matches_web_audio_blackman_window_and_fft_normalization() {
        let bin = 60;
        let frequency = bin as f32 * SAMPLE_RATE / DETAIL_FFT_SIZE as f32;
        let samples: Vec<f32> = (0..DETAIL_FFT_SIZE)
            .map(|index| {
                (2.0 * std::f32::consts::PI * frequency * index as f32 / SAMPLE_RATE).sin()
            })
            .collect();
        let mut planner = FftPlanner::<f32>::new();
        let mut transform = SpectrumTransform::new(DETAIL_FFT_SIZE, &mut planner);

        transform.analyze_recent(&samples);

        let expected_db = 20.0 * 0.21_f32.log10();
        assert!(
            (transform.frequency_db[bin] - expected_db).abs() < 0.01,
            "bin level was {}dB, expected {expected_db}dB",
            transform.frequency_db[bin]
        );
    }

    #[test]
    fn analyzes_detail_and_transient_windows_into_the_shared_band_count() {
        assert_eq!(ANALYSIS_UPDATE_INTERVAL_MS, 25);
        assert_eq!(ANALYSIS_UPDATE_SAMPLE_COUNT, 1_200);
        let samples: Vec<f32> = (0..DETAIL_FFT_SIZE)
            .map(|index| (2.0 * std::f32::consts::PI * 700.0 * index as f32 / SAMPLE_RATE).sin())
            .collect();

        assert_eq!(
            analyze_samples(&samples, DETAIL_FFT_SIZE).len(),
            SPECTRUM_BAND_COUNT
        );
        assert_eq!(
            analyze_samples(&samples, TRANSIENT_FFT_SIZE).len(),
            SPECTRUM_BAND_COUNT
        );
    }

    #[test]
    fn emits_immediately_then_carries_callback_sample_remainders() {
        let mut samples_since_emit = ANALYSIS_UPDATE_SAMPLE_COUNT;

        assert!(analysis_update_due(&mut samples_since_emit, 1_024));
        assert_eq!(samples_since_emit, 1_024);
        assert!(analysis_update_due(&mut samples_since_emit, 1_024));
        assert_eq!(samples_since_emit, 848);
        assert!(analysis_update_due(&mut samples_since_emit, 480));
        assert_eq!(samples_since_emit, 128);
        assert!(!analysis_update_due(&mut samples_since_emit, 480));
        assert_eq!(samples_since_emit, 608);
    }

    #[test]
    fn pads_missing_history_with_silence_for_the_first_analysis_updates() {
        let short_samples: Vec<f32> = (0..1_200)
            .map(|index| (2.0 * std::f32::consts::PI * 700.0 * index as f32 / SAMPLE_RATE).sin())
            .collect();
        let mut padded_samples = vec![0.0; DETAIL_FFT_SIZE - short_samples.len()];
        padded_samples.extend_from_slice(&short_samples);

        let short_spectrum = analyze_samples(&short_samples, DETAIL_FFT_SIZE);
        let padded_spectrum = analyze_samples(&padded_samples, DETAIL_FFT_SIZE);

        for (short, padded) in short_spectrum.iter().zip(padded_spectrum) {
            assert!((short - padded).abs() < 0.0001);
        }
    }
}
