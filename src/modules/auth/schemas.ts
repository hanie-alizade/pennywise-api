import { z } from 'zod';

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(72, 'Password must not exceed 72 characters')
    .refine((val) => Buffer.byteLength(val, 'utf8') <= 72, {
      message: 'Password must not exceed 72 bytes',
    }),
});

export type CredentialsInput = z.infer<typeof credentialsSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
