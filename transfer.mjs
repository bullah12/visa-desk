// Portable backups use the same schema in the website and every installation.
// Only local raster image data is accepted; imported paths/URLs are never fetched.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, fallback = '') => typeof value === 'string' ? value : fallback;
const id = () => crypto.randomUUID();
export const safeImageUrl = value => typeof value === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : '';
function document(value) {
  const data = object(value) && safeImageUrl(value.data);
  return data ? { ...(typeof value.id === 'string' ? { id: value.id } : {}), name: text(value.name, 'image').slice(0, 200), data } : null;
}
function fields(value) {
  if (!object(value)) throw new Error('Invalid applicant or shared details.');
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, val]) => {
    if (typeof val !== 'string') throw new Error(`Invalid value for ${key}.`);
    return [key, val];
  }));
}
function person(value) {
  if (!object(value)) throw new Error('Invalid applicant.');
  return {
    id: text(value.id, id()), fields: fields(value.fields),
    passport: document(value.passport), headshot: document(value.headshot), preparedPhoto: document(value.preparedPhoto),
    ocrStatus: text(value.ocrStatus, 'Imported; verify passport'), ocrText: text(value.ocrText),
    createdAt: text(value.createdAt, new Date().toISOString()),
    scanMissing: Array.isArray(value.scanMissing) ? value.scanMissing.filter(x => typeof x === 'string') : [],
    scanConflicts: Array.isArray(value.scanConflicts) ? value.scanConflicts.filter(x => typeof x === 'string') : [],
  };
}
export function parseWorkspace(payload) {
  if (!object(payload)) throw new Error('This is not a Visa Desk backup.');
  if (payload.version !== undefined && payload.version !== 1) throw new Error('Unsupported backup version.');
  let raw = payload.workspace || payload;
  let missingDesktopImages = false;
  if (Array.isArray(payload.applicants)) {
    missingDesktopImages = true;
    raw = { people: payload.applicants.map(row => {
      if (!object(row?.applicant)) throw new Error('Invalid desktop applicant.');
      const { passport_image_path, photo_path, prepared_photo_path, source_passport_file, source_headshot_file, ocr_status, ...values } = row.applicant;
      return { fields: values, ocrStatus: ocr_status };
    }), history: [] };
  }
  if (!object(raw) || !Array.isArray(raw.people) || !Array.isArray(raw.history)) throw new Error('This is not a Visa Desk backup.');
  if (raw.version !== undefined && raw.version !== 1) throw new Error('Unsupported workspace version.');
  if (raw.unassigned !== undefined && !Array.isArray(raw.unassigned)) throw new Error('Invalid unassigned photos.');
  const workspace = {
    version: 1, defaults: fields(raw.defaults || {}), people: raw.people.map(person),
    history: raw.history.map(item => {
      if (!object(item)) throw new Error('Invalid history record.');
      const submittedAt = text(item.submittedAt, new Date().toISOString());
      if (!Number.isFinite(Date.parse(submittedAt))) throw new Error('Invalid history date.');
      return { id: text(item.id, id()), submittedAt, reference: text(item.reference), snapshot: person(item.snapshot) };
    }),
    unassigned: (raw.unassigned || []).map(document).filter(Boolean).map(item => ({ ...item, id: item.id || id() })),
  };
  // IDs are used by the editor. Keep them unique even for malformed source files.
  for (const list of [workspace.people, workspace.history, workspace.unassigned]) {
    const used = new Set();
    for (const item of list) { if (!item.id || used.has(item.id)) item.id = id(); used.add(item.id); }
  }
  return { workspace, missingDesktopImages };
}
export function mergeWorkspaces(current, incoming) {
  const result = parseWorkspace(current).workspace;
  for (const key of ['people', 'history', 'unassigned']) {
    const byId = new Map(result[key].map(item => [item.id, item]));
    for (const source of incoming[key]) {
      const item = structuredClone(source);
      const existing = byId.get(item.id);
      if (existing && canonical(existing) === canonical(item)) continue;
      // A changed copy is kept as a separate record. Never overwrite silently.
      if (existing) item.id = id();
      result[key].push(item); byId.set(item.id, item);
    }
  }
  return result; // Shared defaults remain those of the receiving workspace.
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
