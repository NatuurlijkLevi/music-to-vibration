import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { playVibration, stopVibration, vibrationSupported } from "./haptics";
import defaultTrackAsset from "./assets/beethoven-symphony-no9.mp3";

type Mode = "upload" | "live";
type TrackDetails = { title: string; artist: string };

const waveformAsset = "/assets/e06ad.svg";
const defaultTrack: TrackDetails = {
  title: "Symphony no9 - Movement 1",
  artist: "Beethoven",
};

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function createRhythmDetector(binCount: number) {
  const previous = new Uint8Array(binCount);
  let fastEnergy = 0;
  let slowEnergy = 0;
  let fluxAverage = 0;
  let lastBeat = -Infinity;
  let lastSwell = -Infinity;
  let lastVibration = -Infinity;
  let initialized = false;

  return (frequencies: Uint8Array, time: number) => {
    let bassTotal = 0;
    let midTotal = 0;
    let positiveFlux = 0;
    const bassEnd = Math.min(14, frequencies.length - 1);
    const midEnd = Math.min(64, frequencies.length);

    for (let index = 1; index <= bassEnd; index += 1) {
      bassTotal += frequencies[index];
      positiveFlux += Math.max(0, frequencies[index] - previous[index]) * 1.35;
    }
    for (let index = bassEnd + 1; index < midEnd; index += 1) {
      midTotal += frequencies[index];
      positiveFlux += Math.max(0, frequencies[index] - previous[index]) * 0.45;
    }

    const bassEnergy = bassTotal / bassEnd;
    const midEnergy = midTotal / Math.max(1, midEnd - bassEnd - 1);
    const energy = bassEnergy * 0.78 + midEnergy * 0.22;
    const flux = positiveFlux / Math.max(1, midEnd - 1);

    if (!initialized) {
      fastEnergy = energy;
      slowEnergy = energy;
      fluxAverage = flux;
      initialized = true;
      previous.set(frequencies);
      return 0;
    }

    const previousFastEnergy = fastEnergy;
    const isOnset =
      time - lastBeat >= 145 &&
      energy > 8 &&
      flux > Math.max(1.3, Math.min(10, fluxAverage * 1.2));

    fastEnergy = fastEnergy * 0.76 + energy * 0.24;
    slowEnergy = slowEnergy * 0.992 + energy * 0.008;
    fluxAverage = fluxAverage * 0.9 + flux * 0.1;
    previous.set(frequencies);

    const intensityRatio = fastEnergy / Math.max(8, slowEnergy);
    const isSwell =
      time - lastSwell >= 700 &&
      energy > 18 &&
      intensityRatio > 1.16 &&
      fastEnergy > previousFastEnergy * 1.01;
    const isLoudRhythm =
      time - lastVibration >= 340 &&
      fastEnergy > 48 &&
      (fastEnergy > previousFastEnergy * 1.005 || flux > fluxAverage * 0.75);

    if (isOnset) {
      lastBeat = time;
      lastVibration = time;
      const intensityBoost = Math.max(0, Math.min(24, (intensityRatio - 1) * 55));
      const absoluteBoost = Math.max(0, Math.min(32, (energy - 28) * 0.32));
      const beatPulse = Math.round(
        Math.min(140, Math.max(55, 48 + flux * 2.2 + intensityBoost + absoluteBoost)),
      );

      if (isSwell) {
        lastSwell = time;
        return [beatPulse, 42, Math.min(150, beatPulse + 24)];
      }
      return beatPulse;
    }

    if (isSwell) {
      lastSwell = time;
      lastVibration = time;
      return [82, 45, Math.round(Math.min(145, 108 + (intensityRatio - 1) * 60))];
    }

    if (isLoudRhythm) {
      lastVibration = time;
      return Math.round(Math.min(130, 78 + (fastEnergy - 48) * 0.65));
    }

    return 0;
  };
}

function readSyncSafe(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] << 21) |
    (bytes[offset + 1] << 14) |
    (bytes[offset + 2] << 7) |
    bytes[offset + 3]
  );
}

function decodeId3Text(bytes: Uint8Array) {
  const encoding = bytes[0];
  let content = bytes.subarray(1);
  let charset = "iso-8859-1";

  if (encoding === 3) charset = "utf-8";
  if (encoding === 2) charset = "utf-16be";
  if (encoding === 1) {
    if (content[0] === 0xff && content[1] === 0xfe) {
      charset = "utf-16le";
      content = content.subarray(2);
    } else if (content[0] === 0xfe && content[1] === 0xff) {
      charset = "utf-16be";
      content = content.subarray(2);
    } else {
      charset = "utf-16le";
    }
  }

  return new TextDecoder(charset).decode(content).replace(/\0/g, "").trim();
}

async function readId3(file: File): Promise<Partial<TrackDetails>> {
  const bytes = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
  const details: Partial<TrackDetails> = {};

  if (String.fromCharCode(...bytes.subarray(0, 3)) === "ID3") {
    const version = bytes[3];
    const tagEnd = Math.min(bytes.length, 10 + readSyncSafe(bytes, 6));
    let offset = 10;

    while (offset + 10 <= tagEnd) {
      const frameId = String.fromCharCode(...bytes.subarray(offset, offset + 4));
      if (!frameId.trim()) break;
      const frameSize =
        version === 4
          ? readSyncSafe(bytes, offset + 4)
          : new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0);
      if (frameSize <= 0 || offset + 10 + frameSize > tagEnd) break;

      const frame = bytes.subarray(offset + 10, offset + 10 + frameSize);
      if (frameId === "TIT2") details.title = decodeId3Text(frame);
      if (frameId === "TPE1") details.artist = decodeId3Text(frame);
      offset += 10 + frameSize;
    }
  }

  if (!details.title || !details.artist) {
    const tail = new Uint8Array(await file.slice(-128).arrayBuffer());
    if (String.fromCharCode(...tail.subarray(0, 3)) === "TAG") {
      const decoder = new TextDecoder("iso-8859-1");
      details.title ||= decoder.decode(tail.subarray(3, 33)).replace(/\0/g, "").trim();
      details.artist ||= decoder.decode(tail.subarray(33, 63)).replace(/\0/g, "").trim();
    }
  }

  return details;
}

export default function App() {
  const [mode, setMode] = useState<Mode>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [message, setMessage] = useState("");
  const [track, setTrack] = useState<TrackDetails>(defaultTrack);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackCleanupRef = useRef<(() => void) | null>(null);
  const liveCleanupRef = useRef<(() => void) | null>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const defaultPreloadRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      playbackCleanupRef.current?.();
      liveCleanupRef.current?.();
      stopVibration();
    };
  }, []);

  useEffect(() => {
    const preload = new Audio();
    preload.preload = "auto";
    preload.src = defaultTrackAsset;
    preload.oncanplay = () => setMessage("Beethoven track ready");
    preload.onerror = () => setMessage("The Beethoven track could not be loaded.");
    defaultPreloadRef.current = preload;
    setMessage("Loading Beethoven track...");
    preload.load();

    return () => {
      preload.removeAttribute("src");
      preload.load();
      defaultPreloadRef.current = null;
    };
  }, []);

  const chooseFile = async (selectedFile?: File) => {
    if (!selectedFile) return;
    if (
      selectedFile.type &&
      !selectedFile.type.startsWith("audio/") &&
      !selectedFile.name.toLowerCase().endsWith(".mp3")
    ) {
      setMessage("Please choose an audio file.");
      return;
    }

    playbackCleanupRef.current?.();
    setCurrentTime(0);
    setDuration(0);
    const fallbackTitle = selectedFile.name.replace(/\.[^.]+$/, "");
    setFile(selectedFile);
    setTrack({ title: fallbackTitle, artist: "Unknown artist" });
    setMessage("Reading track details...");

    try {
      const metadata = await readId3(selectedFile);
      setTrack({
        title: metadata.title || fallbackTitle,
        artist: metadata.artist || "Unknown artist",
      });
      setMessage(metadata.title || metadata.artist ? "Track details found" : "Ready to feel");
    } catch {
      setMessage("Ready to feel");
    }
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    void chooseFile(event.target.files?.[0]);
  };

  const handleDrop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void chooseFile(event.dataTransfer.files[0]);
  };

  const vibrateFile = async () => {
    if (!(await vibrationSupported())) {
      setMessage("Vibration is not available. On iPhone, use the Feel the Sound app.");
      return;
    }

    try {
      if (audioRef.current?.paused && audioRef.current.currentTime < audioRef.current.duration) {
        await audioRef.current.play();
        setIsPlaying(true);
        setMessage("Playing the rhythm as vibration");
        return;
      }

      playbackCleanupRef.current?.();
      const context = new AudioContext();
      const objectUrl = file ? URL.createObjectURL(file) : null;
      const audio = new Audio(objectUrl ?? defaultTrackAsset);
      audio.preload = "auto";
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      analyser.connect(context.destination);
      const frequencies = new Uint8Array(analyser.frequencyBinCount);
      const detectRhythm = createRhythmDetector(frequencies.length);
      let animationFrame = 0;
      let lastProgressUpdate = 0;

      const cleanup = () => {
        cancelAnimationFrame(animationFrame);
        audio.pause();
        stopVibration();
        void context.close();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        audioRef.current = null;
        playbackCleanupRef.current = null;
        setIsPlaying(false);
      };

      const analyzePlayback = (time: number) => {
        if (!audio.paused) {
          analyser.getByteFrequencyData(frequencies);
          const vibrationPattern = detectRhythm(frequencies, time);
          if (vibrationPattern) playVibration(vibrationPattern);
        }

        if (time - lastProgressUpdate >= 150) {
          setCurrentTime(audio.currentTime);
          lastProgressUpdate = time;
        }
        animationFrame = requestAnimationFrame(analyzePlayback);
      };

      audioRef.current = audio;
      playbackCleanupRef.current = cleanup;
      audio.onloadedmetadata = () => setDuration(audio.duration);
      audio.onended = () => {
        setCurrentTime(audio.duration);
        setMessage("Playback finished");
        cleanup();
      };
      await context.resume();
      setIsPlaying(true);
      setMessage("Playing the rhythm as vibration");
      animationFrame = requestAnimationFrame(analyzePlayback);
      await audio.play();
    } catch {
      playbackCleanupRef.current?.();
      setIsPlaying(false);
      setMessage("This audio file could not be played.");
    }
  };

  const stopFile = () => {
    audioRef.current?.pause();
    stopVibration();
    setIsPlaying(false);
    setMessage("Playback paused");
  };

  const seekPlayback = (time: number) => {
    if (audioRef.current) audioRef.current.currentTime = time;
    setCurrentTime(time);
    stopVibration();
  };

  const startListening = async () => {
    if (isListening) {
      liveCleanupRef.current?.();
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage("Microphone access is not supported by this browser.");
      return;
    }

    if (!(await vibrationSupported())) {
      setMessage("Vibration is not available. On iPhone, use the Feel the Sound app.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);
      const levels = new Uint8Array(analyser.frequencyBinCount);
      const detectRhythm = createRhythmDetector(levels.length);
      let animationFrame = 0;

      const listen = (time: number) => {
        analyser.getByteFrequencyData(levels);
        const waveform = waveformRef.current;
        const bandSize = Math.floor(levels.length / 7);
        const bands = Array.from({ length: 7 }, (_, band) => {
          const start = band * bandSize;
          let total = 0;
          for (let index = start; index < start + bandSize; index += 1) {
            total += levels[index];
          }
          return total / bandSize / 255;
        });

        bands.forEach((level, index) => {
          waveform?.style.setProperty(`--band-${index}`, String(level));
        });

        const vibrationPattern = detectRhythm(levels, time);
        if (vibrationPattern) playVibration(vibrationPattern);
        animationFrame = requestAnimationFrame(listen);
      };

      const cleanup = () => {
        cancelAnimationFrame(animationFrame);
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        stopVibration();
        setIsListening(false);
        setMessage("Live listening stopped");
        liveCleanupRef.current = null;
      };

      liveCleanupRef.current = cleanup;
      setIsListening(true);
      setMessage("Listening to your surroundings");
      animationFrame = requestAnimationFrame(listen);
    } catch {
      setMessage("Microphone access is needed for live listening.");
    }
  };

  const changeMode = (nextMode: Mode) => {
    if (nextMode === mode) return;
    playbackCleanupRef.current?.();
    liveCleanupRef.current?.();
    stopVibration();
    setIsPlaying(false);
    setMessage("");
    setMode(nextMode);
  };

  return (
    <main className="app-shell">
      <nav className="mode-switcher" aria-label="Choose sound input">
        <button
          className={mode === "upload" ? "active" : ""}
          onClick={() => changeMode("upload")}
          type="button"
        >
          Audio Upload
        </button>
        <button
          className={mode === "live" ? "active" : ""}
          onClick={() => changeMode("live")}
          type="button"
        >
          Live Listening
        </button>
      </nav>

      {mode === "upload" ? (
        <section className="screen-content upload-screen">
          <header className="track-heading">
            <h1>{track.title}</h1>
            <p>{track.artist}</p>
          </header>

          <div className="file-controls">
            <button
              className={`drop-zone${isDragging ? " dragging" : ""}`}
              onClick={() => inputRef.current?.click()}
              onDragEnter={() => setIsDragging(true)}
              onDragLeave={() => setIsDragging(false)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
              type="button"
            >
              <span>{file ? file.name : "Beethoven track loaded"}</span>
              <small>or</small>
              <span>{file ? "Choose a different file" : "Choose your own audio file"}</span>
            </button>
          </div>
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept="audio/*"
            onChange={handleInput}
          />

          <div className="playback-controls">
            <div className="player-progress">
              <input
                aria-label="Song position"
                type="range"
                min="0"
                max={duration || 0}
                step="0.1"
                value={Math.min(currentTime, duration || 0)}
                disabled={!duration}
                onChange={(event) => seekPlayback(Number(event.target.value))}
              />
              <div className="player-times">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>
            </div>
            <button
              className="primary-button"
              onClick={isPlaying ? stopFile : vibrateFile}
              type="button"
            >
              {isPlaying
                ? "Pause vibration"
                : currentTime > 0 && currentTime < duration
                  ? "Continue vibration"
                  : "Vibrate the sound!"}
            </button>
          </div>
        </section>
      ) : (
        <section className="screen-content live-screen">
          {isListening ? (
            <div ref={waveformRef} className="live-waveform" aria-hidden="true">
              {Array.from({ length: 7 }, (_, index) => (
                <span key={index} />
              ))}
            </div>
          ) : (
            <img className="waveform" src={waveformAsset} alt="" />
          )}
          <button className="primary-button" onClick={startListening} type="button">
            {isListening ? "Stop Listening" : "Start Listening"}
          </button>
        </section>
      )}

      <p className="status-message" role="status" aria-live="polite">
        {message}
      </p>
    </main>
  );
}
