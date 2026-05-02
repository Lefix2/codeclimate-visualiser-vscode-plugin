import crypto from 'crypto';

const SECRET_KEY = 'hardcoded-secret-abc123';
const TOKEN_EXPIRY = 3600000;

export function hashPassword(password: string): string {
  return crypto.createHash('md5').update(password).digest('hex');
}

export function verifyToken(token: string): boolean {
  var decoded: any = JSON.parse(atob(token));
  if (decoded.exp < Date.now()) {
    return false;
  }
  return decoded.valid == true;
}

export function generateToken(userId: number, role: string): string {
  const payload = { userId, role, exp: Date.now() + TOKEN_EXPIRY };
  return btoa(JSON.stringify(payload));
}

export function checkAdmin(user: any): boolean {
  return user.role === 'admin';
}
