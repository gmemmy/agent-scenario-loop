# Minimal App Integration

This example is intentionally documentation-only: the app integration contract is one file, `../../app/profile-session.ts`. Copy it into your app and wire it as shown below.

## Startup wiring

Call `useProfileSessionBootstrap()` once near the app root:

```tsx
import { useProfileSessionBootstrap } from '../../app/profile-session';

export function AppShell() {
  useProfileSessionBootstrap();

  return <RootNavigator />;
}
```

## Emitting truth events

Emit stable events around a real user journey:

```ts
import { emitProfileEvent, storeProfileSignal } from '../../app/profile-session';

export function onComposerOpened() {
  emitProfileEvent('composer_open_requested', {
    flowId: 'composer-open-close',
    phase: 'intent',
    owner: 'composer',
  });
}

export function onComposerVisible() {
  emitProfileEvent('composer_opened', {
    flowId: 'composer-open-close',
    phase: 'visual',
    owner: 'composer',
  });
}

export function persistQuerySnapshot(snapshot: unknown) {
  storeProfileSignal('network', 'composer-query-snapshot', snapshot, {
    flowId: 'composer-open-close',
    owner: 'composer',
  });
}
```

## Deep-link control

Deep links are the control plane: the runner starts, commands, and stops profile sessions through URLs instead of replaying raw UI input. The app should respond to URLs shaped like:

- `example-app://profile-session/start?scenario=open-close-cycle&runId=run-123`
- `example-app://profile-session/command?scenario=open-close-cycle&runId=run-123&command=activate-target:composer-open-button`
- `example-app://profile-session/stop`

## Command targets

For runner-owned flows, register stable command targets near the component that owns the behavior:

```ts
import { registerProfileCommandTargetHandler } from '../../app/profile-session';

export function wireComposerProfileTargets(openComposer: () => void) {
  return registerProfileCommandTargetHandler('composer-open-button', openComposer);
}
```

The matching scenario command is `activate-target:composer-open-button`. The target name is the portable contract; the consuming app decides how to perform the action.
