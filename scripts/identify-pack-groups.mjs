const compareText = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const safeGroupId = (value) =>
  typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(value) ? value : undefined;

const groupDefinitions = (index) => {
  const values = Array.isArray(index.groups)
    ? index.groups
    : Array.isArray(index.packGroups)
      ? index.packGroups
      : [];
  return values.flatMap((value) => {
    const id = safeGroupId(value?.id);
    if (!id) return [];
    return [
      {
        default: value.default === true || value.includedByDefault === true,
        id,
        label: typeof value.label === "string" && value.label ? value.label : id,
        systems: Array.isArray(value.systems)
          ? value.systems.filter((slug) => typeof slug === "string")
          : [],
      },
    ];
  });
};

export const resolveIdentifyPackGroups = (index) => {
  const systems = Array.isArray(index?.systems) ? index.systems : [];
  const declared = groupDefinitions(index || {});
  const groupById = new Map(
    declared.map((group) => [group.id, { ...group, systems: new Set(group.systems) }]),
  );
  const assignments = new Map();

  for (const system of systems) {
    const explicitId = safeGroupId(system.group ?? system.packGroup);
    const declaredGroup = declared.find((group) => group.systems.includes(system.slug));
    const groupId = explicitId ?? declaredGroup?.id ?? "default";
    const isDefault =
      system.default === true || system.defaultPack === true || system.includedByDefault === true;
    const group = groupById.get(groupId) ?? {
      default: groupId === "default" || isDefault,
      id: groupId,
      label: groupId === "default" ? "Built-in systems" : groupId,
      systems: new Set(),
    };
    group.systems.add(system.slug);
    if (isDefault) group.default = true;
    groupById.set(groupId, group);
    assignments.set(system.slug, groupId);
  }

  const groups = [...groupById.values()]
    .filter((group) => group.systems.size > 0)
    .map((group) => ({ ...group, systems: [...group.systems].sort(compareText) }))
    .sort((left, right) => compareText(left.id, right.id));
  const defaultGroupIds = new Set(groups.filter((group) => group.default).map((group) => group.id));
  return {
    assignments,
    groups,
    defaultSystems: systems.filter((system) => defaultGroupIds.has(assignments.get(system.slug))),
  };
};
