import { registerRootComponent } from 'expo';
import { Buffer } from 'buffer';

// This MUST be the first thing that happens
global.Buffer = Buffer;

import App from './App';

registerRootComponent(App);
