import 'dotenv/config';
import { createBaseApp, isPassengerRuntime, mountFullStack } from './createApp.mjs';
import { logError, logInfo } from './utils/logger.js';

const PORT = Number(process.env.PORT || 3001);
const app = createBaseApp();

const bootPromise = mountFullStack(app).catch((error) => {
  app.locals.boot.error = error?.message || 'Failed to mount API routes';
  app.locals.boot.ready = false;
  logError('startup.mount_failed', error);
});

export default app;

if (!isPassengerRuntime()) {
  bootPromise.then(() => {
    const host = String(process.env.OASIS_SERVER_HOST || '0.0.0.0').trim() || '0.0.0.0';
    app.listen(PORT, host, () => {
      logInfo('startup.listen', { port: PORT, host });
      console.log(`Oasis EMS cloud API on http://${host}:${PORT}`);
    });
  });
} else {
  logInfo('startup.passenger_mode', { message: 'Passenger mode — listen skipped.' });
}
