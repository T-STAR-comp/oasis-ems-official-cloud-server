/**
 * cPanel / Phusion Passenger startup file.
 * Set this as the Node.js application startup file in your hosting panel.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('node:path');
const { pathToFileURL } = require('node:url');

console.log('[oasis-cloud] passenger.boot_start', {
  cwd: process.cwd(),
  dir: __dirname,
  node: process.version,
  passenger_app_env: process.env.PASSENGER_APP_ENV || null,
  passenger_base_uri: process.env.PASSENGER_BASE_URI || null,
});

module.exports = import(pathToFileURL(path.join(__dirname, 'server.js')).href)
  .then((module) => {
    const app = module.default;
    if (!app || typeof app.use !== 'function') {
      throw new Error('server.js must export the Express app as default.');
    }
    console.log('[oasis-cloud] passenger.boot_complete');
    return app;
  })
  .catch((error) => {
    console.error('[oasis-cloud] passenger.boot_failed', error?.message || error);
    console.error(error?.stack || '');
    throw error;
  });
