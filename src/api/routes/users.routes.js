import { Router } from 'express';
import { createUser, deleteUser, listUsers, updateUserPassword } from '../auth/supabase.js';
import { isSupabaseAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errors.js';
import { ValidationError } from '../validate.js';

/**
 * Dashboard users (people who log in), managed through Supabase Auth.
 * Different from "workers", who only receive the alert emails.
 */
export const userRoutes = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const requireSupabase = (req, res, next) => {
  if (!isSupabaseAuth()) {
    return res.status(501).json({
      error: 'La gestión de usuarios requiere AUTH_PROVIDER=supabase',
    });
  }
  return next();
};

userRoutes.use(requireSupabase);

userRoutes.get(
  '/',
  asyncHandler(async (req, res) => res.json({ users: await listUsers() })),
);

userRoutes.post(
  '/',
  asyncHandler(async (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!EMAIL_RE.test(email)) throw new ValidationError('El email no es válido');
    if (password.length < 8) throw new ValidationError('La contraseña debe tener al menos 8 caracteres');
    res.status(201).json({ user: await createUser({ email, password }) });
  }),
);

userRoutes.put(
  '/:id/password',
  asyncHandler(async (req, res) => {
    const password = String(req.body?.password ?? '');
    if (password.length < 8) throw new ValidationError('La contraseña debe tener al menos 8 caracteres');
    res.json({ user: await updateUserPassword(req.params.id, password) });
  }),
);

userRoutes.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (req.user?.id === req.params.id) {
      throw new ValidationError('No puedes eliminar tu propio usuario');
    }
    await deleteUser(req.params.id);
    res.json({ ok: true });
  }),
);

userRoutes.use((error, req, res, next) => {
  if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
  return next(error);
});
