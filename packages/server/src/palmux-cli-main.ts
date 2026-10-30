// Entry point of the `palmux` command (`scripts/palmux` runs it with tsx).
import { callerTty, localPost, runCli } from './palmux-cli';

process.exitCode = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  tty: () => callerTty(process.env),
  post: localPost(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
