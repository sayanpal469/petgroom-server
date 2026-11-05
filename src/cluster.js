import cluster from "node:cluster";

/**
 * For a VPS: WEB_CONCURRENCY=4 runs four workers, restarted if they crash. The API keeps no state in
 * memory that must be shared. Without it (shared hosting such as Hostinger, which needs the main
 * process itself to listen) this runs the API in a single process, like `node src/server.js`.
 */
const count = Number(process.env.WEB_CONCURRENCY) || 1;

if (count > 1 && cluster.isPrimary) {
  for (let i = 0; i < count; i++) cluster.fork();
  cluster.on("exit", (worker, code) => {
    if (!worker.exitedAfterDisconnect && code !== 0) {
      console.error(`worker ${worker.process.pid} exited with ${code}, restarting`);
      setTimeout(() => cluster.fork(), 1000);
    }
  });
} else {
  await import("./server.js");
}
