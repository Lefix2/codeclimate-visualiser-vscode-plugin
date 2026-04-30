'use strict';

module.exports = {
  require: ['tsx/cjs', './test/setup.cjs'],
  spec: 'test/**/*.test.ts',
  timeout: 10000,
};
