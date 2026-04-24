# Minimal App Integration

This example is intentionally documentation-only in the extraction folder.

The public v1 app contract is the file at `../../app/profile-session.ts`.

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

The runner should control the app through URLs shaped like:

- `example-app://profile-session/start?scenario=open-close-cycle&runId=run-123`
- `example-app://profile-session/command?scenario=open-close-cycle&runId=run-123&command=activate-target:composer-open-button`
- `example-app://profile-session/stop`
