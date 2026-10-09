"use client";

import { AllCommunityModule, ModuleRegistry, themeQuartz, type GridOptions } from "ag-grid-community";
import { AgGridReact, type AgGridReactProps } from "ag-grid-react";

ModuleRegistry.registerModules([AllCommunityModule]);

/** Thème Ag Grid aligné sur le backoffice (voir backoffice.css). */
const theme = themeQuartz.withParams({
  accentColor: "#c2410c",
  backgroundColor: "#ffffff",
  foregroundColor: "#1d1d1f",
  borderColor: "#e8e8ed",
  headerBackgroundColor: "#ffffff",
  headerTextColor: "#5f5f66",
  headerFontWeight: 600,
  headerFontSize: 12.5,
  fontFamily: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "Helvetica Neue", "Arial", "sans-serif"],
  fontSize: 14,
  rowHeight: 52,
  headerHeight: 44,
  wrapperBorderRadius: 20,
  wrapperBorder: { color: "#e8e8ed" },
  rowBorder: { color: "#f0f0f3" },
  columnBorder: false,
  rowHoverColor: "#fafafa",
  selectedRowBackgroundColor: "#fff1e6",
  spacing: 8,
  cellHorizontalPaddingScale: 1,
});

/** Textes de la grille en français. */
const localeText: GridOptions["localeText"] = {
  noRowsToShow: "Aucune ligne",
  loadingOoo: "Chargement…",
  page: "Page",
  of: "sur",
  to: "à",
  more: "plus",
  next: "Suivante",
  last: "Dernière",
  first: "Première",
  previous: "Précédente",
  pageSizeSelectorLabel: "Lignes par page :",
  filterOoo: "Filtrer…",
  equals: "Égal à",
  notEqual: "Différent de",
  contains: "Contient",
  notContains: "Ne contient pas",
  startsWith: "Commence par",
  endsWith: "Se termine par",
  blank: "Vide",
  notBlank: "Non vide",
  andCondition: "ET",
  orCondition: "OU",
  ariaLabelColumnMenu: "Menu de la colonne",
  ariaSortableColumn: "Appuyez sur Entrée pour trier",
};

export function DataGrid<T>({ label, ...props }: AgGridReactProps<T> & { label: string }) {
  return (
    <div className="bo-grid" role="region" aria-label={label}>
      <AgGridReact<T>
        theme={theme}
        localeText={localeText}
        domLayout="autoHeight"
        suppressCellFocus={false}
        ensureDomOrder
        animateRows={false}
        {...props}
      />
    </div>
  );
}
