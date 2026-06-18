import fs from 'fs';
import path from 'path';

export function sanitizeSchoolIdForAsset(schoolId) {
  return String(schoolId || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'default';
}

export function buildSchoolLogoFilename(schoolId, ext = '.png') {
  const normalizedExt = String(ext || '.png').startsWith('.') ? String(ext || '.png') : `.${ext}`;
  return `school-logo-${sanitizeSchoolIdForAsset(schoolId)}${normalizedExt}`;
}

export function resolveUploadsRoot(baseDir) {
  return process.env.OASIS_UPLOADS_DIR
    ? path.resolve(process.env.OASIS_UPLOADS_DIR)
    : path.join(baseDir, '..', 'uploads');
}

export function resolveStoredLogoPath(storedPath, uploadsRoot) {
  const cleanPath = String(storedPath || '').replace(/^\/+/, '');
  if (!cleanPath) return null;
  if (cleanPath.startsWith('uploads/')) {
    return path.join(uploadsRoot, cleanPath.slice('uploads/'.length));
  }
  return null;
}

export function persistSchoolLogoFile(schoolId, buffer, ext, uploadsRoot) {
  const logoDir = path.join(uploadsRoot, 'logos');
  if (!fs.existsSync(logoDir)) {
    fs.mkdirSync(logoDir, { recursive: true });
  }

  const filename = buildSchoolLogoFilename(schoolId, ext);
  const absolutePath = path.join(logoDir, filename);
  fs.writeFileSync(absolutePath, buffer);

  return {
    filename,
    absolutePath,
    storedPath: `/uploads/logos/${filename}`,
  };
}

export function deleteSchoolLogoFiles(schoolId, uploadsRoot, { exceptFilename = null } = {}) {
  const logoDir = path.join(uploadsRoot, 'logos');
  if (!fs.existsSync(logoDir)) {
    return;
  }

  const prefix = `school-logo-${sanitizeSchoolIdForAsset(schoolId)}`;
  fs.readdirSync(logoDir).forEach((entry) => {
    if (!entry.startsWith(prefix)) return;
    if (exceptFilename && entry === exceptFilename) return;
    try {
      fs.unlinkSync(path.join(logoDir, entry));
    } catch (_error) {
      // Ignore cleanup errors.
    }
  });
}
