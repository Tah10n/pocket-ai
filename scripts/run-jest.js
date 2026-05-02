#!/usr/bin/env node

// Set test env before loading Jest so Babel/NativeWind bootstrap sees it too.
process.env.NODE_ENV = 'test';

require('../node_modules/jest/bin/jest.js');
