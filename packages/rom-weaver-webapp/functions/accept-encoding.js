export const acceptsBrotli = (header) =>
  String(header || "")
    .split(",")
    .some((entry) => {
      const [encoding, ...parameters] = entry.trim().toLowerCase().split(";");
      if (encoding !== "br") return false;
      const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
      if (!quality) return true;
      const value = Number(quality.trim().slice(2));
      return Number.isFinite(value) && value > 0;
    });
