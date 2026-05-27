(async () => {
    console.log('[oasis-cloud] passenger.boot_start', {
        cwd: process.cwd(),
        node: process.version,
        env: process.env.NODE_ENV || null,
        passenger_app_env: process.env.PASSENGER_APP_ENV || null,
    });
    await import('./server.js');
    console.log('[oasis-cloud] passenger.boot_complete');
})().catch((error) => {
    console.error('[oasis-cloud] passenger.boot_failed', {
        message: error?.message || 'Unknown boot error',
        stack: error?.stack || null,
    });
    throw error;
});
