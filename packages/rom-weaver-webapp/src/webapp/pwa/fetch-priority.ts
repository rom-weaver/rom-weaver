const prioritizePrecacheInstallRequest = (request: Request, event: Pick<Event, "type">) => {
  if (event.type !== "install") return request;
  return new Request(request, { priority: "low" } as RequestInit);
};

export { prioritizePrecacheInstallRequest };
