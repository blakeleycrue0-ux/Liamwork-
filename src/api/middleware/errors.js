export function notFound(req, res) {
  res.status(404).json({ error: 'Recurso no encontrado' });
}

export function errorHandler(error, req, res, _next) {
  const status = error.status ?? 500;
  if (status >= 500) console.error('[api]', error.stack || error.message);
  const isSqliteUnique = /UNIQUE constraint failed/i.test(error.message || '');
  res.status(isSqliteUnique ? 409 : status).json({
    error: isSqliteUnique ? 'Ya existe un registro con ese valor único (URL o email)' : error.message,
  });
}

/** Wraps an async handler so rejections reach the error handler. */
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
