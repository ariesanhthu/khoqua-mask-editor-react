import { NextResponse } from 'next/server';
import { getDb, generateId, hashPassword } from '@/lib/db';

/**
 * Seed endpoint — creates default admin user and a demo project.
 * Safe to call multiple times (idempotent).
 */
export async function POST() {
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ code: 'FORBIDDEN', message: 'Seed is disabled in production' }, { status: 403 });
  }
  const db = getDb();

  // Create admin user if not exists
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'ADMIN' LIMIT 1").get();
  let adminId: string;

  if (!existingAdmin) {
    adminId = generateId();
    db.prepare(`
      INSERT INTO users (id, display_name, email, hashed_password, role)
      VALUES (?, ?, ?, ?, ?)
    `).run(adminId, 'Admin', 'admin@local', hashPassword('admin123'), 'ADMIN');
  } else {
    adminId = (existingAdmin as Record<string, unknown>).id as string;
  }

  // Create demo annotators
  const annotators = ['Thư', 'Minh', 'Lan'];
  for (const name of annotators) {
    const existing = db.prepare('SELECT id FROM users WHERE display_name = ?').get(name);
    if (!existing) {
      db.prepare(`
        INSERT INTO users (id, display_name, hashed_password, role)
        VALUES (?, ?, ?, 'ANNOTATOR')
      `).run(generateId(), name, hashPassword('123456'));
    }
  }

  // Create demo project if not exists
  const existingProject = db.prepare('SELECT id FROM projects LIMIT 1').get();
  let projectId: string;
  if (!existingProject) {
    projectId = generateId();
    db.prepare(`
      INSERT INTO projects (id, name, drive_folder_id)
      VALUES (?, ?, ?)
    `).run(projectId, 'Bitter Melon Ridge Annotation', '');

    // Create demo dataset with sample files
    const datasetId = generateId();
    db.prepare(`
      INSERT INTO datasets (id, project_id, name, dataset_version, algorithm_version)
      VALUES (?, ?, ?, ?, ?)
    `).run(datasetId, projectId, 'Demo Dataset', '2026-08-10', 'unsupervised-v1');

    // Create 20 sample files
    for (let i = 1; i <= 20; i++) {
      const key = `BM_${String(i).padStart(6, '0')}`;
      db.prepare(`
        INSERT INTO dataset_files (id, dataset_id, external_key, image_drive_file_id, prediction_drive_file_id,
          image_filename, prediction_filename, width, height, annotation_state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UNSTARTED')
      `).run(
        generateId(), datasetId, key,
        `images/${key}.jpg`, `predictions/${key}.png`,
        `${key}.jpg`, `${key}.png`,
        1024, 768
      );
    }
  } else {
    projectId = (existingProject as Record<string, unknown>).id as string;
  }

  const userCount = (db.prepare('SELECT COUNT(*) as c FROM users').get() as Record<string, unknown>).c;
  const fileCount = (db.prepare('SELECT COUNT(*) as c FROM dataset_files').get() as Record<string, unknown>).c;

  return NextResponse.json({
    message: 'Seed complete',
    users: userCount,
    files: fileCount,
    projectId,
  });
}
