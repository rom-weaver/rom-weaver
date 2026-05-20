const encodeText = (text: string | number | boolean | null | undefined): Uint8Array => {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(String(text));
  return Uint8Array.from(String(text), (char) => char.charCodeAt(0) & 0xff);
};

export { encodeText };
