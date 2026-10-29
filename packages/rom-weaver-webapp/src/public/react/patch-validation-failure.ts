export const isPatchFileChecksumFailure = (message: string): boolean =>
  /(?:^|:\s*)patch checksum invalid;/i.test(message.trim());
