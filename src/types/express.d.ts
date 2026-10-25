export interface AuthenticatedUser {
  id: string;
  email: string;
}

export interface AuthenticatedWorkspace {
  id: string;
  name: string;
  currency: string;
  role: 'owner' | 'member';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      workspace?: AuthenticatedWorkspace;
    }
  }
}
