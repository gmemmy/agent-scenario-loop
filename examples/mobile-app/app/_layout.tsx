import type React from 'react';
import { Stack } from 'expo-router/stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * Defines the native navigation stack for the example Expo app.
 *
 * @returns {React.ReactElement}
 */
export default function RootLayout(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <Stack>
        <Stack.Screen
          name="index"
          options={{
            title: 'Scenario Evidence',
          }}
        />
      </Stack>
    </SafeAreaProvider>
  );
}
