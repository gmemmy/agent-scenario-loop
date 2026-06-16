import React from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ExampleScreen } from './src/example-screen';

/**
 * Wraps the example scenario surface in native safe-area context.
 *
 * @returns {React.ReactElement}
 */
function ExampleApp(): React.ReactElement {
  return React.createElement(
    SafeAreaProvider,
    null,
    React.createElement(ExampleScreen),
  );
}

registerRootComponent(ExampleApp);
