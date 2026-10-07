# Windows native loopback smoke

Use only the dedicated debug build with `BUWEI_DESKTOP_DEV_ORIGIN=1`, `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`, and `src-tauri/tauri.smoke.conf.json`. Its separate identifier is `cn.buwei.desktop.smoke`; production authentication and storage are untouched.

1. Run `node desktop/scripts/native-smoke-server.mjs`. It binds only `127.0.0.1:5173`, generates two 9 MiB fixtures and an absolute upload path in `output/desktop-smoke/fixture.json`.
2. Launch the debug native executable. The test page logs in with a dummy **HttpOnly** cookie and establishes the real Tauri bridge.
3. Run `node desktop/scripts/native-smoke.mjs --stage-upload --notifications`. When the native picker opens, paste `uploadPath` from the fixture into its filename field and select Open. This is the only required manual file-selection step.
4. Inspect `output/desktop-smoke/native-smoke-report.json`, `server-stats.json`, and `native-smoke.png`. A report without the upload flag explicitly records the untested upload boundary.

The script validates native handshake and guarded commands; a real TCP download interruption followed by nonzero Range recovery and exact cached bytes; account isolation; upload part reconciliation after an accepted part loses its response; registration conflict with retained pending gate; and native authenticated notification polling. All network requests hit the loopback fixture. It rejects arbitrary filesystem commands, extra untrusted WebView creation and traversal IDs; these establish command/ACL boundaries, while the source-origin guard itself is also covered by Rust tests.

For signed updater smoke on the same server, set `BUWEI_SMOKE_INSTALLER` to the absolute signed fixture installer, optionally `BUWEI_SMOKE_SIGNATURE`, and `BUWEI_SMOKE_UPDATE_VERSION` (default `0.1.1`). The server mounts `update-smoke-routes.mjs` before API fixtures. Run that workflow separately after the attachment smoke.

The script does not verify production APIs, Windows toast rendering/click activation, automatic restart timing, or complete process restart persistence. Its disk verification assumes the default `%LOCALAPPDATA%/cn.buwei.desktop.smoke` directory. Override `BUWEI_PLAYWRIGHT_PATH` or `BUWEI_CDP_URL` when the bundled Playwright path or CDP endpoint differs. Stop the server after testing; the control endpoints deliberately trust the loopback test runner.
