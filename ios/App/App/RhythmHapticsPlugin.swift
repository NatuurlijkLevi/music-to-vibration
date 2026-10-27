import AVFoundation
import Capacitor
import CoreHaptics

@objc(RhythmHapticsPlugin)
public class RhythmHapticsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RhythmHapticsPlugin"
    public let jsName = "RhythmHaptics"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isSupported", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise)
    ]

    private var engine: CHHapticEngine?
    private var player: CHHapticPatternPlayer?

    public override func load() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }

        do {
            try? AVAudioSession.sharedInstance().setAllowHapticsAndSystemSoundsDuringRecording(true)
            let engine = try CHHapticEngine()
            engine.isAutoShutdownEnabled = true
            engine.resetHandler = { [weak self] in
                try? self?.engine?.start()
            }
            self.engine = engine
            try engine.start()
        } catch {
            self.engine = nil
        }
    }

    @objc func isSupported(_ call: CAPPluginCall) {
        call.resolve(["supported": engine != nil])
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let engine else {
            call.unavailable("This device does not support Core Haptics.")
            return
        }

        try? AVAudioSession.sharedInstance().setAllowHapticsAndSystemSoundsDuringRecording(true)

        guard let durations = call.getArray("pattern")?.compactMap({ value -> Double? in
            if let number = value as? NSNumber {
                return number.doubleValue
            }
            return nil
        }), !durations.isEmpty else {
            call.reject("A vibration pattern is required.")
            return
        }

        var relativeTime = 0.0
        var events: [CHHapticEvent] = []

        for (index, milliseconds) in durations.prefix(15).enumerated() {
            let duration = min(max(milliseconds, 0), 1_000) / 1_000
            if index.isMultiple(of: 2), duration > 0 {
                let parameters = [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.35)
                ]
                events.append(
                    CHHapticEvent(
                        eventType: .hapticContinuous,
                        parameters: parameters,
                        relativeTime: relativeTime,
                        duration: duration
                    )
                )
            }
            relativeTime += duration
        }

        guard !events.isEmpty else {
            call.resolve()
            return
        }

        do {
            try engine.start()
            try player?.stop(atTime: CHHapticTimeImmediate)
            let hapticPattern = try CHHapticPattern(events: events, parameters: [])
            let nextPlayer = try engine.makePlayer(with: hapticPattern)
            player = nextPlayer
            try nextPlayer.start(atTime: CHHapticTimeImmediate)
            call.resolve()
        } catch {
            call.reject("The haptic pattern could not be played.", nil, error)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        do {
            try player?.stop(atTime: CHHapticTimeImmediate)
            player = nil
            call.resolve()
        } catch {
            call.reject("The haptic pattern could not be stopped.", nil, error)
        }
    }
}
