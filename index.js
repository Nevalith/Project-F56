import { registerRootComponent } from 'expo'; // Keep if your build.yml expects it, otherwise use AppRegistry
import { Buffer } from 'buffer';
global.Buffer = Buffer;

import App from './App';

// This ensures the Buffer is available globally before App.js logic runs
import { AppRegistry } from 'react-native';
AppRegistry.registerComponent('main', () => App);
