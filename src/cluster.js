import cluster from "node:cluster";
import os from "node:os";

/** One worker per CPU core, restarted if it crashes. The API keeps no state in memory that must be shared. */
const count = Number(process.env.WEB_CONCURRENCY) || os.availableParallelism();

if (cluster.isPrimary) {
  for (let i = 0; i < count; i++) cluster.fork();
  cluster.on("exit", (worker, code) => {
    if (!worker.exitedAfterDisconnect && code !== 0) {
      console.error(`worker ${worker.process.pid} exited with ${code}, restarting`);
      setTimeout(() => cluster.fork(), 1000);
    }
  });
} else {
  const { start } = await import("./server.js");
  await start();
}
