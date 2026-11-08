/** Menegakkan aturan arsitektur #1 di CLAUDE.md. */
module.exports = {
  forbidden: [
    {
      name: "core-tidak-impor-modul",
      comment: "packages/core tidak boleh bergantung pada modul.",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: { path: "^packages/modules/" },
    },
    {
      name: "modul-tidak-impor-modul-lain",
      comment: "Modul hanya boleh mengimpor core (dan db/config), bukan modul lain.",
      severity: "error",
      from: { path: "^packages/modules/([^/]+)/" },
      to: { path: "^packages/modules/([^/]+)/", pathNot: "^packages/modules/$1/" },
    },
    {
      name: "modul-tidak-impor-paket-modul-lain",
      comment: "Cegah impor lewat nama paket @jadwalin/module-*.",
      severity: "error",
      from: { path: "^packages/modules/([^/]+)/" },
      to: { path: "node_modules/@jadwalin/module-" },
    },
    {
      name: "core-tidak-impor-modul-via-paket",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: { path: "node_modules/@jadwalin/module-" },
    },
    {
      name: "app-tidak-impor-app-lain",
      comment: "apps hanya boleh bergantung pada packages, bukan pada app lain.",
      severity: "error",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" },
    },
    {
      name: "packages-tidak-impor-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
  },
};
