import express from 'express';
import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { createNestApp } from './create-app';

setGlobalOptions({
  region: 'europe-west1',
  memory: '1GiB',
  timeoutSeconds: 120,
  maxInstances: 20,
  concurrency: 80,
});

const server = express();
let nestReady: Promise<void> | null = null;

function ensureNest(): Promise<void> {
  if (!nestReady) {
    process.env.NODE_ENV = 'production';
    process.env.FIREBASE_PROJECT_ID =
      process.env.FIREBASE_PROJECT_ID || 'shuttlez-api';
    nestReady = createNestApp(server).then(async (app) => {
      await app.init();
    });
  }
  return nestReady;
}

export const api = onRequest(
  {
    invoker: 'public',
  },
  async (req, res) => {
    await ensureNest();
    server(req, res);
  },
);
