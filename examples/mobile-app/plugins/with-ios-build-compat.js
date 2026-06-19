const fs = require('node:fs');
const path = require('node:path');

const sceneDelegateContents = `import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else {
      return
    }

    let window = UIWindow(windowScene: windowScene)
    self.window = window

    if let appDelegate = UIApplication.shared.delegate as? AppDelegate {
      appDelegate.window = window
      appDelegate.startReactNative(in: window)
    }
  }
}
`;

const deploymentTargetPatch = `
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = podfile_properties['ios.deploymentTarget'] || '16.4'
      end
    end
`;

const reactNativeFactorySetup = `    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory`;

const prepareReactNativeFactoryFunction = `  func prepareReactNativeFactory() {
    if reactNativeFactory != nil {
      return
    }

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
  }`;

const recursivePrepareReactNativeFactoryFunction = `  func prepareReactNativeFactory() {
    if reactNativeFactory != nil {
      return
    }

    prepareReactNativeFactory()
  }`;

/**
 * Applies the generated iOS compatibility patches needed by the Expo example app.
 */
function withIosBuildCompat(config) {
  config = withPodsDeploymentTarget(config);
  config = withSceneInfoPlist(config);
  config = loadExpoConfigPlugins().IOSConfig.XcodeProjectFile.withBuildSourceFile(config, {
    filePath: 'SceneDelegate.swift',
    contents: sceneDelegateContents,
    overwrite: true,
  });
  config = withSceneAppDelegate(config);

  return config;
}

/**
 * Loads Expo config plugins only when Expo executes the app-local plugin.
 */
function loadExpoConfigPlugins() {
  return require('expo/config-plugins');
}

/**
 * Pins all generated Pods deployment targets to the app target to avoid Xcode beta drift.
 */
function withPodsDeploymentTarget(config) {
  const { withDangerousMod } = loadExpoConfigPlugins();
  return withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, 'Podfile');
      let podfile = fs.readFileSync(podfilePath, 'utf8');

      if (podfile.includes("config.build_settings['IPHONEOS_DEPLOYMENT_TARGET']")) {
        return modConfig;
      }

      const anchor = `    )
  end
end`;
      const replacement = `    )
${deploymentTargetPatch}  end
end`;

      if (!podfile.includes(anchor)) {
        throw new Error('Unable to insert iOS build compatibility settings into generated Podfile.');
      }

      podfile = podfile.replace(anchor, replacement);
      fs.writeFileSync(podfilePath, podfile);

      return modConfig;
    },
  ]);
}

/**
 * Declares a scene delegate so UIKit owns the window lifecycle on modern iOS.
 */
function withSceneInfoPlist(config) {
  const { withInfoPlist } = loadExpoConfigPlugins();
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: 'Default Configuration',
            UISceneDelegateClassName: '$(PRODUCT_MODULE_NAME).SceneDelegate',
          },
        ],
      },
    };

    return modConfig;
  });
}

/**
 * Rewrites the generated Swift AppDelegate to defer React Native startup to SceneDelegate.
 */
function withSceneAppDelegate(config) {
  const { withAppDelegate } = loadExpoConfigPlugins();
  return withAppDelegate(config, (modConfig) => {
    if (modConfig.modResults.language !== 'swift') {
      throw new Error('Expected a Swift AppDelegate for the ASL example iOS app.');
    }

    modConfig.modResults.contents = patchAppDelegate(modConfig.modResults.contents);
    return modConfig;
  });
}

/**
 * Produces an idempotent AppDelegate patch that works across repeated Expo prebuilds.
 */
function patchAppDelegate(contents) {
  let next = contents;

  if (next.includes(recursivePrepareReactNativeFactoryFunction)) {
    next = next.replace(recursivePrepareReactNativeFactoryFunction, prepareReactNativeFactoryFunction);
  }

  next = replaceBeforeAnchor(
    next,
    reactNativeFactorySetup,
    '    prepareReactNativeFactory()',
    '#if os(iOS) || os(tvOS)',
    'Unable to replace React Native factory setup in AppDelegate.swift.'
  );

  next = replaceOnce(
    next,
    `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`,
    `#if os(iOS) || os(tvOS)
    if #unavailable(iOS 13.0) {
      window = UIWindow(frame: UIScreen.main.bounds)
      if let window {
        startReactNative(in: window, launchOptions: launchOptions)
      }
    }
#endif`,
    'Unable to replace React Native startup window setup in AppDelegate.swift.'
  );

  if (!next.includes('func prepareReactNativeFactory()')) {
    next = replaceOnce(
      next,
      `  // Linking API`,
      `${prepareReactNativeFactoryFunction}

  func startReactNative(
    in window: UIWindow,
    launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) {
    prepareReactNativeFactory()
    reactNativeFactory?.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
  }

  public func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
  }

  // Linking API`,
      'Unable to insert scene lifecycle helpers into AppDelegate.swift.'
    );
  }

  return next;
}

/**
 * Replaces one generated Swift fragment and fails loudly when the template shape changes.
 */
function replaceOnce(contents, search, replacement, message) {
  const first = contents.indexOf(search);
  if (first === -1) {
    if (contents.includes(replacement)) {
      return contents;
    }
    throw new Error(message);
  }

  const second = contents.indexOf(search, first + search.length);
  if (second !== -1) {
    throw new Error(`${message} Found multiple matches.`);
  }

  return contents.slice(0, first) + replacement + contents.slice(first + search.length);
}

/**
 * Replaces a generated Swift fragment only when it appears before a known anchor.
 */
function replaceBeforeAnchor(contents, search, replacement, anchor, message) {
  const anchorIndex = contents.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(message);
  }

  const first = contents.indexOf(search);
  if (first === -1 || first > anchorIndex) {
    if (contents.slice(0, anchorIndex).includes(replacement)) {
      return contents;
    }
    throw new Error(message);
  }

  return contents.slice(0, first) + replacement + contents.slice(first + search.length);
}

module.exports = withIosBuildCompat;
module.exports.patchAppDelegate = patchAppDelegate;
