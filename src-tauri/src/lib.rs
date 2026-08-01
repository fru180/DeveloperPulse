use rustfft::{num_complex::Complex32, FftPlanner};
use screencapturekit::cm::AudioBufferList;
use screencapturekit::prelude::*;
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::Channel, State};

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
        let Some(buffer) = buffers.get(0) else { return Vec::new() };
        let channels = buffer.number_channels.max(1) as usize;
        let values = bytes_as_f32(buffer.data());
        return values
            .chunks(channels)
            .map(|frame| frame.iter().sum::<f32>() / frame.len() as f32)
            .collect();
    }

    let channels: Vec<Vec<f32>> = buffers.iter().map(|buffer| bytes_as_f32(buffer.data())).collect();
    let frames = channels.iter().map(Vec::len).min().unwrap_or(0);
    (0..frames)
        .map(|index| channels.iter().map(|channel| channel[index]).sum::<f32>() / channels.len() as f32)
        .collect()
}

fn analyze_samples(samples: &[f32]) -> Vec<f32> {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut spectrum: Vec<Complex32> = samples
        .iter()
        .enumerate()
        .map(|(index, sample)| {
            let window = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * index as f32 / (FFT_SIZE - 1) as f32).cos();
            Complex32::new(sample * window, 0.0)
        })
        .collect();
    fft.process(&mut spectrum);

    let hz_per_bin = SAMPLE_RATE / FFT_SIZE as f32;
    let ratio = SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ;
    let mut output = vec![-100.0; SPECTRUM_BAND_COUNT];
    for (band_index, value) in output.iter_mut().enumerate() {
        let low = SPECTRUM_MIN_HZ * ratio.powf(band_index as f32 / SPECTRUM_BAND_COUNT as f32);
        let high = SPECTRUM_MIN_HZ * ratio.powf((band_index + 1) as f32 / SPECTRUM_BAND_COUNT as f32);
        let start = ((low / hz_per_bin).floor() as usize).max(1);
        let end = ((high / hz_per_bin).ceil() as usize)
            .max(start + 1)
            .min(spectrum.len() / 2);
        if end <= start {
            continue;
        }
        let power = spectrum[start..end]
            .iter()
            .map(|value| {
                let amplitude = (2.0 * value.norm() / FFT_SIZE as f32).max(1e-10);
                amplitude * amplitude
            })
            .sum::<f32>()
            / (end - start) as f32;
        *value = (10.0 * power.max(1e-10).log10()).max(-100.0);
    }
    output
}

fn capture_loop(
    on_message: Channel<AnalysisFrame>,
    stop_rx: mpsc::Receiver<()>,
    ready_tx: mpsc::SyncSender<Result<(), String>>,
) {
    let result = (|| -> Result<(), String> {
        let content = SCShareableContent::get().map_err(|error| {
            format!("Screen & System Audio Recording permission is required: {error}")
        })?;
        let display = content
            .displays()
            .into_iter()
            .next()
            .ok_or_else(|| "No display is available for system audio capture.".to_string())?;
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
        stream.start_capture().map_err(|error| format!("Could not start system audio capture: {error}"))?;
        let _ = ready_tx.send(Ok(()));
        let _ = stop_rx.recv();
        stream.stop_capture().map_err(|error| format!("Could not stop system audio capture: {error}"))?;
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
) -> Result<(), String> {
    let mut session = state.0.lock().map_err(|_| "Capture state is unavailable.".to_string())?;
    if session.is_some() {
        return Err("System audio capture is already running.".to_string());
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
            Err("System audio capture stopped before it was ready.".to_string())
        }
    }
}

#[tauri::command(async)]
fn stop_system_audio(state: State<'_, CaptureState>) -> Result<(), String> {
    let session = state.0.lock().map_err(|_| "Capture state is unavailable.".to_string())?.take();
    if let Some(session) = session {
        let _ = session.stop_tx.send(());
        session.handle.join().map_err(|_| "The capture thread stopped unexpectedly.".to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![start_system_audio, stop_system_audio])
        .run(tauri::generate_context!())
        .expect("error while running DeveloperPulse");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_empty() {
        assert!(analyze_samples(&[0.0; FFT_SIZE]).iter().all(|value| *value <= -99.0));
    }

    #[test]
    fn sine_tone_peaks_in_expected_band() {
        let frequency = 700.0;
        let samples: Vec<f32> = (0..FFT_SIZE)
            .map(|index| (2.0 * std::f32::consts::PI * frequency * index as f32 / SAMPLE_RATE).sin())
            .collect();
        let spectrum = analyze_samples(&samples);
        let peak = spectrum.iter().enumerate().max_by(|a, b| a.1.total_cmp(b.1)).unwrap().0;
        let expected = ((frequency / SPECTRUM_MIN_HZ).ln()
            / (SPECTRUM_MAX_HZ / SPECTRUM_MIN_HZ).ln()
            * SPECTRUM_BAND_COUNT as f32)
            .floor() as usize;
        assert!(peak.abs_diff(expected) <= 1, "peak {peak}, expected {expected}");
    }
}
