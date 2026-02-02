/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {FunctionTool} from '@google/adk';
import * as crypto from 'node:crypto';
import zod from 'zod';

function hashObject(obj: unknown) {
  const sortedJsonString = JSON.stringify(obj);

  const hash = crypto
    .createHash('sha256')
    .update(sortedJsonString)
    .digest('hex');

  const numberHash = parseInt(hash.substring(0, 8), 16);

  return numberHash;
}

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

function validateEmail(email: string): boolean {
  return emailRegex.test(email);
}

export const validate_email = new FunctionTool({
  name: 'validate_email',
  description: 'Checks if the provided string is a valid email format.',
  parameters: zod.object({
    email: zod.email(),
  }),
  execute: ({email}: {email: string}) => {
    return validateEmail(email);
  },
});

export const get_user_id = new FunctionTool({
  name: 'get_user_id',
  description: 'Retrieves a user ID based on their email',
  parameters: zod.object({
    email: zod.email(),
  }),
  execute: ({email}: {email: string}) => {
    if (!validateEmail(email)) {
      throw new Error('Invalid email format provided.');
    }
    // Simple hash for testing purposes
    return Math.abs(hashObject(email)) % 10000;
  },
});

export const create_booking = new FunctionTool({
  name: 'create_booking',
  description: 'Creates a booking for a user.',
  parameters: zod.object({
    userId: zod.number(),
    isConfirmed: zod.boolean(),
    details: zod.string(),
  }),
  execute: ({userId, isConfirmed, details}) => ({
    'user_id': userId,
    'is_confirmed': isConfirmed,
    'details': details,
    'user_id_type': typeof userId,
    'is_confirmed_type': typeof isConfirmed,
    'details_type': typeof details,
  }),
});
