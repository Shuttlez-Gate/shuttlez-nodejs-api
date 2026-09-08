import type { IncomingMessage, ServerResponse } from 'http';
import express from 'express';
import { createNestApp } from '../src/create-app';

const server = express();
let nestReady: Promise<void> | null = null;

function ensureNest(): Promise<void> {
  if (!nestReady) {
    nestReady = createNestApp(server).then(async (app) => {
      await app.init();
    });
  }
  return nestReady;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  await ensureNest();
  server(req, res);
}
