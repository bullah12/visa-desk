import { loadWorkspace, saveWorkspace } from './storage.mjs';
import { scanPassportFields, scanPrintedPassportFields } from './mrz.mjs';
import { encryptBackup, decryptBackup } from './crypto.mjs';

const ETA_URL = 'https://ksavisa.sa/visa/electronic-travel-authorization/details';
const FIELDS = [
  ['Identity', 'first_names', 'Given name(s)'], ['Identity', 'surname', 'Surname'], ['Identity', 'date_of_birth', 'Date of birth'], ['Identity', 'sex', 'Sex on passport'], ['Identity', 'place_of_birth', 'Place of birth'], ['Identity', 'country_of_birth', 'Country of birth'],
  ['Passport', 'passport_number', 'Passport number'], ['Passport', 'passport_type', 'Passport type'], ['Passport', 'nationality', 'Nationality'], ['Passport', 'issue_date', 'Issue date'], ['Passport', 'expiry_date', 'Expiry date'], ['Passport', 'issuing_authority', 'Issuing authority'],
  ['Contact', 'email', 'Contact email'], ['Contact', 'phone', 'Contact phone'],
  ['Travel', 'purpose', 'Purpose of visit'], ['Travel', 'umrah_intended', 'Umrah if asked'], ['Travel', 'departure_country', 'Departure country'], ['Travel', 'arrival_date', 'Expected arrival date'], ['Travel', 'arrival_mode', 'Arrival mode'], ['Travel', 'arrival_city', 'Arrival city'], ['Travel', 'arrival_port', 'Arrival airport'], ['Travel', 'flight_number', 'Flight number'], ['Travel', 'planned_stay_days', 'Planned stay, days'],
  ['Saudi address', 'saudi_street', 'Street / building'], ['Saudi address', 'saudi_short_address', 'Short address'], ['Saudi address', 'saudi_secondary_number', 'Secondary number'], ['Saudi address', 'saudi_district', 'District'], ['Saudi address', 'saudi_city', 'City'], ['Saudi address', 'saudi_postcode', 'Postal code'], ['Saudi address', 'saudi_full_address', 'Full address'], ['Saudi address', 'saudi_host_name', 'Host / hotel name'],
  ['Work', 'employment_status', 'Employment status'], ['Work', 'occupation', 'Occupation / job title'], ['Work', 'employer', 'Employer'],
  ['Review', 'photo_match_note', 'Headshot pairing note'],
];
const DATE_FIELDS = new Set(['date_of_birth', 'issue_date', 'expiry_date', 'arrival_date']);
const WIDE_FIELDS = new Set(['saudi_full_address', 'photo_match_note']);
const SHARED_GROUPS = new Set(['Contact', 'Travel', 'Saudi address', 'Work']);
const DEFAULTS = {
  passport_type: 'Ordinary', nationality: 'British', country_of_birth: 'United Kingdom', email: '', phone: '',
  purpose: 'Tourism', umrah_intended: 'Yes', departure_country: 'United Kingdom', arrival_mode: 'Air', arrival_city: 'Jeddah', arrival_port: 'King Abdulaziz International Airport (JED)',
  saudi_street: '', saudi_short_address: '', saudi_secondary_number: '', saudi_district: 'Aziziyah', saudi_city: 'Jeddah', saudi_postcode: '', saudi_full_address: '',
  employment_status: 'Unemployed',
};
const SCAN_FIELDS = [['first_names', 'Given names'], ['surname', 'Surname'], ['passport_number', 'Passport number'], ['nationality', 'Nationality'], ['date_of_birth', 'Date of birth'], ['sex', 'Sex'], ['expiry_date', 'Expiry date']];
const PRINTED_ONLY_FIELDS = [['place_of_birth', 'Place of birth'], ['country_of_birth', 'Country of birth'], ['issue_date', 'Issue date'], ['issuing_authority', 'Issuing authority']];
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const blankState = () => ({ version: 1, defaults: { ...DEFAULTS }, people: [], history: [], unassigned: [] });
let state = blankState();
let selectedId = null;
let currentView = 'overview';
let saveTimer;
let ocrWorkerPromise;
let toastTimer;
let pendingEncryptedBackup = null;

function personName(person) { return `${person.fields.first_names || ''} ${person.fields.surname || ''}`.trim() || 'Name pending'; }
function initials(person) { return personName(person).split(/\s+/).slice(0, 2).map(x => x[0]).join('').toUpperCase(); }
function selectedPerson() { return state.people.find(person => person.id === selectedId); }
function safeFilename(value) { return String(value || 'person').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'person'; }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => node.classList.remove('show'), 4500); }
function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => persist(), 350); }
async function persist() { clearTimeout(saveTimer); try { await saveWorkspace(state); $('#storageStatus').textContent = 'Saved on this device'; } catch (error) { $('#storageStatus').textContent = 'Storage unavailable · export backup'; toast(`Could not save locally: ${error.message}`); } }
function makePerson(fields = {}, passport = null) {
  const allFields = Object.fromEntries(FIELDS.map(([, key]) => [key, '']));
  return { id: uid(), fields: { ...allFields, ...state.defaults, ...fields }, passport, headshot: null, preparedPhoto: null, ocrStatus: passport ? 'Passport imported; check OCR result' : 'Not read', ocrText: '', createdAt: new Date().toISOString() };
}
function normalizePerson(raw) {
  if (raw?.fields) { const person = { ...makePerson(), ...raw, fields: { ...makePerson().fields, ...raw.fields } }; if (!person.fields.country_of_birth) person.fields.country_of_birth = state.defaults.country_of_birth || 'United Kingdom'; return person; }
  const fields = Object.fromEntries(FIELDS.map(([, key]) => [key, raw?.[key] || '']));
  if (!fields.purpose) fields.purpose = 'Tourism';
  if (!fields.umrah_intended) fields.umrah_intended = 'Yes';
  if (!fields.country_of_birth) fields.country_of_birth = state.defaults.country_of_birth || 'United Kingdom';
  return makePerson(fields, raw?.passport?.data ? raw.passport : null);
}
function outstandingScanMissing(person) { return [...SCAN_FIELDS, ...PRINTED_ONLY_FIELDS].filter(([key, label]) => person.scanMissing?.includes(label) && !String(person.fields[key] || '').trim()).map(([, label]) => label); }
function reviewItems(person) {
  const f = person.fields;
  const issues = [];
  for (const [key, label] of [['first_names', 'Given names'], ['surname', 'Surname'], ['date_of_birth', 'Date of birth'], ['passport_number', 'Passport number'], ['expiry_date', 'Passport expiry'], ['email', 'Email'], ['phone', 'Phone'], ['purpose', 'Purpose'], ['arrival_date', 'Arrival date']]) if (!String(f[key] || '').trim()) issues.push(`${label} is missing`);
  if (!person.passport) issues.push('Passport image is missing');
  if (!person.headshot) issues.push('Headshot is missing');
  if (!person.preparedPhoto) issues.push('Prepare the 35 × 45 mm headshot');
  if (!f.saudi_street) issues.push('Saudi street/building is missing');
  if (f.photo_match_note) issues.push(`Confirm headshot pairing: ${f.photo_match_note}`);
  if (outstandingScanMissing(person).length) issues.push(`Not extracted from scan: ${outstandingScanMissing(person).join(', ')}`);
  if (person.scanConflicts?.length) issues.push(`Scan differs from saved details: ${person.scanConflicts.join(', ')}`);
  if (f.arrival_date && f.expiry_date) {
    const arrival = new Date(`${f.arrival_date}T00:00:00Z`);
    const expiry = new Date(`${f.expiry_date}T00:00:00Z`);
    if (Number.isFinite(arrival.getTime()) && Number.isFinite(expiry.getTime()) && expiry < new Date(arrival.getTime() + 183 * 86400000)) issues.push('Check six months of passport validity at arrival');
  }
  if (f.date_of_birth) { const dob = new Date(`${f.date_of_birth}T00:00:00Z`); if (Number.isFinite(dob.getTime())) { const age = new Date().getFullYear() - dob.getUTCFullYear() - (new Date().getMonth() + 1 < dob.getUTCMonth() + 1 || (new Date().getMonth() + 1 === dob.getUTCMonth() + 1 && new Date().getDate() < dob.getUTCDate()) ? 1 : 0); if (age < 18) issues.push('Check parent/guardian requirements for this minor'); } }
  return issues;
}
function avatar(person, extra = '') { const src = safeImageUrl(person.headshot?.data); return `<span class="avatar ${extra}">${src ? `<img src="${src}" alt="">` : escapeHtml(initials(person))}</span>`; }
function personCard(person) { const issues = reviewItems(person); return `<button class="person-card" data-select="${escapeHtml(person.id)}"><div class="card-top">${avatar(person)}<div><div class="card-name">${escapeHtml(personName(person))}</div><div class="card-meta">Passport ${escapeHtml(person.fields.passport_number ? '•••• ' + person.fields.passport_number.slice(-4) : 'pending')}</div></div></div><div class="card-bottom"><span>${person.headshot ? 'Headshot assigned' : 'Headshot needed'}</span><span class="status-pill ${issues.length ? '' : 'ready'}">${issues.length ? `${issues.length} to review` : 'Ready'}</span></div></button>`; }

function renderOverview() {
  const ready = state.people.filter(person => reviewItems(person).length === 0).length;
  $('#statApplicants').textContent = state.people.length;
  $('#statReady').textContent = ready;
  $('#statAttention').textContent = state.people.length - ready;
  $('#overviewCards').innerHTML = state.people.length ? state.people.map(personCard).join('') : '<div class="empty-panel"><h3>No applicants yet</h3><p>Import passport pages or add someone manually to begin.</p></div>';
}
function renderPeopleList() {
  const query = $('#peopleSearch').value.trim().toLowerCase();
  const people = state.people.filter(person => `${personName(person)} ${person.fields.passport_number || ''}`.toLowerCase().includes(query));
  $('#peopleCount').textContent = state.people.length;
  $('#navCount').textContent = state.people.length;
  $('#peopleList').innerHTML = people.length ? people.map(person => `<button class="person-row ${person.id === selectedId ? 'selected' : ''}" data-select="${escapeHtml(person.id)}">${avatar(person)}<span><strong>${escapeHtml(personName(person))}</strong><small>${escapeHtml(person.fields.passport_number ? '•••• ' + person.fields.passport_number.slice(-4) : 'Passport pending')}</small></span></button>`).join('') : '<div class="empty-panel">No matching applicants</div>';
}
function fieldMarkup(key, label, value, prefix = 'field') {
  const type = DATE_FIELDS.has(key) ? 'date' : 'text';
  const attrs = prefix === 'default' ? `data-default-field="${key}"` : `data-field="${key}"`;
  const wide = WIDE_FIELDS.has(key) ? ' wide' : '';
  if (key === 'sex' || key === 'umrah_intended' || key === 'employment_status') {
    const choices = key === 'sex' ? ['', 'Female', 'Male', 'Unspecified'] : key === 'umrah_intended' ? ['', 'Yes', 'No'] : ['', 'Unemployed', 'Employed', 'Student', 'Self-employed', 'Retired', 'Other'];
    return `<div class="field${wide}"><label for="${prefix}-${key}">${escapeHtml(label)}</label><select id="${prefix}-${key}" ${attrs}>${choices.map(choice => `<option value="${escapeHtml(choice)}" ${choice === value ? 'selected' : ''}>${escapeHtml(choice || 'Select…')}</option>`).join('')}</select></div>`;
  }
  return `<div class="field${wide}"><label for="${prefix}-${key}">${escapeHtml(label)}</label><input id="${prefix}-${key}" type="${type}" ${attrs} value="${escapeHtml(value || '')}"></div>`;
}
function documentCard(title, document, actions, placeholder) {
  const src = safeImageUrl(document?.data);
  return `<div class="document-card"><h3>${escapeHtml(title)}</h3>${src ? `<img src="${src}" alt="${escapeHtml(title)} preview"><small title="${escapeHtml(document.name)}">${escapeHtml(document.name)}</small>` : `<div class="missing-image">${escapeHtml(placeholder)}</div><small> </small>`}${actions}</div>`;
}
function renderDetail() {
  const pane = $('#personDetail'); const person = selectedPerson();
  if (!person) { pane.innerHTML = '<div class="empty-detail"><div class="empty-icon">▤</div><h2>Select an applicant</h2><p>Their details and documents will appear here.</p></div>'; return; }
  const issues = reviewItems(person);
  const groups = [...new Set(FIELDS.map(([group]) => group))];
  const sections = groups.map(group => `<section class="section-block"><h3>${escapeHtml(group)}</h3><div class="form-grid">${FIELDS.filter(([name]) => name === group).map(([, key, label]) => fieldMarkup(key, label, person.fields[key])).join('')}</div></section>`).join('');
  pane.innerHTML = `<div class="detail-header"><div><h2>${escapeHtml(personName(person))}</h2><p>${escapeHtml(person.ocrStatus || 'Passport not scanned')} · ${escapeHtml(person.fields.nationality || 'Nationality pending')}</p></div><div class="detail-actions"><button class="button button-outline" data-action="rename-files">Rename copies</button><button class="button button-outline" data-action="reuse-person">Duplicate draft</button><button class="button button-danger" data-action="remove-person">Remove</button></div></div>
    ${outstandingScanMissing(person).length ? `<div class="review-banner"><strong>Scan could not extract</strong><p>${escapeHtml(outstandingScanMissing(person).join(', '))}</p></div>` : ''}
    ${person.scanConflicts?.length ? `<div class="review-banner"><strong>Check saved details against scan</strong><p>The scan read different values for ${escapeHtml(person.scanConflicts.join(', '))}. Your saved entries were kept.</p></div>` : ''}
    <div class="review-banner ${issues.length ? '' : 'ready'}"><strong>${issues.length ? `${issues.length} item${issues.length === 1 ? '' : 's'} to review` : 'Basic checks passed'}</strong>${issues.length ? `<ul>${issues.slice(0, 7).map(item => `<li>${escapeHtml(item)}</li>`).join('')}${issues.length > 7 ? `<li>…and ${issues.length - 7} more</li>` : ''}</ul>` : '<p>Check every value against the passport and the live form before submitting.</p>'}</div>
    <div class="document-grid">${documentCard('Passport page', person.passport, '<button class="button button-outline" data-action="read-passport">Scan again</button><button class="button button-outline" data-action="download-passport">Download copy</button><button class="button button-outline" data-action="replace-passport">Replace passport</button>', 'No passport image')}${documentCard('Headshot', person.headshot, '<button class="button button-outline" data-action="assign-headshot">Assign headshot</button><button class="button button-primary" data-action="prepare-photo">Prepare 35 × 45</button>', 'No headshot')}${person.preparedPhoto ? documentCard('Prepared 35 × 45 photo', person.preparedPhoto, '<button class="button button-outline" data-action="download-photo">Download prepared photo</button>', 'Not prepared') : ''}</div>
    ${sections}<div class="detail-footer"><button class="button button-primary" data-action="mark-submitted">Mark as submitted</button><button class="button button-outline" data-action="open-official">Open official ETA page</button><button class="button button-subtle" disabled title="The signed-in website fields have not been mapped yet">Website autofill: pending form access</button></div>`;
}
function renderHistory() {
  $('#historyList').innerHTML = state.history.length ? [...state.history].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt)).map(item => `<div class="history-card"><div><strong>${escapeHtml(personName(item.snapshot))}</strong><small>Recorded ${escapeHtml(new Date(item.submittedAt).toLocaleString())} · Passport ending ${escapeHtml(item.snapshot.fields.passport_number?.slice(-4) || '—')}${item.reference ? ` · Ref: ${escapeHtml(item.reference)}` : ''}</small></div><div class="history-card-actions"><button class="button button-primary" data-action="reuse-history" data-history="${escapeHtml(item.id)}">New draft</button><button class="button button-danger" data-action="delete-history" data-history="${escapeHtml(item.id)}">Delete</button></div></div>`).join('') : '<div class="empty-panel"><h3>No submissions recorded yet</h3><p>After submitting a person on the official site, mark their record as submitted here to make it available for reuse.</p></div>';
}
function renderDefaults() {
  $('#sharedForm').innerHTML = FIELDS.filter(([group]) => SHARED_GROUPS.has(group)).map(([, key, label]) => fieldMarkup(key, label, state.defaults[key], 'default')).join('');
}
function render() { renderOverview(); renderPeopleList(); renderDetail(); renderHistory(); renderDefaults(); }
function showView(view) { currentView = view; document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `view-${view}`)); document.querySelectorAll('.nav-link').forEach(node => node.classList.toggle('active', node.dataset.view === view)); if (view === 'applicants') renderPeopleList(); window.scrollTo(0, 0); }
function selectPerson(id) { selectedId = id; renderPeopleList(); renderDetail(); showView('applicants'); }
function closeModal() { $('#modalRoot').innerHTML = ''; }
function modal(title, body, actions = '', wide = false) { $('#modalRoot').innerHTML = `<div class="modal-backdrop"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true"><div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close">×</button></div>${body}<div class="modal-actions">${actions}</div></div></div>`; }

function readFileAsDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
function loadImage(dataUrl) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Image could not be opened')); image.src = dataUrl; }); }
function download(filename, content, type = 'application/json') { const blob = content instanceof Blob ? content : new Blob([content], { type }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }

async function pdfPages(file) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = [];
  try {
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas'); canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      pages.push({ name: `${file.name.replace(/\.pdf$/i, '')} page ${index}.jpg`, data: canvas.toDataURL('image/jpeg', 0.9) });
      page.cleanup();
    }
  } finally { await pdf.destroy(); }
  return pages;
}

async function importPassports(files) {
  if (!files.length) return;
  const imported = [];
  for (const file of files) {
    try {
      const documents = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? await pdfPages(file) : [{ name: file.name, data: await readFileAsDataUrl(file) }];
      for (const passport of documents) { const person = makePerson({}, passport); state.people.push(person); imported.push(person); }
    } catch (error) { toast(`Could not import ${file.name}: ${error.message}`); }
  }
  if (!imported.length) return;
  selectedId = imported[0].id; await persist(); render(); showView('applicants');
  toast(`Imported ${imported.length} passport page${imported.length === 1 ? '' : 's'}. Reading MRZ locally…`);
  for (const person of imported) await readPassport(person, false);
  render();
  const results = imported.map(person => `<li><strong>${escapeHtml(personName(person) === 'Name pending' ? person.passport.name : personName(person))}:</strong> ${person.scanMissing?.length ? `Not extracted: ${escapeHtml(person.scanMissing.join(', '))}` : 'All scan fields read'}</li>`).join('');
  modal('Passport scan results', `<p>Details found were filled automatically. Review every value against the passport. Fill blank fields in the form.</p><ul class="scan-results">${results}</ul>`, '<button class="button button-primary" data-action="close-modal">Review applicants</button>', true);
}

async function importHeadshots(files) {
  if (!files.length) return;
  for (const file of files) {
    try { state.unassigned.push({ id: uid(), name: file.name, data: await readFileAsDataUrl(file) }); }
    catch (error) { toast(`Could not import ${file.name}: ${error.message}`); }
  }
  await persist(); toast(`${files.length} headshot${files.length === 1 ? '' : 's'} ready to assign. Open an applicant and choose Assign headshot.`);
  if (selectedPerson()) showAssignHeadshot();
}

function orientedCanvas(image, angle) {
  const canvas = document.createElement('canvas'); const quarter = angle % 180 !== 0;
  canvas.width = quarter ? image.height : image.width; canvas.height = quarter ? image.width : image.height;
  const context = canvas.getContext('2d');
  context.translate(canvas.width / 2, canvas.height / 2); context.rotate(angle * Math.PI / 180); context.drawImage(image, -image.width / 2, -image.height / 2);
  return canvas;
}
function deskewCanvas(canvas, degrees) {
  if (!degrees) return canvas;
  const radians = degrees * Math.PI / 180;
  const output = document.createElement('canvas'); output.width = Math.ceil(Math.abs(canvas.width * Math.cos(radians)) + Math.abs(canvas.height * Math.sin(radians))); output.height = Math.ceil(Math.abs(canvas.height * Math.cos(radians)) + Math.abs(canvas.width * Math.sin(radians)));
  const context = output.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, output.width, output.height);
  context.translate(output.width / 2, output.height / 2); context.rotate(radians); context.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
  return output;
}
function cropMrzCanvas(canvas, fraction, threshold = false) {
  const top = Math.round(canvas.height * (1 - fraction)); const width = Math.min(2800, canvas.width * 2.4); const height = Math.round((canvas.height - top) * width / canvas.width);
  const output = document.createElement('canvas'); output.width = width; output.height = height;
  const context = output.getContext('2d', { willReadFrequently: true }); context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
  context.drawImage(canvas, 0, top, canvas.width, canvas.height - top, 0, 0, width, height);
  if (threshold) {
    const frame = context.getImageData(0, 0, width, height);
    for (let i = 0; i < frame.data.length; i += 4) { const grey = .299 * frame.data[i] + .587 * frame.data[i + 1] + .114 * frame.data[i + 2]; const value = grey < 165 ? 0 : 255; frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = value; }
    context.putImageData(frame, 0, 0);
  }
  return output;
}
function printedPageCanvas(image) {
  const canvas = document.createElement('canvas'); const width = Math.min(2400, image.width * 2);
  canvas.width = width; canvas.height = Math.round(image.height * .53 * width / image.width);
  canvas.getContext('2d').drawImage(image, 0, image.height * .39, image.width, image.height * .53, 0, 0, canvas.width, canvas.height);
  return canvas;
}
async function ocrWorker() {
  if (!globalThis.Tesseract) throw new Error('The offline scanner is unavailable. Enter any missing passport details in the form.');
  if (!ocrWorkerPromise) {
    const local = path => new URL(path, location.href).href;
    ocrWorkerPromise = Tesseract.createWorker('eng', 1, { workerPath: local('vendor/worker.min.js'), corePath: local('vendor/tesseract-core'), langPath: local('vendor/lang'), workerBlobURL: false, cacheMethod: 'write' });
    ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
  }
  const worker = await ocrWorkerPromise;
  await worker.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' });
  return worker;
}
async function readPassport(person, notify = true) {
  if (!person?.passport?.data) { toast('Add a passport page first.'); return; }
  const previousStatus = person.ocrStatus || '';
  const previousMissing = person.scanMissing || [];
  const previousValues = person.scanValues || null;
  person.ocrStatus = 'Scanning passport locally…'; renderPeopleList(); if (selectedId === person.id) renderDetail();
  let extracted = {};
  try {
    const image = await loadImage(person.passport.data); const worker = await ocrWorker(); let bestText = '';
    outer: for (const angle of [0, 90, 270, 180]) {
      const oriented = orientedCanvas(image, angle);
      const variants = angle === 0 ? [[2.5, .22], [2.5, .30], [0, .22], [0, .30], [-2.5, .25], [2.5, .40]] : [[0, .25], [0, .40]];
      for (const [degrees, fraction] of variants) {
        const candidate = cropMrzCanvas(deskewCanvas(oriented, degrees), fraction, false);
        const result = await worker.recognize(candidate);
        const text = result.data.text || '';
        const fields = scanPassportFields(text);
        if (Object.keys(fields).length > Object.keys(extracted).length) { extracted = fields; bestText = text; }
        if (Object.keys(extracted).length === SCAN_FIELDS.length) break outer;
      }
    }
    try {
      await worker.setParameters({ tessedit_pageseg_mode: '11', tessedit_char_whitelist: '' });
      const printed = await worker.recognize(printedPageCanvas(image));
      const printedFields = scanPrintedPassportFields(printed.data.text || '', extracted);
      for (const [key, value] of Object.entries(printedFields)) if (!extracted[key]) extracted[key] = value;
    } catch { /* Keep independently verified machine-readable fields. */ }
    person.ocrText = bestText;
    person.scanConflicts = [];
    for (const [key, label] of [...SCAN_FIELDS, ...PRINTED_ONLY_FIELDS]) {
      const current = person.fields[key] || '';
      const wasScanned = previousValues ? previousValues[key] === current : previousStatus.startsWith('Scan filled') && !previousMissing.includes(label);
      if (!current || wasScanned) person.fields[key] = extracted[key] || '';
      else if (extracted[key] && extracted[key] !== current) person.scanConflicts.push(label);
    }
    person.scanValues = extracted;
    person.scanMissing = [...SCAN_FIELDS, ...PRINTED_ONLY_FIELDS].filter(([key]) => !person.fields[key]).map(([, label]) => label);
    person.ocrStatus = Object.keys(extracted).length ? `Scan read ${Object.keys(extracted).length} passport fields; check them against the image` : 'No passport details could be read; enter them in the form';
  } catch (error) {
    person.scanMissing = [...SCAN_FIELDS, ...PRINTED_ONLY_FIELDS].filter(([key]) => !person.fields[key]).map(([, label]) => label);
    person.ocrStatus = `Scan failed: ${error.message}`;
  }
  await persist(); render();
  if (notify) toast(person.scanMissing.length ? `Not extracted: ${person.scanMissing.join(', ')}. Fill these in the form.` : 'Passport details scanned. Check them against the image.');
}

function showAssignHeadshot() {
  const person = selectedPerson(); if (!person) return;
  const entries = state.unassigned.map(photo => `<button class="person-card" data-action="choose-headshot" data-photo="${escapeHtml(photo.id)}"><div class="card-top"><span class="avatar"><img src="${safeImageUrl(photo.data)}" alt=""></span><div><div class="card-name">${escapeHtml(photo.name)}</div><div class="card-meta">Tap to assign to ${escapeHtml(personName(person))}</div></div></div></button>`).join('');
  modal('Assign a headshot', `<p>Choose the correct picture for ${escapeHtml(personName(person))}. Face matching is deliberately manual.</p><div class="person-grid">${entries || '<div class="empty-panel">No unassigned headshots. Import some first.</div>'}</div>`, '<button class="button button-outline" data-action="headshot-import">Import headshots</button><button class="button button-subtle" data-action="close-modal">Close</button>', true);
}
async function assignHeadshot(id) {
  const person = selectedPerson(); const index = state.unassigned.findIndex(photo => photo.id === id); if (!person || index < 0) return;
  if (person.headshot) state.unassigned.push({ ...person.headshot, id: uid() });
  person.headshot = state.unassigned.splice(index, 1)[0]; person.preparedPhoto = null; person.fields.photo_match_note = 'Paired manually; confirm this is the applicant.';
  closeModal(); await persist(); render(); toast('Headshot assigned. Prepare a 35 × 45 mm copy next.');
}

function jpegWith300Dpi(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]); const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  for (let index = 0; index < Math.min(bytes.length - 18, 64); index++) {
    if (bytes[index] === 0xff && bytes[index + 1] === 0xe0 && String.fromCharCode(...bytes.slice(index + 4, index + 9)) === 'JFIF\0') {
      bytes[index + 11] = 1; bytes[index + 12] = 1; bytes[index + 13] = 0x2c; bytes[index + 14] = 1; bytes[index + 15] = 0x2c; break;
    }
  }
  let encoded = ''; for (const byte of bytes) encoded += String.fromCharCode(byte);
  return `data:image/jpeg;base64,${btoa(encoded)}`;
}
function cropBox(image, horizontal, vertical) {
  const ratio = 35 / 45; let width, height;
  if (image.width / image.height > ratio) { height = image.height; width = Math.round(height * ratio); }
  else { width = image.width; height = Math.round(width / ratio); }
  return { left: Math.round((image.width - width) * horizontal), top: Math.round((image.height - height) * vertical), width, height };
}
async function showPhotoCrop() {
  const person = selectedPerson(); if (!person?.headshot?.data) { toast('Assign a headshot first.'); return; }
  const image = await loadImage(person.headshot.data);
  modal('Prepare 35 × 45 mm photo', `<p>Move the crop until the face and shoulders are fully visible. The prepared copy is separate from the original.</p><div class="crop-frame"><canvas id="cropCanvas" width="280" height="360"></canvas></div><div class="slider-field"><label for="cropX">Left / right</label><input id="cropX" type="range" min="0" max="100" value="50"></div><div class="slider-field"><label for="cropY">Up / down</label><input id="cropY" type="range" min="0" max="100" value="50"></div><p>Output: 413 × 531 pixel JPEG, tagged 300 dpi. The website’s file-size limit still needs confirmation.</p>`, '<button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-primary" id="saveCropBtn">Save prepared copy</button>', true);
  const redraw = () => { const box = cropBox(image, Number($('#cropX').value) / 100, Number($('#cropY').value) / 100); const canvas = $('#cropCanvas'); const context = canvas.getContext('2d'); context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(image, box.left, box.top, box.width, box.height, 0, 0, canvas.width, canvas.height); };
  $('#cropX').addEventListener('input', redraw); $('#cropY').addEventListener('input', redraw); redraw();
  $('#saveCropBtn').addEventListener('click', async () => {
    const box = cropBox(image, Number($('#cropX').value) / 100, Number($('#cropY').value) / 100);
    const canvas = document.createElement('canvas'); canvas.width = 413; canvas.height = 531;
    canvas.getContext('2d').drawImage(image, box.left, box.top, box.width, box.height, 0, 0, 413, 531);
    const data = jpegWith300Dpi(canvas.toDataURL('image/jpeg', 0.9));
    const name = `${safeFilename(personName(person))}_35x45.jpg`;
    person.preparedPhoto = { name, data, width: 413, height: 531, sizeKB: Math.round(data.length * 0.75 / 1024) };
    closeModal(); await persist(); render(); toast(`Prepared ${name} (${person.preparedPhoto.sizeKB} KB). Check the crop before upload.`);
  });
}

function addPerson() { const person = makePerson(); state.people.push(person); selectPerson(person.id); persist(); toast('New applicant added.'); }
async function removePerson() { const person = selectedPerson(); if (!person || !confirm(`Remove ${personName(person)} from current applicants?`)) return; state.people = state.people.filter(item => item.id !== person.id); selectedId = state.people[0]?.id || null; await persist(); render(); }
async function duplicatePerson(source = selectedPerson()) { if (!source) return; const person = normalizePerson(structuredClone(source)); person.id = uid(); person.createdAt = new Date().toISOString(); person.fields.arrival_date = ''; person.fields.flight_number = ''; person.ocrStatus = 'Reused details; verify current passport and photo'; state.people.push(person); selectedId = person.id; await persist(); render(); showView('applicants'); toast('New draft created from saved details.'); }
async function renameFiles() { const person = selectedPerson(); if (!person) return; const base = safeFilename(personName(person)); for (const [key, suffix] of [['passport', 'passport'], ['headshot', 'headshot'], ['preparedPhoto', '35x45']]) if (person[key]) person[key].name = `${base}_${suffix}.${person[key].data?.startsWith('data:image/png') ? 'png' : 'jpg'}`; await persist(); render(); toast('Document labels renamed in this app. Downloaded copies use these names.'); }
async function markSubmitted() { const person = selectedPerson(); if (!person) return; const reference = prompt('Enter the official application reference, if you have one. Leave blank if unavailable.'); if (reference === null) return; state.history.push({ id: uid(), submittedAt: new Date().toISOString(), reference: reference.trim(), snapshot: structuredClone(person) }); await persist(); render(); showView('history'); toast('Submission recorded locally.'); }
async function exportBackup() {
  if (!globalThis.crypto?.subtle) { toast('Encrypted backups require HTTPS or localhost. Open the GitHub Pages address on your phone.'); return; }
  modal('Export encrypted backup', '<p>Choose a passphrase of at least 12 characters. You will need it to import this file on another device. It is never saved by the app.</p><div class="field"><label for="backupPass">Passphrase</label><input id="backupPass" type="password" autocomplete="new-password"></div><div class="field"><label for="backupPassConfirm">Confirm passphrase</label><input id="backupPassConfirm" type="password" autocomplete="new-password"></div>', '<button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-primary" data-action="create-encrypted-backup">Download encrypted backup</button>');
}
async function createEncryptedBackup() {
  const passphrase = $('#backupPass').value;
  if (passphrase !== $('#backupPassConfirm').value) { toast('Passphrases do not match.'); return; }
  await persist();
  const envelope = await encryptBackup(JSON.stringify({ app: 'Visa Desk', version: 1, exportedAt: new Date().toISOString(), workspace: state }), passphrase);
  download(`visa-desk-backup-${new Date().toISOString().slice(0, 10)}.encrypted.json`, JSON.stringify(envelope));
  closeModal(); toast('Encrypted backup downloaded. Keep the passphrase separately.');
}
function safeImageUrl(value) { return /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value || '') ? value : ''; }
function cleanDocument(value) { if (!value || typeof value !== 'object') return null; const data = safeImageUrl(value.data); return data ? { ...value, name: String(value.name || 'image').slice(0, 200), data } : null; }
async function importBackup(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    if (payload.format === 'visa-desk-encrypted-v1') {
      pendingEncryptedBackup = payload;
      modal('Unlock encrypted backup', '<p>Enter the passphrase used when this backup was exported.</p><div class="field"><label for="unlockPass">Backup passphrase</label><input id="unlockPass" type="password" autocomplete="off"></div>', '<button class="button button-outline" data-action="close-modal">Cancel</button><button class="button button-primary" data-action="unlock-backup">Unlock and import</button>');
      return;
    }
    await applyBackupPayload(payload);
  } catch (error) { toast(`Backup import failed: ${error.message}`); }
}
async function unlockBackup() {
  if (!pendingEncryptedBackup) return;
  try { const payload = JSON.parse(await decryptBackup(pendingEncryptedBackup, $('#unlockPass').value)); await applyBackupPayload(payload); pendingEncryptedBackup = null; closeModal(); }
  catch (error) { toast(`Backup import failed: ${error.message}`); }
}
async function applyBackupPayload(payload) {
  try {
    const incoming = payload.workspace || payload;
    if (!Array.isArray(incoming.people) || !Array.isArray(incoming.history)) throw new Error('This is not a Visa Desk backup.');
    if (state.people.length && !confirm('Replace current applicants and history with this backup? Export your current data first if needed.')) return;
    state = blankState(); state.defaults = { ...DEFAULTS, ...(incoming.defaults || {}) };
    state.people = incoming.people.map(raw => { const person = normalizePerson(raw); person.passport = cleanDocument(raw.passport); person.headshot = cleanDocument(raw.headshot); person.preparedPhoto = cleanDocument(raw.preparedPhoto); return person; });
    state.history = incoming.history.filter(item => item?.snapshot?.fields).map(item => ({ id: String(item.id || uid()), submittedAt: String(item.submittedAt || new Date().toISOString()), reference: String(item.reference || ''), snapshot: { ...normalizePerson(item.snapshot), passport: cleanDocument(item.snapshot.passport), headshot: cleanDocument(item.snapshot.headshot), preparedPhoto: cleanDocument(item.snapshot.preparedPhoto) } }));
    state.unassigned = (incoming.unassigned || []).map(cleanDocument).filter(Boolean).map(item => ({ ...item, id: item.id || uid() }));
    selectedId = state.people[0]?.id || null; await persist(); render(); showView('overview'); toast(`Imported ${state.people.length} applicants and ${state.history.length} history records.`);
  } catch (error) { toast(`Backup import failed: ${error.message}`); }
}
async function applyDefaults() { if (!confirm('Apply shared details to every current applicant? This replaces their contact, travel, address and work fields.')) return; for (const person of state.people) for (const [group, key] of FIELDS) if (SHARED_GROUPS.has(group)) person.fields[key] = state.defaults[key] || ''; await persist(); render(); toast('Shared details applied to current applicants.'); }
function downloadPhoto() { const photo = selectedPerson()?.preparedPhoto; if (!photo) return; fetch(photo.data).then(response => response.blob()).then(blob => download(photo.name, blob, 'image/jpeg')); }
function setBusy(button, busy) { if (button) button.disabled = busy; }
async function handleAction(action, element) {
  if (action === 'add-person') addPerson();
  else if (action === 'remove-person') await removePerson();
  else if (action === 'reuse-person') await duplicatePerson();
  else if (action === 'rename-files') await renameFiles();
  else if (action === 'mark-submitted') await markSubmitted();
  else if (action === 'backup-export') await exportBackup();
  else if (action === 'create-encrypted-backup') await createEncryptedBackup();
  else if (action === 'backup-import') $('#backupInput').click();
  else if (action === 'unlock-backup') await unlockBackup();
  else if (action === 'passport-import') $('#passportInput').click();
  else if (action === 'headshot-import') $('#headshotInput').click();
  else if (action === 'replace-passport') { $('#passportInput').dataset.replace = selectedId || ''; $('#passportInput').click(); }
  else if (action === 'read-passport') { setBusy(element, true); await readPassport(selectedPerson()); setBusy(element, false); }
  else if (action === 'assign-headshot') showAssignHeadshot();
  else if (action === 'choose-headshot') await assignHeadshot(element.dataset.photo);
  else if (action === 'prepare-photo') await showPhotoCrop();
  else if (action === 'download-photo') downloadPhoto();
  else if (action === 'download-passport') { const passport = selectedPerson()?.passport; if (passport) fetch(passport.data).then(response => response.blob()).then(blob => download(passport.name, blob, 'image/jpeg')); }
  else if (action === 'close-modal') closeModal();
  else if (action === 'open-official') window.open(ETA_URL, '_blank', 'noopener');
  else if (action === 'reuse-history') { const item = state.history.find(x => x.id === element.dataset.history); if (item) await duplicatePerson(item.snapshot); }
  else if (action === 'delete-history') { const item = state.history.find(x => x.id === element.dataset.history); if (item && confirm(`Delete the saved history for ${personName(item.snapshot)}?`)) { state.history = state.history.filter(x => x.id !== item.id); await persist(); render(); } }
}
async function init() {
  try { const saved = await loadWorkspace(); if (saved) { state = { ...blankState(), ...saved, defaults: { ...DEFAULTS, ...(saved.defaults || {}) } }; state.people = (state.people || []).map(normalizePerson); state.history ||= []; state.unassigned ||= []; await saveWorkspace(state); } $('#storageStatus').textContent = 'Saved on this device'; }
  catch (error) { $('#storageStatus').textContent = 'Storage unavailable'; toast(`Local storage failed: ${error.message}`); }
  navigator.storage?.persist?.().catch(() => {});
  selectedId = state.people[0]?.id || null; render();
  document.addEventListener('click', async event => { const view = event.target.closest('[data-view]'); if (view) { showView(view.dataset.view); return; } const person = event.target.closest('[data-select]'); if (person) { selectPerson(person.dataset.select); return; } const action = event.target.closest('[data-action]'); if (action) { try { await handleAction(action.dataset.action, action); } catch (error) { toast(error.message); } } });
  document.addEventListener('input', event => { if (event.target.id === 'peopleSearch') renderPeopleList(); if (event.target.matches('[data-field]')) { const person = selectedPerson(); if (person) { person.fields[event.target.dataset.field] = event.target.value; scheduleSave(); renderOverview(); renderPeopleList(); } } });
  document.addEventListener('change', event => { if (event.target.matches('[data-field]')) { const person = selectedPerson(); if (person) { person.fields[event.target.dataset.field] = event.target.value; scheduleSave(); renderDetail(); renderOverview(); renderPeopleList(); } } });
  $('#passportInput').addEventListener('change', async event => { const files = [...event.target.files]; const replaceId = event.target.dataset.replace; event.target.value = ''; delete event.target.dataset.replace; if (replaceId && files.length === 1) { const person = state.people.find(x => x.id === replaceId); if (person) { const file = files[0]; const docs = file.type === 'application/pdf' || /\.pdf$/i.test(file.name) ? await pdfPages(file) : [{ name: file.name, data: await readFileAsDataUrl(file) }]; person.passport = docs[0]; await persist(); render(); await readPassport(person); } } else await importPassports(files); });
  $('#headshotInput').addEventListener('change', async event => { const files = [...event.target.files]; event.target.value = ''; await importHeadshots(files); });
  $('#backupInput').addEventListener('change', async event => { const file = event.target.files[0]; event.target.value = ''; await importBackup(file); });
  $('#exportBackupBtn').addEventListener('click', exportBackup);
  $('#saveDefaultsBtn').addEventListener('click', async () => { document.querySelectorAll('[data-default-field]').forEach(input => state.defaults[input.dataset.defaultField] = input.value); await persist(); toast('Shared defaults saved for new applicants.'); });
  $('#applyDefaultsBtn').addEventListener('click', async () => { document.querySelectorAll('[data-default-field]').forEach(input => state.defaults[input.dataset.defaultField] = input.value); await applyDefaults(); });
}
init();
