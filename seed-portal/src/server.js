import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app, close } = createApp({ config });
const server = app.listen(config.port, () => console.log(`Superfast Seed Portal listening on http://localhost:${config.port}`));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(() => { close(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});
