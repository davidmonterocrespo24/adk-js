/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

type ProcessExitListener = () => void | Promise<void>;

/**
 * Subscribes to process exit and cleanup events.
 *
 * @param listener - The listener to be called when process exits or cleanup is triggered.
 */
export function subscribeOnProcessExit(listener: ProcessExitListener): void {
  const exitHandler = async ({
    exit,
    cleanup,
  }: {
    exit?: boolean;
    cleanup?: boolean;
  }) => {
    if (cleanup) {
      await listener();
    }

    if (exit) {
      process.exit();
    }
  };

  process.on('exit', () => exitHandler({cleanup: true}));
  process.on('SIGINT', () => exitHandler({exit: true}));
  process.on('SIGUSR1', () => exitHandler({exit: true}));
  process.on('SIGUSR2', () => exitHandler({exit: true}));
  process.on('uncaughtException', () => exitHandler({exit: true}));
}
