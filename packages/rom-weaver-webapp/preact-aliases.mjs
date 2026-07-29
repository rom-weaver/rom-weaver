const createPreactAliases = (reactReplacement = "preact/compat") => [
  { find: /^react\/jsx-dev-runtime$/, replacement: "preact/jsx-dev-runtime" },
  { find: /^react\/jsx-runtime$/, replacement: "preact/jsx-runtime" },
  { find: /^react-dom\/client$/, replacement: "preact/compat/client" },
  { find: /^react-dom\/server$/, replacement: "preact/compat/server" },
  { find: /^react-dom$/, replacement: "preact/compat" },
  { find: /^react$/, replacement: reactReplacement },
];

export { createPreactAliases };
