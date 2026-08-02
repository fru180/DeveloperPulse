use rustfft::{num_complex::Complex32, FftPlanner};
use screencapturekit::cm::AudioBufferList;
use screencapturekit::error::{SCError, SCStreamErrorCode};
use screencapturekit::prelude::*;
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, AppHandle, State};

const FFT_SIZE: usize = 4096;
const SAMPLE_RATE: f32 = 48_000.0;
const SPECTRUM_BAND_COUNT: usize = 64;
const SPECTRUM_MIN_HZ: f32 = 40.0;
const SPECTRUM_MAX_HZ: f32 = 16_000.0;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisFrame {
    sequence: u64,
    captured_at_ms: u128,
    spectrum_db: Vec<f32>,
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
    last_emit: Instant,
    sequence: u64,
    on_message: Channel<AnalysisFrame>,
}

impl SpectrumAnalyzer {
    fn new(on_message: Channel<AnalysisFrame>) -> Self {
        Self {
            samples: VecDeque::with_capacity(FFT_SIZE),
            last_emit: Instant::now(),
            sequence: 0,
            on_message,
        }
    }

    fn push(&mut self, samples: &[f32]) {
        for &sample in samples {
            if self.samples.len() == FFT_SIZE {
                self.samples.pop_front();
            }
            self.samples.push_back(sample);
        }

        if self.samples.len() < FFT_SIZE || self.last_emit.elapsed() < Duration::from_millis(50) {
            return;
        }

        let spectrum_db = analyze_samples(self.samples.make_contiguous());
        let captured_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let _ = self.on_message.send(AnalysisFrame {
            sequence: self.sequence,
            captured_at_ms,
            spectrum_db,
        });
        self.sequence += 1;
        self.last_emit = Instant::now();
    }
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

fn analyze_samples(samples: &[f32]) -> Vec<f32> {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut spectrum: Vec<Complex32> = samples
        .iter()
        .enumerate()
        .map(|(index, sample)| {
            let window = 0.5
                - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / (FFT_SIZE - 1) as f32).cos();
            Complex32::new(sample * window, 0.0)
        })
        .collect();
    fft.process(&mut spectrum);

    let hz_per_bin = SAMPLE_RATE / FFT_SIZE as f32;
    let ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ;
    let mut output = vec![-100.0; SPECTRUM_BAND_COUNT];
    for (band_index, value) in output.iter_mut().enumerate() {
        let low = SPECTRUM_MIN_HZ * ratio.powf(band_index as f32 / SPECTRUM_BAND_COUNT as f32);
        let high =
            SPECTRUM_MIN_HZ * ratio.powf((band_index + 1) as f32 / SPECTRUM_BAND_COUNT as f32);
        let start = ((low / hz_per_bin - 0.5).floor() as usize).max(1);
        let end = ((high / hz_per_bin + 0.5).ceil() as usize)
            .max(start + 1)
            .min(spectrum.len() / 2);
        if end <= start {
            continue;
        }
        let power = spectrum[start..end]
            .iter()
            .enumerate()
            .map(|(offset, value)| {
                let index = start + offset;
                let bin_low = (index as f32 - 0.5) * hz_per_bin;
                let bin_high = (index as f32 + 0.5) * hz_per_bin;
                let overlap = (high.min(bin_high) - low.max(bin_low)).max(0.0);
                let amplitude = (2.0 * value.norm() / FFT_SIZE as f32).max(1e-10);
                amplitude * amplitude * overlap / hz_per_bin
            })
            .sum::<f32>();
        *value = (10.0 * power.max(1e-10).log10()).max(-100.0);
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
        assert!(analyze_samples(&[0.0; FFT_SIZE])
            .iter()
            .all(|value| *value <= -99.0));
    }

    #[test]
    fn sine_tone_peaks_in_expected_band() {
        let frequency = 700.0;
        let samples: Vec<f32> = (0..FFT_SIZE)
            .map(|index| {
                (2.0 * std::f32::consts::PI * frequency * index as f32 / SAMPLE_RATE).sin()
            })
            .collect();
        let spectrum = analyze_samples(&samples);
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
                let samples: Vec<f32> = (0..FFT_SIZE)
                    .map(|index| {
                        (2.0 * std::f32::consts::PI * frequency * index as f32 / SAMPLE_RATE).sin()
                    })
                    .collect();
                let spectrum = analyze_samples(&samples);
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
}
