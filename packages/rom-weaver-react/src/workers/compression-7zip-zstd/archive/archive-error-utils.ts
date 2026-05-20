const ENCRYPTED_ARCHIVE_ERROR_REGEX = /passphrase|password|encrypt/i;

const isEncryptionUnsupportedError = (err: RuntimeValue) => {
  const message = err && typeof err === "object" && "message" in err ? String(err.message) : String(err);
  return ENCRYPTED_ARCHIVE_ERROR_REGEX.test(message);
};

export { isEncryptionUnsupportedError };
