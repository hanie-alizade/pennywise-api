import express, { type Express } from 'express';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export const app: Express = express();

// Standard middlewares
app.use(express.json());

// GET /health
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// 404 handler for unknown routes
app.use(notFoundHandler);

// Central error handler
app.use(errorHandler);

export default app;
