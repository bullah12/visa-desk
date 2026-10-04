const VALUES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ<';

export function mrzDigit(value) {
  const weights = [7, 3, 1];
  let total = 0;
  for (let i = 0; i < value.length; i++) {
    const n = VALUES.indexOf(value[i]);
    if (n < 0) throw new Error('Invalid MRZ character');
    total += n * weights[i % 3];
  }
  return String(total % 10);
}

function mrzDate(value, expiry = false) {
  const yy = Number(value.slice(0, 2));
  const mm = Number(value.slice(2, 4));
  const dd = Number(value.slice(4, 6));
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd)) throw new Error('Unreadable MRZ date');
  let year;
  if (expiry) {
    const now = new Date().getFullYear();
    const options = [1900 + yy, 2000 + yy];
    year = options.sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0];
  } else {
    const currentYY = new Date().getFullYear() % 100;
    year = yy <= currentYY ? 2000 + yy : 1900 + yy;
  }
  const result = new Date(Date.UTC(year, mm - 1, dd));
  if (result.getUTCFullYear() !== year || result.getUTCMonth() !== mm - 1 || result.getUTCDate() !== dd) throw new Error('Invalid MRZ date');
  return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

export function parsePassportMrz(text) {
  const lines = text.toUpperCase().split(/\r?\n/).map(line => line.replace(/[^A-Z0-9<]/g, '')).filter(Boolean);
  let lastError = 'Two readable passport MRZ lines were not found.';
  for (let index = 0; index < lines.length - 1; index++) {
    const first = lines[index];
    const second = lines[index + 1];
    if (!first.startsWith('P<') || first.length < 20 || second.length !== 44) continue;
    const checks = [[second.slice(0, 9), second[9]], [second.slice(13, 19), second[19]], [second.slice(21, 27), second[27]]];
    if (!checks.every(([value, digit]) => mrzDigit(value) === digit)) { lastError = 'MRZ check digits failed. Check the passport number and dates.'; continue; }
    const nameParts = first.slice(5).split('<<');
    const surname = nameParts[0]?.replaceAll('<', ' ').trim();
    const given = nameParts[1]?.split(/<{2,}/)[0].replaceAll('<', ' ').trim();
    if (!surname || !given || given.split(' ').some(token => token.length === 1)) { lastError = 'The MRZ name is unclear. Enter it manually.'; continue; }
    try {
      return {
        first_names: given,
        surname,
        passport_number: second.slice(0, 9).replaceAll('<', ''),
        nationality: second.slice(10, 13) === 'GBR' ? 'British' : second.slice(10, 13),
        date_of_birth: mrzDate(second.slice(13, 19)),
        sex: second[20] === 'M' ? 'Male' : second[20] === 'F' ? 'Female' : 'Unspecified',
        expiry_date: mrzDate(second.slice(21, 27), true),
      };
    } catch (error) { lastError = error.message; }
  }
  throw new Error(lastError);
}

// Accept independently verified values when OCR has only part of the passport lines.
// An unreadable value is never guessed from neighbouring text.
export function scanPassportFields(text) {
  const lines = text.toUpperCase().split(/\r?\n/).map(line => line.replace(/[^A-Z0-9<]/g, '')).filter(Boolean);
  const fields = {};
  const first = lines.find(line => line.startsWith('P<GBR') && line.length >= 20);
  const secondRaw = first ? lines.slice(lines.indexOf(first) + 1).find(line => line.length >= 40 && line.length <= 46 && /^[A-Z0-9<]{9}[0-9]GBR/.test(line)) : null;
  const second = secondRaw?.slice(0, 44).padEnd(44, '<');
  const verified = (start, end, digit) => { try { return !!second && mrzDigit(second.slice(start, end)) === second[digit]; } catch { return false; } };
  if (first && second && (verified(0, 9, 9) || verified(13, 19, 19) || verified(21, 27, 27))) {
    const parts = first.slice(5).split('<<');
    const surname = parts[0]?.replaceAll('<', ' ').trim();
    const given = parts[1]?.split(/<{2,}/)[0].replaceAll('<', ' ').trim();
    if (surname && /^[A-Z][A-Z ]+$/.test(surname)) fields.surname = surname;
    if (given && /^[A-Z][A-Z ]+$/.test(given)) fields.first_names = given;
  }
  if (second) {
    if (verified(0, 9, 9)) fields.passport_number = second.slice(0, 9).replaceAll('<', '');
    const nationality = second.slice(10, 13);
    if (/^[A-Z]{3}$/.test(nationality)) fields.nationality = nationality === 'GBR' ? 'British' : nationality;
    if (verified(13, 19, 19)) { try { fields.date_of_birth = mrzDate(second.slice(13, 19)); } catch { /* leave blank */ } }
    if (second[20] === 'M' || second[20] === 'F') fields.sex = second[20] === 'M' ? 'Male' : 'Female';
    if (verified(21, 27, 27)) { try { fields.expiry_date = mrzDate(second.slice(21, 27), true); } catch { /* leave blank */ } }
  }
  return fields;
}

export function scanPrintedPassportFields(text, known = {}) {
  const lines = text.toUpperCase().split(/\r?\n/).map(line => line.replace(/[^A-Z0-9/ ]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const fields = {};
  const section = (start, end) => {
    const a = lines.findIndex(line => start.test(line));
    if (a < 0) return [];
    const b = lines.findIndex((line, index) => index > a && end.test(line));
    return lines.slice(a + 1, b < 0 ? a + 9 : b);
  };
  const givenLines = section(/GIVEN NAMES|PRENOMS/, /NATIONALITY|NATIONALITE/);
  const names = givenLines.filter(line => /^[A-Z]+(?: [A-Z]+){0,3}$/.test(line) && line.replaceAll(' ', '').length >= 4 && line !== known.surname && !/^(YEN|YES|CITIZEN|BRITISH|PASSPORT)$/.test(line));
  if (names.length) fields.first_names = names.sort((a, b) => b.replaceAll(' ', '').length - a.replaceAll(' ', '').length)[0];
  const birthLines = section(/PLACE OF BIRTH|LIEU/, /DATE OF ISSUE|DATE DE DELIVRANCE/);
  const places = birthLines.filter(line => /^[A-Z]+(?: [A-Z]+){0,2}$/.test(line) && line.replaceAll(' ', '').length >= 4 && !/PLACE|BIRTH|SEXE|DATE|NAISSANCE|LIEU/.test(line));
  if (places.length) fields.place_of_birth = places.sort((a, b) => b.length - a.length)[0];
  const issueLines = section(/DATE OF ISSUE|DATE DE DELIVRANCE/, /DATE OF EXPIRY|DATE D EXPIRATION/);
  const issueText = issueLines.join(' ');
  const date = issueText.match(/\b(\d{1,2}) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?: \/ ?[A-Z]{3,5})? (\d{2})\b/);
  if (date) {
    const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(date[2]) + 1;
    const year = 2000 + Number(date[3]);
    const value = new Date(Date.UTC(year, month - 1, Number(date[1])));
    if (year <= new Date().getFullYear() && value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === Number(date[1])) fields.issue_date = `${year}-${String(month).padStart(2, '0')}-${String(date[1]).padStart(2, '0')}`;
  }
  if (/\bHMPO\b/.test(issueText)) fields.issuing_authority = 'HMPO';
  return fields;
}
