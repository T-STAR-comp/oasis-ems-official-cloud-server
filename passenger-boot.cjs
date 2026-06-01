const path = require('node:path');
const { pathToFileURL } = require('node:url');

console.log('[oasis-cloud] passenger.boot_start', {
  cwd: process.cwd(),
  node: process.version,
  env: process.env.NODE_ENV || null,
  passenger_app_env: process.env.PASSENGER_APP_ENV || null,
  passenger_base_uri: process.env.PASSENGER_BASE_URI || null,
});

// Passenger accepts a Promise that resolves to the Express application.
module.exports = import(pathToFileURL(path.join(__dirname, 'server.js')).href)
  .then((module) => {
    const app = module.default;
    if (!app || typeof app.use !== 'function') {
      throw new Error('cloud-server/server.js did not export an Express app.');
    }
    console.log('[oasis-cloud] passenger.boot_complete', {
      exported: 'express_app',
    });
    return app;
  })
  .catch((error) => {
    console.error('[oasis-cloud] passenger.boot_failed', {
      message: error?.message || 'Unknown boot error',
      stack: error?.stack || null,
    });
    throw error;
  });
