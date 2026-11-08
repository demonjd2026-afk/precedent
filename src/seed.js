/**
 * Manifest entry point for the sample-data worker. Forge resolves handlers
 * relative to src/, so this re-export keeps the implementation in src/seed/.
 */
export { seedWorker } from './seed/seed.js';
