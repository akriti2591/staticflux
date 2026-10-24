/**
 * Binary channels between threads (R11.17–R11.19): declared layouts, transferable data
 * channels, and shared-memory / double-buffered frame channels. Separate entry point so
 * apps that don't use them pay nothing at boot.
 */
export * from './channel-errors.js';
export * from './layout.js';
export * from './data-channel.js';
export * from './frame-channel.js';
