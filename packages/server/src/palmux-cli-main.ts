// Entry point of the `palmux` command (`scripts/palmux` runs it with tsx).
import { callerTty, localPost, runCli, serverAddress } from './palmux-cli';

const address = serverAddress();

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  tty: () => callerTty(process.env),
  post: localPost(address),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  write: (text) => {
    process.stdout.write(text);
  },
  version: async () => (await import('./version')).APP_VERSION,
  address,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
