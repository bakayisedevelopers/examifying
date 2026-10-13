import test from 'node:test';
import assert from 'node:assert/strict';
import { getPaystackCustomerDetails } from './paystackCustomerDetails.js';

test('builds Paystack customer fields from the authenticated payer profile', () => {
  assert.deepEqual(getPaystackCustomerDetails({
    profile: { displayName: ' Ada   Lovelace Byron ', whatsappNumber: '+27 82 123 4567' },
  }), {
    firstName: 'Ada',
    lastName: 'Lovelace Byron',
    phone: '+27 82 123 4567',
    fullName: 'Ada Lovelace Byron',
  });
});

test('uses auth claims and available phone fields when the profile is incomplete', () => {
  assert.deepEqual(getPaystackCustomerDetails({
    profile: { phoneNumber: '+27 11 555 0100' },
    authName: 'Sam Student',
  }), {
    firstName: 'Sam',
    lastName: 'Student',
    phone: '+27 11 555 0100',
    fullName: 'Sam Student',
  });
});

test('omits unavailable name and phone fields instead of sending empty customer values', () => {
  assert.deepEqual(getPaystackCustomerDetails({ profile: {} }), {});
});
