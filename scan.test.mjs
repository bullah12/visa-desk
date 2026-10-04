import test from 'node:test';
import assert from 'node:assert/strict';
import { mrzDigit, scanPassportFields, scanPrintedPassportFields } from './mrz.mjs';

function machineLines(numberDigit = null) {
  const number = '123456789', birth = '980810', expiry = '340913';
  const second = (number + (numberDigit ?? mrzDigit(number)) + 'GBR' + birth + mrzDigit(birth) + 'M' + expiry + mrzDigit(expiry)).padEnd(44, '<');
  return `P<GBRSMITH<<JANE<ELIZABETH<<<<<<<<<<<<\n${second}`;
}

test('passport scan fills independently checked values', () => {
  const fields = scanPassportFields(machineLines());
  assert.equal(fields.passport_number, '123456789');
  assert.equal(fields.date_of_birth, '1998-08-10');
  assert.equal(fields.expiry_date, '2034-09-13');
  assert.equal(fields.first_names, 'JANE ELIZABETH');
});

test('bad check digit leaves only that value blank', () => {
  const fields = scanPassportFields(machineLines('0'));
  assert.equal(fields.passport_number, undefined);
  assert.equal(fields.date_of_birth, '1998-08-10');
});

test('stray machine-readable-looking name is rejected without a verified value', () => {
  const fields = scanPassportFields('P<GBRCSSS<<<<<<<<<<<<<<<<<<<<<<<<<<<<\n1234567890GBR<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<');
  assert.equal(fields.first_names, undefined);
});

test('printed passport fields are read from their labelled sections', () => {
  const text = ['Given names/Prénoms (2)', 'SMITH', 'JANE ELIZABETH', 'Nationality/Nationalite (3)', 'BRITISH CITIZEN', 'Sex/Sexe (5) Place of birth/Lieu', 'de naissance (6)', 'F', 'LEEDS', 'Date of issue/Date de delivrance (7)', 'Authority/Autorite (8)', '13 SEP /SEPT 24 HMPO', 'Date of expiry/Date d’expiration (9)'].join('\n');
  const fields = scanPrintedPassportFields(text, { surname: 'SMITH' });
  assert.deepEqual(fields, { first_names: 'JANE ELIZABETH', place_of_birth: 'LEEDS', issue_date: '2024-09-13', issuing_authority: 'HMPO' });
});
