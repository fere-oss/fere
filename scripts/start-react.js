#!/usr/bin/env node

// Native recursive watchers can exhaust macOS file descriptors in this repo,
// especially when React and Electron dev servers run together. Force polling so
// webpack/watchpack does not open one watcher per directory.
process.env.WATCHPACK_POLLING = process.env.WATCHPACK_POLLING || "1000";
process.env.CHOKIDAR_USEPOLLING =
  process.env.CHOKIDAR_USEPOLLING || "true";
process.env.CHOKIDAR_INTERVAL = process.env.CHOKIDAR_INTERVAL || "1000";

require("react-scripts/scripts/start");
