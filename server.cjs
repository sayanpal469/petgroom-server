/**
 * Entry file for Hostinger (and any host that loads the app with require()).
 * The API is an ES module; require() can't load one on every Node version, but import() can.
 * The port opens within a fraction of a second, well inside Hostinger's 3-second check.
 */
import("./src/server.js").catch((err) => {
  console.error("The API couldn't start:", err);
  process.exit(1);
});
