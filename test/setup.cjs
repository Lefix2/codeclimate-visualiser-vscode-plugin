'use strict';

// Intercept require('vscode') before any test file loads it.
// This file is loaded as plain CJS before tsx compiles any test module.

class MockEventEmitter {
  constructor() {
    this._listeners = [];
    // Mirror the shape of vscode.EventEmitter.event (a subscribe function)
    this.event = (listener) => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          this._listeners = this._listeners.filter((l) => l !== listener);
        },
      };
    };
  }

  fire(e) {
    this._listeners.forEach((l) => l(e));
  }

  dispose() {
    this._listeners = [];
  }
}

const vscodeMock = {
  EventEmitter: MockEventEmitter,
};

const Module = require('module');
const originalLoad = Module._load;

Module._load = function (request, ...args) {
  if (request === 'vscode') {
    return vscodeMock;
  }
  return originalLoad.call(this, request, ...args);
};
