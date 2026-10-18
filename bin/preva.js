#!/usr/bin/env node

import { main } from '../src/index.js';

main().catch((err) => {
  if (err && err.message) {
    console.error(err.message);
  }
  process.exit(1);
});
