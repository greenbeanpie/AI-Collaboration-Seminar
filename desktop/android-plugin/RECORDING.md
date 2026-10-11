# Android native recording

The internal Rust-only adapter exposes recordingCapabilities, recordingStart,
recordingAction, recordingList, recordingExport and recordingRemove. Public
commands continue to validate the main window, origin, account and project in
Rust. Kotlin revalidates the private root and account/session identifiers.

Start receives root, id, accountId, projectId, kind (audio/video/photo), optional
inputDeviceId and cameraDeviceId. Rust injects the current account epoch. The
root must resolve to the app data directory's recordings folder. Files reside
at root/accountId/id/segment-N.m4a, mp4 or jpg; manifest.json is an AtomicFile.
createdAt is ISO UTC, sequence starts at one, times are monotonic milliseconds
relative to session start. Pauses remain explicit timeline interruptions.
Tauri's Android PathPlugin getDataDir returns activity.dataDir, matching the
strict private-root check (it does not return filesDir).

AudioRecord feeds a persistent AAC MediaCodec. Camera2 feeds an AVC encoder
surface. MediaMuxer rotates at AVC keyframes, requested before 5 minutes or
32 MiB. Each finished muxer is independently playable. A late keyframe causes
a stop with a preserved segment rather than an oversized upload. Encoding and
muxing run on one worker; initialization buffers are bounded to 2 MiB.
Camera REALTIME timestamps share elapsedRealtime. UNKNOWN timestamp clocks are
aligned once at first encoder output; this includes encoder latency and must be
checked for A/V offset and long-run drift on physical devices. A camera stall
over 15 seconds stops recording. Finalized files must remain at most 32 MiB.

Only a visible activity can acquire permissions and launch the non-sticky
foreground service. A stop notification and partial wake lock support
background/lock recording. Account epoch changes stop capture. No boot receiver
or automatic capture restart is present. Removing the activity does not destroy
the service. Pause releases active microphone capture and stops camera requests;
resume may switch selected devices. Unsupported codecs/devices return errors.

Recovery keeps completed files, validates any finalized orphan with
MediaExtractor, lists .partial tails for explicit export, and marks an interrupted
session instead of restarting it. Export uses SAF, streams files, and cancels on
identity change. Only explicit remove deletes a stopped draft.

Verification: SDK 37/JBR 25 Gradle compileX86_64DebugKotlin and
compileX86_64DebugAndroidTestKotlin passed. FixtureInstrumentation operation
recording-store checks path/account isolation, SHA-256, recovery and tail retention.
No ADB device was connected during implementation: the fixture is compiled but
not executed. Camera/microphone capture, lock/background continuity, codec timing,
force-kill recovery and 4-hour runs require device acceptance. Existing AGP legacy
DSL and generated Wry deprecation warnings remain upstream.

Primary platform references:
- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://developer.android.com/reference/android/media/MediaMuxer
