# Android API-only smoke verification

Run only against an isolated **debug** APK built with `desktop/tauri.android.smoke.conf.json` and `BUWEI_NATIVE_SMOKE=1`. Its fixed loopback entry is `http://127.0.0.1:5173`; a release APK always uses the production HTTPS entry. Never enable WebView debugging or loopback entry in a distributed APK.

## Run

1. Start the existing fixture server from the integrated checkout:
   `node desktop/scripts/native-smoke-server.mjs`.
2. Install the debug APK with `D:\Android\Sdk\platform-tools\adb.exe install -r <debug.apk>`.
3. Set `BUWEI_ADB_SERIAL` if more than one device is online. Set `BUWEI_ANDROID_APP_ID` if the debug application's package differs from `cn.buwei.mobile`.
4. Run `node desktop/scripts/android-smoke.mjs`. Node 22 or newer is required for built-in WebSocket. `BUWEI_ADB_PATH` can override the existing SDK's ADB executable.

The script starts/restarts the debug Activity through ADB, reverses port 5173, discovers the native WebView DevTools socket, and evaluates documented app/bridge APIs through CDP. It sends no pointer, keyboard, accessibility, screenshot, or Computer Use actions.

The suite verifies platform capabilities, private plugin ACL, HttpOnly cookie handling, invalid protocol/path rejection, interrupted download and Range recovery, disk bytes through debug `run-as`, account isolation, WebView reload/process restart, background transfer gating, and foreground resume. It also moves the app to the Android HOME Activity through `am start`, then verifies native lifecycle pause independently blocks transport without a page visibility callback; returning to the app allows recovery. It then explicitly seeds a synthetic pending upload in this **debug application's private directory**, restarts the app, and exercises real Rust multipart transport, accepted-part reconciliation, registration conflict, pending-file cleanup protection and retry. This seed bypasses the picker and is never presented as a SAF picker test. Use `--skip-upload` to omit seeding.

Reports are written to `output/android-smoke/android-smoke-report.json` and `server-stats.json`. The fixture keeps only synthetic UUID accounts and files. A failed upload test retains its synthetic pending spool; inspect the report and explicitly discard only that test row through the bridge before repeating. The test must not run against real account data.

## Acceptance boundaries

System SAF selection/export, Android permission prompts, real production login credentials, physical-device behavior, true airplane-mode offline entry, APK coverage on other Android versions, and long-term battery use require separate acceptance. BlueStacks metrics do not represent a phone. No paid provider or production backend is exercised by this fixture suite.
