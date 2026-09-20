import { parentPort } from 'node:worker_threads';
globalThis.onmessage = null;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
await import('../../src/worker.js');
parentPort.on('message', (data) => globalThis.onmessage({ data }));
