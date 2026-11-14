# OpenClaw Schedule Wake

Schedule a message for an existing OpenClaw session, without using a model to run the scheduler. The target session's resulting turn can still consume model quota.

Plugin ID: `session-wakes`. Native UI: **Session Wakes**.

## Features

- Choose a session, a local delivery time, and a message (default: `继续`).
- Leave the time empty for delivery on the next scheduler check.
- Inspect pending, delivered, and failed tasks; delete queued records.
- Right-click a session and choose **唤醒设置** to open its scoped settings; **查看全部会话** restores the global queue.
- Dark/light styles, responsive layout, explicit loading/error states and safe text rendering.

## Install

Use a compatible OpenClaw host with native custom-plugin UI support:

This zero-dependency plugin installs directly from Git; no build or lifecycle scripts are required:

```sh
openclaw plugins install 'git:github.com/gsmainagent/openclaw-schedule-wake@main' --accept-capabilities
```

The backend entry is the authored root index.js. The only authoritative browser sources live in dist/control-ui/source/ because the native UI contract requires a dedicated dist subdirectory. Those are plain hand-authored JavaScript/CSS, not generated duplicates or bundled artifacts. The build command only checks syntax. Pin a full commit instead of main when reproducibility is required.

Review the plugin before accepting its `page`, `navigation`, and `action` UI capabilities. Native UI requires the host's Custom plugin UI setting and an authenticated HTTPS or trusted-loopback Control UI. Installation support depends on the host's installer; this repository is not an official-catalog or ClawHub package.

Reload the Control UI after activation. The session-menu action only navigates; opening settings never creates or deletes a wake. Native menu registration and navigation follow the host SDK rather than patching the host DOM.

## Build and test

There are no build dependencies:

```sh
npm run build
npm test
```

Browser regression tests use an isolated synthetic host, not real conversations or a real Gateway:

```sh
PLAYWRIGHT_MODULE_PATH=/YOUR-PLAYWRIGHT-ENTRY-HERE CHROME_BIN=/YOUR-CHROME-BINARY-HERE SW_UI_ARTIFACT_DIR=/YOUR-ARTIFACT-DIRECTORY-HERE npm run ui:test
```

Supply an installed `playwright-core` module and a compatible Chrome executable. Put artifacts outside this source directory. The tests exercise computed styles, dark/light and narrow layouts, queue interactions, navigation targeting and disposal. They are not proof of real-host menu interaction.

`npm pack` builds an allowlisted archive. It excludes lab configuration, credentials, real test records, local state, dependencies and screenshots. Only the authored UI source files are tracked under dist/control-ui/source/; other generated outputs are ignored.

## Runtime and permissions

- Backend methods: `sessionwakes.wakes.list` (`operator.read`), `sessionwakes.wakes.create` and `.delete` (`operator.write`).
- State defaults to the current user's OpenClaw state directory under `session-wakes/wakes.json`. Override `OPENCLAW_WAKES_FILE` to choose a separate state file.
- The injector resolves the installed OpenClaw CLI; `OPENCLAW_DIST_INDEX` can override its entry module. Do not point it at an untrusted program.
- Checks run every 10 seconds, with at most three delivery attempts. Past timestamps become due on the next check; timing is not exact to the second.
- Failed or ambiguous CLI replies may be retried. Delivery is not guaranteed exactly-once; do not use this plugin for irreversible commands.
- Deleting a record cannot retract a message whose delivery is already in flight. Malformed state is surfaced rather than overwritten with an empty queue.
- The service clears its timer on stop/abort. Runtime state stays outside the plugin package and must not be checked into Git.

The backend uses the raw plugin-entry contract. The build deliberately does not claim to pass the separate native tool/feature-authoring metadata builder.

## License

No open-source license has been granted (`UNLICENSED`). Public repository visibility does not grant additional reuse rights.
