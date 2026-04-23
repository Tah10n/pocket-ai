# Background Tasks & Notifications

Pocket AI supports long-running model downloads and on-device generation while the app is backgrounded. The implementation is intentionally conservative because Android and iOS have strict background-execution rules.

## Android

### Foreground service

On Android, Pocket AI relies on a foreground service (via `react-native-background-actions`) to keep the app process alive for:

- large model downloads (often multiple GB)
- longer on-device inference runs
- backend benchmark/autotune runs that temporarily reuse the inference background task

The service shows a persistent notification while work is active.

### Notification permission (Android 13+)

On Android 13+, starting a foreground-service notification requires the user to allow notifications (`POST_NOTIFICATIONS`). If notifications are denied or blocked, Pocket AI must not attempt to start the service because it can crash.

Current behavior:

- Permission requests are always initiated from visible user-facing UI.
- Starting a download can request notification permission before Pocket AI relies on the download foreground service.
- Backend benchmark/autotune can also show a warning dialog that lets the user enable notifications or open system settings before continuing background inference.
- Background-task startup does not silently request permissions on its own.
- If notifications are not allowed, downloads, inference, and autotune can still run in the foreground, but background execution is best-effort and may pause/stop when the app backgrounds.

### Background-actions notification channel

The persistent foreground-service notification is posted on the `RN_BACKGROUND_ACTIONS_CHANNEL` (owned by `react-native-background-actions`). If a user blocks this channel, starting the foreground service can crash, so Pocket AI refuses to start it until the channel is unblocked.

## iOS

iOS background execution time is limited. Pocket AI uses a background task (`UIApplication.beginBackgroundTask`) through `react-native-background-actions`, which typically grants a few minutes of execution time.

Expected behavior:

- downloads can pause and resume via existing `resumeData` support
- inference can be interrupted; partial output is preserved and the thread is marked as stopped

## Tap behavior

- Download notifications open the `Models` tab.
- Inference notifications open the `Chat` tab and re-select the relevant thread when possible.

## Code map

- `src/services/BackgroundTaskService.ts`: background-actions lifecycle and active task tracking
- `src/services/NotificationService.ts`: permission gating, local notifications, and navigation on tap
- `src/services/ModelDownloadManager.ts`: download lifecycle, network-aware pausing, and progress updates
- `src/hooks/useChatSession.ts`: inference lifecycle and interruption handling
- `src/hooks/useModelParametersSheetController.ts`: backend autotune flow, notification warning, and recovery actions

