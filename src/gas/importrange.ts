export const IMPORTRANGE_FIRST_ARG_REGEX = /IMPORTRANGE\s*\(\s*["']([^"']+)["']/i;
export const IMPORTRANGE_BOTH_ARGS_REGEX_G =
  /IMPORTRANGE\s*\(\s*["']([^"']+)["'][^,]*,\s*["']([^"']+)["']/gi;
export const IMPORTRANGE_CELL_REF_REGEX =
  /IMPORTRANGE\s*\(\s*((?:'[^']+'|[A-Za-z0-9_]+)!)?(\$?[A-Za-z]+\$?[0-9]+)\s*,/i;

export function extractSpreadsheetId(rawArg: string): string | null {
  const urlMatch = rawArg.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(rawArg.trim())) return rawArg.trim();
  return null;
}

export function convertUrlsToIds(rawArgs: string[]): string[] {
  const ids = rawArgs
    .map((rawArg) => {
      const urlMatch = rawArg.match(/\/d\/([a-zA-Z0-9-_]+)/);
      if (urlMatch) return urlMatch[1];
      if (/^[a-zA-Z0-9-_]{20,}$/.test(rawArg.trim())) return rawArg.trim();
      return null;
    })
    .filter((id): id is string => id !== null);
  return [...new Set(ids)];
}

interface SheetGridCell {
  formattedValue?: string;
  userEnteredValue?: { formulaValue?: string };
}

interface SheetsApiResponse {
  sheets?: Array<{
    properties: { title: string };
    data?: Array<{
      rowData?: Array<{ values?: SheetGridCell[] }>;
    }>;
  }>;
}

function columnToLetter(col: number): string {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

export async function detectImportRanges(params: {
  spreadsheetId: string;
  accessToken: string;
}): Promise<
  Array<{
    cellAddress: string;
    sheetName: string;
    rawArg: string;
    sourceId: string | null;
    displayValue: string;
  }>
> {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${params.spreadsheetId}?includeGridData=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Sheets API error: ${res.status}`);
  }

  const data = (await res.json()) as SheetsApiResponse;
  const results: Array<{
    cellAddress: string;
    sheetName: string;
    rawArg: string;
    sourceId: string | null;
    displayValue: string;
  }> = [];

  for (const sheet of data.sheets ?? []) {
    const sheetName = sheet.properties.title;
    for (const gridData of sheet.data ?? []) {
      (gridData.rowData ?? []).forEach((row, rowIdx) => {
        (row.values ?? []).forEach((cell, colIdx) => {
          const formula = cell.userEnteredValue?.formulaValue ?? '';
          if (!formula.toUpperCase().includes('IMPORTRANGE')) return;

          const displayValue = cell.formattedValue ?? '';
          if (!displayValue.startsWith('#')) return;

          const cellAddress = columnToLetter(colIdx + 1) + (rowIdx + 1);

          let found = false;
          // Create a fresh regex per cell to avoid shared lastIndex state
          const globalRegex = new RegExp(IMPORTRANGE_BOTH_ARGS_REGEX_G.source, 'gi');
          let m: RegExpExecArray | null;
          while ((m = globalRegex.exec(formula)) !== null) {
            const rawArg = m[1].trim();
            results.push({
              cellAddress,
              sheetName,
              rawArg,
              sourceId: extractSpreadsheetId(rawArg),
              displayValue,
            });
            found = true;
          }

          if (!found) {
            const match = formula.match(IMPORTRANGE_FIRST_ARG_REGEX);
            if (match) {
              const rawArg = match[1].trim();
              results.push({
                cellAddress,
                sheetName,
                rawArg,
                sourceId: extractSpreadsheetId(rawArg),
                displayValue,
              });
            }
          }
        });
      });
    }
  }

  return results;
}
