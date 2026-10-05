const pathForTar = (filename, platform, convertWindowsPath = (value) => value) =>
  platform === "win32" ? convertWindowsPath(filename) : filename;

export { pathForTar };
