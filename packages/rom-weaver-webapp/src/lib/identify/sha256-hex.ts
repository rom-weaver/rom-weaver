/** Lowercase hex SHA-256 of a byte buffer, via WebCrypto. */
const sha256Hex = async (bytes: ArrayBuffer): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

export { sha256Hex };
