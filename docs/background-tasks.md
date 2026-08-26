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

On Android 13+, `POST_NOTIFICATIONS` controls whether ordinary notifications and the foreground-service notification appear in the notification drawer. It is not a prerequisite for starting a foreground service. When the permission is denied, Android still exposes the running service in Task Manager.

Current behavior:

- Permission requests are always initiated from visible user-facing UI.
- Starting a download can request notification permission so progress and completion notices remain visible.
- Backend benchmark/autotune can show a warning that notification-drawer progress and completion alerts are hidden.
- Background-task startup does not silently request permissions on its own.
- The app attempts to start the user-initiated foreground service while its Activity is visible regardless of notification permission or channel state, and contains actual native start failures such as Android background-start or security exceptions.

### Background-actions notification channel

The persistent foreground-service notification is posted on the `RN_BACKGROUND_ACTIONS_CHANNEL` (owned by `react-native-background-actions`). Blocking this channel hides notification-drawer UI, but does not pre-emptively disable the service; Pocket AI attempts the native start and handles the platform result.

The generated manifest currently declares the `dataSync` service type. Downloads are a direct `dataSync` use case. Local inference and autotune are disclosed as user-initiated local processing in the Google Play foreground-service declaration and must be re-reviewed whenever target SDK or Play policy changes. Android 15 applies a shared six-hour-per-24-hour timeout to the app's `dataSync` services; Pocket AI stops the service when tracked work ends and must not promise unlimited background inference.

## iOS

iOS background execution time is limited. Pocket AI uses a background task (`UIApplication.beginBackgroundTask`) through `react-native-background-actions`, which typically grants a few minutes of execution time.

The app does not declare `UIBackgroundModes=processing`: it does not register or submit `BGTaskScheduler` processing tasks. Native configuration verification rejects that unsupported declaration after prebuild.

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

