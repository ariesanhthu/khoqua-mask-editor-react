import { NextResponse } from 'next/server';
import { generateId, getDb, hashPassword } from '@/lib/db';
import { requireAuth } from '@/lib/auth';
import type { UserRole } from '@/types';

const roles = new Set<UserRole>(['ADMIN', 'ANNOTATOR', 'REVIEWER']);

export async function GET(request: Request) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN') return NextResponse.json({ code: 'FORBIDDEN', message: 'Admin access required' }, { status: 403 });
  const db = await getDb();
  const rows = await db.prepare('SELECT id, display_name, email, role, created_at FROM users ORDER BY created_at DESC').all();
  return NextResponse.json(rows.map((row) => ({ id: row.id, displayName: row.display_name, email: row.email, role: row.role, createdAt: row.created_at })));
}

export async function POST(request: Request) {
  const user = await requireAuth(request);
  if (user.role !== 'ADMIN') return NextResponse.json({ code: 'FORBIDDEN', message: 'Admin access required' }, { status: 403 });
  const body = await request.json() as { displayName?: string; email?: string; password?: string; role?: UserRole };
  if (!body.displayName?.trim() || !body.password || body.password.length < 6 || !body.role || !roles.has(body.role)) {
    return NextResponse.json({ code: 'INVALID_ANNOTATION', message: 'Thông tin người dùng không hợp lệ.' }, { status: 400 });
  }
  try {
    const id = generateId();
    const db = await getDb();
    await db.prepare('INSERT INTO users (id, display_name, email, hashed_password, role) VALUES (?, ?, ?, ?, ?)')
      .run(id, body.displayName.trim(), body.email?.trim() || null, hashPassword(body.password), body.role);
    return NextResponse.json({ id, displayName: body.displayName.trim(), email: body.email || null, role: body.role }, { status: 201 });
  } catch {
    return NextResponse.json({ code: 'INVALID_ANNOTATION', message: 'Không thể tạo người dùng.' }, { status: 400 });
  }
}
