import { createLoggerServer, configFromEnv } from './logger.mjs';

try { process.loadEnvFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const config = configFromEnv(process.env);
const { server, close } = createLoggerServer(config);
server.listen(config.port, config.host, () => {
  console.log(`RMO testing page: ${config.publicOrigin}`);
  console.log('Discord logging status is available at /api/health.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => { close(); process.exit(0); });
});
