'use strict';

// Process-level options set by server/sdk/embedded.js before server/index.js
// (and config-loader/database) are required. Keeping this module dependency-free
// is important: it must be safe to load first.
module.exports = {
  /** External pg Pool supplied by an embedded host. */
  externalPool: null,
  /** Whether stopServer should end the main pool. */
  ownsPool: true,
  /** null = all features; array of feature ids otherwise. */
  features: null,
  /** null = default (console enabled in CLI); false disables pages/static. */
  console: null,
  /** null = default (pg in server, memory in demo); false/none disables sessions. */
  session: null,
};
