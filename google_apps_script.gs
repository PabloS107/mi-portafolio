// ============================================================================
// CÓDIGO PARA PEGAR EN TU GOOGLE SHEET (Extensiones -> Apps Script)
// Conecta tu Dashboard en GitHub Pages con "Seguimiento Inversiones.gsheet"
// ============================================================================

function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var action = params.action || "get_data";

  if (action === "etf_search") {
    return handleEtfSearch(params.q || "");
  }
  if (action === "history") {
    return handleYahooHistory(params.ticker || "SPY");
  }
  return getSheetData();
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var action = body.action || "";
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === "add_movement") {
      var m = body.movement;
      var wsMov = ss.getSheetByName("Movimientos");
      var nextRow = wsMov.getLastRow() + 1;

      var fechaParts = String(m.fecha).split("-");
      var dateObj = fechaParts.length === 3
        ? new Date(Number(fechaParts[0]), Number(fechaParts[1]) - 1, Number(fechaParts[2]))
        : new Date();

      var hasCedear = m.cedears !== null && m.cedears !== undefined && m.ratio;
      var cantCell = hasCedear ? ("=D" + nextRow + "/E" + nextRow) : Number(m.cantidad);
      var invFormula = "=-(F" + nextRow + " * G" + nextRow + ")";
      var vlookupFormula = "=VLOOKUP(B" + nextRow + ", Portafolio!$A:$L, 12, FALSE)";

      wsMov.getRange(nextRow, 1, 1, 9).setValues([[
        dateObj,
        m.ticker,
        m.sector,
        hasCedear ? Number(m.cedears) : "",
        hasCedear ? Number(m.ratio) : "",
        cantCell,
        Number(m.precioCompra),
        invFormula,
        vlookupFormula
      ]]);

      // Si el ticker no existe en la hoja Portafolio, lo agregamos automáticamente
      ensureTickerInPortfolio(ss, m.ticker, m.sector);
      SpreadsheetApp.flush();
      return jsonResponse({ ok: true, row: nextRow });
    }

    if (action === "toggle_report" || action === "toggle_asset") {
      var wsPort = ss.getSheetByName("Portafolio");
      var data = wsPort.getDataRange().getValues();
      for (var i = 1; i < data.length; i++) {
        if (String(data[i][0]).trim().toUpperCase() === String(body.ticker).trim().toUpperCase()) {
          wsPort.getRange(i + 1, 12).setValue(Boolean(body.incluir));
          break;
        }
      }
      SpreadsheetApp.flush();
      return jsonResponse({ ok: true });
    }

    if (action === "delete_movement") {
      var wsMovDel = ss.getSheetByName("Movimientos");
      var rows = wsMovDel.getDataRange().getValues();
      for (var r = rows.length - 1; r >= 1; r--) {
        var rTicker = String(rows[r][1]).trim().toUpperCase();
        var rPrecio = Number(rows[r][6]);
        if (rTicker === String(body.ticker).toUpperCase() && Math.abs(rPrecio - Number(body.precioCompra)) < 0.01) {
          wsMovDel.deleteRow(r + 1);
          break;
        }
      }
      SpreadsheetApp.flush();
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: "Accion no reconocida" });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function ensureTickerInPortfolio(ss, ticker, sector) {
  var wsPort = ss.getSheetByName("Portafolio");
  var data = wsPort.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toUpperCase() === String(ticker).trim().toUpperCase()) {
      return; // Ya existe
    }
  }
  var r = wsPort.getLastRow() + 1;
  wsPort.getRange(r, 1, 1, 12).setValues([[
    ticker,
    sector,
    "=SUMIF(Movimientos!B:B, A" + r + ", Movimientos!F:F)",
    "=IFERROR(ABS(SUMIFS(Movimientos!H:H, Movimientos!B:B, A" + r + ", Movimientos!H:H, \"<0\")) / SUMIFS(Movimientos!F:F, Movimientos!B:B, A" + r + ", Movimientos!H:H, \"<0\"), 0)",
    "=GOOGLEFINANCE(A" + r + ", \"price\")",
    "=C" + r + "*E" + r,
    "=F" + r + " - (C" + r + "*D" + r + ")",
    "=IFERROR((E" + r + "-D" + r + ")/D" + r + ", 0)",
    "=IFERROR(XIRR({FILTER(Movimientos!H:H, Movimientos!B:B=A" + r + "); F" + r + "}, {FILTER(Movimientos!A:A, Movimientos!B:B=A" + r + "); TODAY()}), 0)",
    "=F" + r + " / SUM(F:F)",
    "",
    true
  ]]);
}

function getSheetData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone() || "America/Argentina/Buenos_Aires";

  var wsMov = ss.getSheetByName("Movimientos");
  var movData = wsMov ? wsMov.getDataRange().getValues() : [];
  var movimientos = [];
  for (var i = 1; i < movData.length; i++) {
    var row = movData[i];
    if (!row[1]) continue;
    var dtStr = (row[0] instanceof Date) ? Utilities.formatDate(row[0], tz, "yyyy-MM-dd") : String(row[0]);
    movimientos.push({
      id: "mov-" + (i + 1),
      fecha: dtStr,
      ticker: String(row[1]).trim().toUpperCase(),
      sector: String(row[2] || "Otro").trim(),
      cedears: row[3] !== "" && row[3] != null ? Number(row[3]) : null,
      ratio: row[4] !== "" && row[4] != null ? Number(row[4]) : null,
      cantidad: Number(row[5] || 0),
      precioCompra: Number(row[6] || 0),
      invertido: Math.abs(Number(row[7] || 0)),
      incluir: row[8] !== false
    });
  }

  var wsPort = ss.getSheetByName("Portafolio");
  var portData = wsPort ? wsPort.getDataRange().getValues() : [];
  var portafolio = [];
  for (var j = 1; j < portData.length; j++) {
    var p = portData[j];
    if (!p[0]) continue;
    portafolio.push({
      ticker: String(p[0]).trim().toUpperCase(),
      sector: String(p[1] || "Otro").trim(),
      tenencia: Number(p[2] || 0),
      ppc: Number(p[3] || 0),
      precioHoy: Number(p[4] || 0),
      valorMercado: Number(p[5] || 0),
      gananciaUsd: Number(p[6] || 0),
      gananciaPct: Number(p[7] || 0),
      anualizado: Number(p[8] || 0),
      pesoCartera: Number(p[9] || 0),
      incluirEnReporte: p[11] !== false
    });
  }

  return jsonResponse({
    lastSync: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm:ss"),
    precioMep: 1405.5,
    portafolio: portafolio,
    movimientos: movimientos
  });
}

function handleEtfSearch(q) {
  var url = "https://query1.finance.yahoo.com/v1/finance/search?q=" + encodeURIComponent(q) + "&quotesCount=8&newsCount=0";
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var data = JSON.parse(resp.getContentText());
  var results = [];
  var quotes = data.quotes || [];
  for (var i = 0; i < quotes.length; i++) {
    var item = quotes[i];
    results.push({
      symbol: item.symbol,
      name: item.shortname || item.longname || item.symbol,
      type: item.quoteType || "ETF"
    });
  }
  return jsonResponse({ results: results });
}

function handleYahooHistory(ticker) {
  var yf = ticker.trim().toUpperCase();
  if (yf === "CURRENCY:BTCUSD" || yf === "BTCUSD") yf = "BTC-USD";
  if (yf === "XNAS" || yf === "SPYL") yf = yf + ".L";
  if (yf === "BRK.B") yf = "BRK-B";

  var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(yf) + "?interval=1d&range=2y";
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var payload = JSON.parse(resp.getContentText());
  var res = payload.chart.result[0];
  var ts = res.timestamp || [];
  var closes = res.indicators.quote[0].close || [];
  var series = {};
  var lastValid = null;
  for (var i = 0; i < ts.length; i++) {
    if (closes[i] != null && closes[i] > 0) lastValid = Math.round(closes[i] * 10000) / 10000;
    if (lastValid != null) {
      var d = new Date(ts[i] * 1000).toISOString().slice(0, 10);
      series[d] = lastValid;
    }
  }
  return jsonResponse({ ticker: ticker.toUpperCase(), series: series });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
