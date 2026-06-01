/**
 * Alternate startup entry (some panels use app.js by default).
 * Prefer passenger-boot.cjs on cPanel when you can choose the startup file.
 */
import app from './server.js';

export default app;
