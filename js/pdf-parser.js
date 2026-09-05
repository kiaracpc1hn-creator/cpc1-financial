/**
 * CPC1 Financial Vouchers - Smart PDF Invoice Extractor (Offline PDF.js & Online AI OCR)
 * Optimized specifically for Vietnamese Electronic Invoices (TT78 / NĐ123)
 */

async function extractInvoiceDataFromPdfFile(file, dataUrl = null) {
  let fullText = "";
  let lines = [];

  // 1. Client-Side Offline PDF.js parsing
  if (window.pdfjsLib) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        const lineMap = {};
        for (const item of textContent.items) {
          if (!item.str) continue;
          // Group items on roughly the same vertical Y-coordinate (tolerance: 3px)
          const y = Math.round(item.transform[5] / 3) * 3;
          if (!lineMap[y]) lineMap[y] = [];
          lineMap[y].push({ x: item.transform[4], str: item.str });
        }

        const sortedY = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
        for (const y of sortedY) {
          const lineItems = lineMap[y].sort((a, b) => a.x - b.x);
          const lineStr = lineItems.map(i => i.str).join(" ").replace(/\s+/g, " ").trim();
          if (lineStr) {
            lines.push(lineStr);
            fullText += lineStr + "\n";
          }
        }
      }
    } catch (err) {
      console.warn("pdfjsLib parsing error:", err);
    }
  }

  // 2. Parse text lines offline
  const parsed = parseInvoiceText(fullText, lines, file ? file.name : "");

  // 3. Optional AI OCR enhancement if Gemini or Claude API key is configured
  const geminiKey = (window.STATE && window.STATE.geminiApiKey) || localStorage.getItem('cpc1_gemini_api_key');
  const claudeKey = (window.STATE && window.STATE.claudeApiKey) || localStorage.getItem('cpc1_claude_api_key');

  if ((geminiKey || claudeKey) && dataUrl) {
    try {
      const base64 = dataUrl.split(',')[1];
      let aiResult = null;

      if (geminiKey) {
        aiResult = await callGeminiExtractInvoiceFull(base64, geminiKey);
      } else if (claudeKey) {
        aiResult = await callClaudeExtractInvoiceFull(base64, claudeKey);
      }

      if (aiResult) {
        if (aiResult.seriesNo) parsed.seriesNo = aiResult.seriesNo;
        if (aiResult.invoiceNumber) parsed.invoiceNumber = aiResult.invoiceNumber;
        if (parsed.seriesNo && parsed.invoiceNumber) parsed.invoiceNo = `${parsed.seriesNo}|${parsed.invoiceNumber}`;
        else if (aiResult.invoiceNumber) parsed.invoiceNo = aiResult.invoiceNumber;
        if (aiResult.date) parsed.date = aiResult.date;
        if (aiResult.amount) parsed.amount = Number(aiResult.amount) || parsed.amount;
        if (aiResult.sellerName) parsed.sellerName = cleanSellerName(aiResult.sellerName);
        if (aiResult.note) parsed.description = aiResult.note;
        if (aiResult.currency) parsed.currency = aiResult.currency;
      }
    } catch (apiErr) {
      console.warn('AI API extraction error:', apiErr);
    }
  }

  return parsed;
}

function cleanSellerName(raw) {
  if (!raw) return "";
  let s = raw.trim();

  // 1. Loại bỏ các dòng mã cơ quan thuế / mã số thuế
  if (/^(?:Mã\s*của\s*cơ\s*quan\s*thuế|Mã\s*cơ\s*quan\s*thuế|Mã\s*CQT|Mã\s*số\s*thuế|Tax\s*code|Ký\s*hiệu|Mẫu\s*số|Số\s*hoá\s*đơn|Ngày\s*lập)[\:\s]/i.test(s)) {
    return "";
  }
  if (/Mã\s*của\s*Cơ\s*quan\s*thuế/i.test(s)) return "";

  // 2. Loại bỏ triệt để các tiền tố "Đơn vị bán", "Tên người bán", "Bên bán", "Đơn vị thu", "Seller",... (có hoặc không có dấu hai chấm / khoảng trắng)
  const prefixRegex = /^(?:[\s\:\-\(\)]*(?:Seller|Supplier|Issuer|Vendor|Beneficiary|Payee|Đơn\s*vị\s*(?:bán\s*hàng|bán|thu|phát\s*hành|cung\s*cấp|nhận\s*tiền|thụ\s*hưởng)|Tên\s*(?:đơn\s*vị|người)\s*(?:bán\s*hàng|bán|thu|phát\s*hành|cung\s*cấp)|Tên\s*đơn\s*vị|Bên\s*(?:bán|thu|phát\s*hành|cung\s*cấp)|Cơ\s*sở\s*phát\s*hành|Nhà\s*cung\s*cấp|Người\s*bán|Cơ\s*quan\s*thu)[\s\:\-\(\)]*)+/i;

  for (let iter = 0; iter < 3; iter++) {
    s = s.replace(prefixRegex, '').trim();
  }
  s = s.replace(/^[\)\:\-\s\.\,]+/, '').trim();

  // 3. Loại bỏ mã số thuế / địa chỉ / số điện thoại gắn liền phía sau
  s = s.replace(/\s*(?:Mã\s*số\s*thuế|Tax\s*code|MST|Địa\s*chỉ|Address|Điện\s*thoại|Tel|Số\s*tài\s*khoản|STK)[\:\s].*$/i, '').trim();

  if (/Mã\s*của\s*cơ\s*quan\s*thuế|Mã\s*CQT/i.test(s)) return "";

  return s;
}

function cleanAndFormatGoodsAndServices(rawLines) {
  if (!rawLines || rawLines.length === 0) return "";

  // 1. Filter out pure numbers, formulas, and pure reference codes (B/L, TK, PO) if other items exist
  let validItems = rawLines.filter(line => {
    const s = line.trim();
    if (!s) return false;
    // Exclude pure numbers, order codes (e.g. 308734661340) or formula tokens
    if (/^[\d\s\.\,\-\_\/\:\;\=\+\*x]+$/.test(s)) return false;
    // Exclude if it has fewer than 3 letters
    const letterCount = (s.match(/[a-zA-ZÀ-ỹ]/g) || []).length;
    if (letterCount < 3) return false;
    return true;
  });

  // If we have items with real service names, exclude standalone metadata lines (B/L#, TK#, HAWB#)
  const nonMetaItems = validItems.filter(s => !/^(?:B\/?L\#?|TỜ\s*KHAI|TK\#?|HAWB\#?|MAWB\#?|PO\#?|BOOKING\#?|CONT\#?|SEAL\#?)\s*[:\s-]/i.test(s));
  if (nonMetaItems.length > 0) {
    validItems = nonMetaItems;
  }

  if (validItems.length === 0) return "";

  const cleanedItems = validItems.map(item => {
    let s = item.trim();
    if (validItems.length > 1) {
      // Remove repetitive flight/routing clauses following a comma
      s = s.replace(/,\s*(?:CHUYỂN|CHUYÊN|CHUYẾN|TỪ\s*HA\s*NOI|TỪ\s*HÀ\s*NỘI|BAY|THEO\s*LÔ|LÔ\s*HÀNG|TỜ\s*KHAI|B\/L|HAWB|MAWB|PO)\b.*$/i, '').trim();
    }
    return s;
  });

  // Deduplicate items
  const uniqueItems = [];
  const seen = new Set();
  for (const it of cleanedItems) {
    const key = it.toLowerCase();
    if (!seen.has(key) && it.length > 0) {
      seen.add(key);
      uniqueItems.push(it);
    }
  }

  return uniqueItems.slice(0, 5).join("; ");
}

function parseInvoiceText(fullText, lines, filename) {
  let seriesNo = "";
  let invoiceNumber = "";
  let dateStr = "";
  let amount = 0;
  let description = "";
  let sellerName = "";
  let currency = "VND";

  const INVALID_SERIES = new Set(['SERIAL', 'SERIES', 'NUMBER', 'INVOICE', 'PATTERN', 'MAUSO', 'KYHIEU', 'TEMPLATE', 'FORM', 'HOADON', 'VAT', '01A', '02A', '03A', '04A', '05A', '01B', '02B', '03B', '04B', '05B', '06B', '07B', '08B', '09B', '10B', '11B', '12B']);

  // -------------------------------------------------------------
  // 1. Series No (Ký hiệu) & Invoice Number (Số HĐ) from text / filename
  // -------------------------------------------------------------
  // Ưu tiên 1: Nhận diện nhãn Ký hiệu trực tiếp (Ký hiệu: VC-24E, Ký hiệu (Serial): 1K26TED, Ký hiệu: 26T)
  const explicitSerialMatch = fullText.match(/(?:Ký\s*hiệu\s*\([^)]*\)|Mẫu\s*số\s*[-/]?\s*Ký\s*hiệu|Ký\s*hiệu\s*(?:hóa\s*đơn|hoá\s*đơn|biên\s*lai)?|Ký\s*hiệu|Serial\s*No\.?|Serial|Series)\s*[:\s-]+\s*([A-Z0-9][A-Z0-9\-\/]{1,11})/i);
  if (explicitSerialMatch && explicitSerialMatch[1]) {
    const cand = explicitSerialMatch[1].trim().toUpperCase();
    if (cand && !INVALID_SERIES.has(cand) && cand.length >= 2) {
      seriesNo = cand;
    }
  }

  // Ưu tiên 2: Tìm kiếm dự phòng trong văn bản nếu không thấy nhãn trực tiếp
  if (!seriesNo) {
    const textSeriesMatches = [
      ...fullText.matchAll(/(?:Mẫu\s*số\s*[-/]?\s*Ký\s*hiệu|Ký\s*hiệu\s*(?:hóa\s*đơn|hoá\s*đơn|biên\s*lai)?|Ký\s*hiệu|Serial\s*No\.?|Series)(?:\s*\([^)]*\))?\s*[:\s-]+\s*(?:[1-9]\/[0-9]+\s*[-/]\s*)?([A-Z0-9][A-Z0-9\-\/]{1,11})/gi),
      ...fullText.matchAll(/\b([12]?[A-Z]{1,3}[-\/]?\d{2}[A-Z]{1,3})\b/g),
      ...fullText.matchAll(/\b([A-Z]{2,4}[-\/]\d{2}[A-Z0-9]{1,3})\b/g),
      ...fullText.matchAll(/\b(\d{2}[A-Z]{1,3})\b/g)
    ];

    for (const m of textSeriesMatches) {
      const val = (m[1] || '').trim().toUpperCase();
      if (val && !INVALID_SERIES.has(val) && val.length >= 2) {
        seriesNo = val;
        break;
      }
    }
  }

  // Search text for Invoice Number: e.g. "Số (Invoice No.): 00003992" or "Số (No.): 00003992" or "Số: 0001884"
  const numberMatches = [
    ...fullText.matchAll(/(?:Số\s*\(Invoice\s*No\.\)|Số\s*\(No\.\)|Số\s*hoá\s*đơn|Số\s*hóa\s*đơn|Số\s*HĐ|Invoice\s*No\.?)\s*[:\s]*([0-9]{1,10})/gi),
    ...fullText.matchAll(/(?:^|\n)[^\n]*\b(?:Số|No\.?)\s*[:\s]+\s*([0-9]{1,10})/gi)
  ];
  for (const m of numberMatches) {
    const fullMatchText = m[0] || '';
    if (/Địa\s*chỉ|Address|Điện\s*thoại|Tel\b/i.test(fullMatchText)) continue;
    const val = (m[1] || '').trim();
    if (val && val.length >= 3) {
      invoiceNumber = val;
      break;
    }
  }

  // If missing from text, extract from filename (e.g. C26TYY-00003992-SVJWYG7PXX7-DPH.pdf)
  if (filename) {
    const fnMatch = filename.match(/([A-Z0-9]{4,10})[-_](\d{4,10})/i) || filename.match(/([A-Z0-9]+)[-_\|](\d{4,10})/i);
    if (fnMatch) {
      if (!seriesNo) {
        const cand = fnMatch[1].toUpperCase();
        if (!INVALID_SERIES.has(cand)) seriesNo = cand;
      }
      if (!invoiceNumber) {
        invoiceNumber = fnMatch[2];
      }
    }
  }

  let invoiceNo = "";
  if (seriesNo && invoiceNumber) {
    invoiceNo = `${seriesNo}|${invoiceNumber}`;
  } else if (invoiceNumber) {
    invoiceNo = invoiceNumber;
  } else if (seriesNo) {
    invoiceNo = seriesNo;
  }

  // -------------------------------------------------------------
  // 2. Issue Date (Ngày lập)
  // -------------------------------------------------------------
  const dateMatch = fullText.match(/Ngày(?:\s*\([^)]*\))?\s*(\d{1,2})\s*tháng(?:\s*\([^)]*\))?\s*(\d{1,2})\s*năm(?:\s*\([^)]*\))?\s*(\d{4})/i)
    || fullText.match(/Date\s*[:\s]*(\d{1,2})\s*[\/\.-]\s*(\d{1,2})\s*[\/\.-]\s*(\d{4})/i)
    || fullText.match(/(?:Hà\s*Nội|TP\.?\s*HCM|Đà\s*Nẵng|Hải\s*Phòng|Ngày|Date)[^0-9]*(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})/i)
    || fullText.match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})\b/);
  if (dateMatch) {
    const d = String(dateMatch[1]).padStart(2, "0");
    const m = String(dateMatch[2]).padStart(2, "0");
    const y = dateMatch[3];
    dateStr = `${y}-${m}-${d}`;
  }

  // -------------------------------------------------------------
  // 3. Currency Check (Loại tiền tệ)
  // -------------------------------------------------------------
  const wordsMatch = fullText.match(/(?:Số\s*tiền\s*viết\s*bằng\s*chữ|Amount\s*in\s*words|Bằng\s*chữ)\s*[:\s]*([^\n\r]+)/i);
  const wordsText = wordsMatch ? wordsMatch[1] : fullText;

  if (/đồng\s*chẵn|đồng\b|\/đồng|\bVNĐ\b|\bVND\b/i.test(wordsText)) {
    currency = "VND";
  } else if (/đô\s*la\s*Mỹ|\bUSD\b|\bDollars?\b/i.test(wordsText)) {
    currency = "USD";
  } else if (/Đồng\s*tiền\s*thanh\s*toán\s*[:\s]*USD/i.test(fullText)) {
    currency = "USD";
  } else {
    currency = "VND";
  }

  // -------------------------------------------------------------
  // 4. Seller / Beneficiary Name (Tên người bán / Người thụ hưởng ở phần trên cùng)
  // -------------------------------------------------------------
  // Scan lines in top section before Buyer / Người mua hàng
  let buyerLineIndex = lines.findIndex(l => /Họ\s*tên\s*người\s*mua|Tên\s*đơn\s*vị\s*\(Co\.\s*name\)|Người\s*mua\s*hàng|Buyer|Khách\s*hàng|Đơn\s*vị\s*mua/i.test(l));
  if (buyerLineIndex === -1) buyerLineIndex = Math.min(lines.length, 25);

  for (let i = 0; i < buyerLineIndex; i++) {
    const l = lines[i];
    if (/Mã\s*của\s*Cơ\s*quan\s*thuế|Mã\s*CQT/i.test(l)) continue;
    // Check for explicit seller/issuer label: "Đơn vị bán(Seller): ...", "Đơn vị thu: CỤC XUẤT NHẬP KHẨU"
    if (/Đơn\s*vị\s*bán|Đơn\s*vị\s*thu|Tên\s*người\s*bán|Tên\s*đơn\s*vị\s*bán|Seller|Tên\s*đơn\s*vị\s*phát\s*hành|Bên\s*bán/i.test(l)) {
      let candidate = cleanSellerName(l);
      if ((!candidate || candidate.length < 4) && i + 1 < buyerLineIndex) {
        candidate = cleanSellerName(lines[i + 1]);
      }
      if ((!candidate || candidate.length < 4) && i + 2 < buyerLineIndex) {
        candidate = cleanSellerName(lines[i + 2]);
      }
      if (candidate && candidate.length >= 4 && !/^(Mã\s*số\s*thuế|Tax\s*code|Địa\s*chỉ|Address|Điện\s*thoại|Tel|Số\s*tài\s*khoản|Account|Mã\s*của)/i.test(candidate)) {
        // Exclude CPC1 if accidentally matched
        if (!/Công\s*ty\s*Cổ\s*phần\s*Dược\s*phẩm\s*CPC1/i.test(candidate)) {
          sellerName = candidate;
          break;
        }
      }
    }
  }

  // Fallback: If no explicit seller label, look for Company / Authority name in top 15 lines
  if (!sellerName) {
    for (let i = 0; i < Math.min(15, buyerLineIndex); i++) {
      const l = lines[i].trim();
      if (/Mã\s*của\s*Cơ\s*quan\s*thuế|Mã\s*CQT/i.test(l)) continue;
      if (/^(?:CÔNG\s*TY|DOANH\s*NGHIỆP|TỔNG\s*CÔNG\s*TY|TRUNG\s*TÂM|CHI\s*NHÁNH|CỤC|TỔNG\s*CỤC|SỞ)\b/i.test(l)) {
        if (!/CPC1\s*Hà\s*Nội|Dược\s*phẩm\s*CPC1/i.test(l)) {
          const candidate = cleanSellerName(l);
          if (candidate) {
            sellerName = candidate;
            break;
          }
        }
      }
    }
  }

  // Digital Signature Fallback: "Đã được ký điện tử bởi CÔNG TY TNHH..."
  if (!sellerName) {
    const signMatch = fullText.match(/(?:Đã\s*được\s*ký\s*điện\s*tử\s*bởi|Signed\s*digitally\s*by)\s*([^\n]+)/i);
    if (signMatch && signMatch[1]) {
      const candidate = cleanSellerName(signMatch[1]);
      if (candidate && !/CPC1/i.test(candidate)) {
        sellerName = candidate;
      }
    }
  }

  // -------------------------------------------------------------
  // 5. Description / Items content (Chỉ đọc cột Tên hàng hoá, dịch vụ)
  // -------------------------------------------------------------
  const descItems = [];
  let inItemArea = false;

  const HEADER_OR_JUNK_REGEX = /^(?:STT|No\.?|Unit|Quantity|Unit\s*Price|Amount|Tax\s*Rate|Tax\s*Amount|Đơn\s*vị\s*tính|Số\s*lượng|Đơn\s*giá|Thành\s*tiền|Thuế\s*suất|Tiền\s*thuế|Description|Tên\s*hàng|Tên\s*hàng\s*hóa|Tên\s*hàng\s*hoá|Name\s*of\s*goods|\(\s*\)|[0-9\s=\*x\+\-\/,\.]{1,30}|BỘ|LÔ|KGS?|CHIẾC|CÁI|HỘP|QUYỂN|GÓI|CHUYẾN|LẦN|BẢN|SET|PCS?)$/i;
  const FORMULA_ROW_REGEX = /^[0-9\s=\*x\+]+$/;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();

    if (/Tên\s*hàng\s*hóa|Tên\s*hàng\s*hoá|Tên\s*hàng|Description|Name\s*of\s*goods|Nội\s*dung\s*dịch\s*vụ|Hàng\s*hóa,\s*dịch\s*vụ/i.test(l)) {
      inItemArea = true;
      continue;
    }

    if (inItemArea && /Cộng\s*tiền\s*hàng|Tổng\s*cộng|Thành\s*tiền\s*tiền|Tổng\s*tiền\s*thanh\s*toán|Thuế\s*suất|VAT|Tiền\s*thuế|Số\s*tiền\s*viết\s*bằng\s*chữ|Sub\s*total|Total\s*payment/i.test(l)) {
      inItemArea = false;
      break;
    }

    if (inItemArea) {
      let lineCleaned = l;
      // Remove header terms & sub-labels
      lineCleaned = lineCleaned.replace(/\b(?:STT|No\.?|Unit|Quantity|Unit\s*Price|Amount|Tax\s*Rate|Tax\s*Amount|Đơn\s*vị\s*tính|Số\s*lượng|Đơn\s*giá|Thành\s*tiền|Thuế\s*suất|Tiền\s*thuế|Description|Name\s*of\s*goods\s*and\s*services)\b/gi, "");
      // Remove column numbering formulas like 6 = 4 x 5, 8 = 6 x 7
      lineCleaned = lineCleaned.replace(/=\s*\d+\s*[x\*]\s*\d+/g, "");
      // Remove money amount tokens
      lineCleaned = lineCleaned.replace(/\b\d{1,3}(?:[\.,]\d{3})+(?:[\.,]\d+)?\b/g, "");
      // Remove tax percentages like 8%, 10%, 5%, 0%
      lineCleaned = lineCleaned.replace(/\b\d{1,2}%\b/g, "");
      // Remove leading STT index numbers like "1 ", "2 "
      lineCleaned = lineCleaned.replace(/^\s*\d+\s+/, "");
      // Remove standalone unit tokens
      lineCleaned = lineCleaned.replace(/\b(?:BỘ|LÔ|KGS?|CHIẾC|CÁI|HỘP|QUYỂN|GÓI|CHUYẾN|LẦN|BẢN|SET|PCS?)\b/gi, "");
      lineCleaned = lineCleaned.replace(/[\{\}\[\]]/g, " ");
      lineCleaned = lineCleaned.replace(/\s+/g, " ").trim();

      if (lineCleaned && lineCleaned.length >= 3 && !HEADER_OR_JUNK_REGEX.test(lineCleaned) && !FORMULA_ROW_REGEX.test(lineCleaned)) {
        // Must contain alphabet letters and at least 3 letters
        const letters = (lineCleaned.match(/[a-zA-ZÀ-ỹ]/g) || []).length;
        if (letters >= 3) {
          descItems.push(lineCleaned);
        }
      }
    }
  }

  // -------------------------------------------------------------
  // 5. Specialized Business Auto-Rules for Specific Series & Categories
  // -------------------------------------------------------------
  const sUpper = (seriesNo || '').toUpperCase();

  // Helper kiểm tra thuế VAT
  function checkHasVat(text) {
    if (!text) return false;
    // 1. Kiểm tra dòng 'Cộng tiền thuế GTGT (VAT amount): [số tiền]'
    const vatMatch = text.match(/(?:Cộng\s*tiền\s*thuế\s*GTGT|Tiền\s*thuế\s*GTGT|VAT\s*amount)[^\d]*(\d{1,3}(?:[\.,]\d{3})*|\d+)/i);
    if (vatMatch) {
      const vatVal = parseInt(vatMatch[1].replace(/[\.,\s]/g, ""), 10) || 0;
      if (vatVal > 0) return true;
      if (vatVal === 0) return false;
    }
    // 2. Kiểm tra phần trăm thuế suất 5%, 8%, 10% vs 0%, KCT
    const hasPositiveRate = /\b(?:5%|8%|10%)\b/i.test(text);
    const hasZeroRate = /\b(?:0%|KCT|KTT)\b/i.test(text) || /Không\s*chịu\s*thuế/i.test(text);
    if (hasPositiveRate && !hasZeroRate) return true;
    if (hasZeroRate && !hasPositiveRate) return false;
    return hasPositiveRate;
  }

  // Quy tắc 1: 1C26TAA, 1C26TYY, 1C26TNM (Phân loại theo Thuế VAT)
  if (/1C26TAA|C26TAA|1C26TYY|C26TYY|1C26TNM|C26TNM/i.test(sUpper)) {
    const isVat = checkHasVat(fullText);
    if (isVat) {
      description = "Cước phí địa phương của lô hàng xuất";
    } else {
      description = "Cước vận chuyển quốc tế lô hàng xuất";
    }
  }
  // Quy tắc 2: 1K26TED / Bảo hiểm hàng hoá -> "Phí bảo hiểm hàng xuất"
  else if (/1K26TED|K26TED/i.test(sUpper) || /LOẠI\s*HÌNH\s*BẢO\s*HIỂM|SỐ\s*ĐƠN\s*BẢO\s*HIỂM|Thu\s*phí\s*bảo\s*hiểm|Bảo\s*hiểm\s*hàng\s*hoá|PVI\b/i.test(fullText)) {
    description = "Phí bảo hiểm hàng xuất";
  }
  // Quy tắc 3: C26TML -> "Phí cấp C/O cho lô hàng"
  else if (/C26TML/i.test(sUpper) || /Phí\s*xin\s*cấp\s*C\/?O/i.test(fullText)) {
    description = "Phí cấp C/O cho lô hàng";
  }
  // Quy tắc 4: 26T / EBL01 / Cục Xuất Nhập Khẩu -> "Lệ phí cấp C/O cho lô hàng"
  else if (/26T\b/i.test(sUpper) || /EBL01|CỤC\s*XUẤT\s*NHẬP\s*KHẨU|chứng\s*nhận\s*xuất\s*xứ\s*hàng\s*hóa/i.test(fullText)) {
    description = "Lệ phí cấp C/O cho lô hàng";
  }
  // Quy tắc 5: BIÊN LAI THU TIỀN PHÍ (Cảng biển TP.Hải Phòng / Cảng vụ Đường thủy nội địa)
  else if (/BIÊN\s*LAI\s*THU\s*TIỀN\s*PHÍ|Cảng\s*vụ|cảng\s*biển\s*TP\.?\s*Hải\s*Phòng|01BLP0/i.test(fullText) || /VC-24E|VC\/24E/i.test(fullText)) {
    if (!seriesNo) seriesNo = "VC-24E";
    if (!description || description === "Nội dung hàng hoá/dịch vụ") {
      description = "Phí sử dụng công trình kết cấu hạ tầng cảng biển";
    }
  }
  else {
    description = cleanAndFormatGoodsAndServices(descItems);
  }

  if (!seriesNo && (/BIÊN\s*LAI\s*THU\s*TIỀN\s*PHÍ|Cảng\s*vụ|cảng\s*biển\s*TP\.?\s*Hải\s*Phòng|01BLP0/i.test(fullText))) {
    seriesNo = "VC-24E";
  }

  // -------------------------------------------------------------
  // 6. Total Amount after VAT (Tổng cộng tiền thanh toán sau khi cộng thuế)
  // -------------------------------------------------------------
  // Look for "Thành tiền sau thuế", "Tổng cộng tiền thanh toán (Total payment)", "Tổng tiền thanh toán"
  const totalPaymentRegexes = [
    /(?:Thành\s*tiền\s*sau\s*thuế|Tổng\s*cộng\s*tiền\s*thanh\s*toán|Total\s*payment|Tổng\s*tiền\s*thanh\s*toán|Tổng\s*thanh\s*toán|Tổng\s*cộng\s*thanh\s*toán|Số\s*tiền)(?:\s*\([^)]*\))?\s*[:\s]*([0-9]{1,3}(?:[\.,][0-9]{3})+(?:[\.,][0-9]{2})?|[0-9]{4,})/gi,
    /(?:Tổng\s*cộng|Total\s*amount)(?:\s*\([^)]*\))?\s*[:\s]*([0-9]{1,3}(?:[\.,][0-9]{3})+(?:[\.,][0-9]{2})?|[0-9]{4,})/gi
  ];

  let matchedAmount = 0;
  for (const regex of totalPaymentRegexes) {
    let m;
    while ((m = regex.exec(fullText)) !== null) {
      const raw = m[1].replace(/[\.,\s]/g, "");
      const val = parseInt(raw, 10);
      if (!isNaN(val) && val > matchedAmount) {
        matchedAmount = val;
      }
    }
    if (matchedAmount > 0) break;
  }

  if (matchedAmount > 0) {
    amount = matchedAmount;
  } else {
    // If not matched directly, find the largest amount in the bottom summary area
    const subTotalMatch = fullText.match(/(?:Cộng\s*tiền\s*hàng|Sub\s*total)[^\d]*(\d{1,3}(?:[\.,]\d{3})+)/i);
    const vatMatch = fullText.match(/(?:Cộng\s*tiền\s*thuế|Tiền\s*thuế\s*GTGT|VAT\s*amount)[^\d]*(\d{1,3}(?:[\.,]\d{3})+)/i);
    if (subTotalMatch && vatMatch) {
      const subVal = parseInt(subTotalMatch[1].replace(/[\.,\s]/g, ""), 10) || 0;
      const vatVal = parseInt(vatMatch[1].replace(/[\.,\s]/g, ""), 10) || 0;
      if (subVal > 0 && vatVal >= 0) {
        amount = subVal + vatVal;
      }
    }
    if (amount === 0) {
      const allAmounts = fullText.match(/\b\d{1,3}(?:[\.,]\d{3})+\b/g);
      if (allAmounts) {
        const parsedList = allAmounts.map(s => parseInt(s.replace(/[\.,]/g, ""), 10)).filter(n => !isNaN(n));
        if (parsedList.length > 0) amount = Math.max(...parsedList);
      }
    }
  }

  return {
    seriesNo,
    invoiceNumber,
    invoiceNo,
    date: dateStr,
    amount,
    currency,
    description,
    sellerName: cleanSellerName(sellerName)
  };
}

async function extractInvoiceDataFromPdfFile(file, dataUrl = null) {
  let fullText = "";
  let lines = [];
  const mimeType = (file && file.type) || (file && file.name && /\.pdf$/i.test(file.name) ? 'application/pdf' : 'image/jpeg');
  const isPdf = mimeType === 'application/pdf' || (file && /\.pdf$/i.test(file.name));

  // 1. Client-Side Offline PDF.js parsing (Chỉ chạy với file PDF)
  if (isPdf && window.pdfjsLib) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

        const lineMap = {};
        for (const item of textContent.items) {
          if (!item.str) continue;
          // Group items on roughly the same vertical Y-coordinate (tolerance: 3px)
          const y = Math.round(item.transform[5] / 3) * 3;
          if (!lineMap[y]) lineMap[y] = [];
          lineMap[y].push({ x: item.transform[4], str: item.str });
        }

        const sortedY = Object.keys(lineMap).map(Number).sort((a, b) => b - a);
        for (const y of sortedY) {
          const lineItems = lineMap[y].sort((a, b) => a.x - b.x);
          const lineStr = lineItems.map(i => i.str).join(" ").replace(/\s+/g, " ").trim();
          if (lineStr) {
            lines.push(lineStr);
            fullText += lineStr + "\n";
          }
        }
      }
    } catch (err) {
      console.warn("pdfjsLib parsing error:", err);
    }
  }

  // 2. Parse text lines offline (tên file hoặc văn bản PDF)
  const parsed = parseInvoiceText(fullText, lines, file ? file.name : "");

  // 3. AI Vision OCR bóc tách hoá đơn (Hỗ trợ cả PDF và Ảnh scan JPG/PNG/WEBP)
  const geminiKey = (window.STATE && window.STATE.geminiApiKey) || localStorage.getItem('cpc1_gemini_api_key');
  const claudeKey = (window.STATE && window.STATE.claudeApiKey) || localStorage.getItem('cpc1_claude_api_key');

  if ((geminiKey || claudeKey) && dataUrl) {
    try {
      const base64 = dataUrl.split(',')[1];
      let aiResult = null;

      if (geminiKey) {
        aiResult = await callGeminiExtractInvoiceFull(base64, geminiKey, mimeType);
      } else if (claudeKey) {
        aiResult = await callClaudeExtractInvoiceFull(base64, claudeKey, mimeType);
      }

      if (aiResult) {
        if (aiResult.seriesNo) parsed.seriesNo = aiResult.seriesNo;
        if (aiResult.invoiceNumber) parsed.invoiceNumber = aiResult.invoiceNumber;
        if (parsed.seriesNo && parsed.invoiceNumber) parsed.invoiceNo = `${parsed.seriesNo}|${parsed.invoiceNumber}`;
        else if (aiResult.invoiceNumber) parsed.invoiceNo = aiResult.invoiceNumber;
        if (aiResult.date) parsed.date = aiResult.date;
        if (aiResult.amount) parsed.amount = Number(aiResult.amount) || parsed.amount;
        if (aiResult.sellerName) parsed.sellerName = cleanSellerName(aiResult.sellerName);
        if (aiResult.note) parsed.description = aiResult.note;
        if (aiResult.currency) parsed.currency = aiResult.currency;
      }
    } catch (apiErr) {
      console.warn('AI API extraction error:', apiErr);
    }
  }

  return parsed;
}

async function callClaudeExtractInvoiceFull(base64Data, apiKey, mimeType = "application/pdf") {
  const isPdf = mimeType === 'application/pdf';
  const mediaContent = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64Data } }
    : { type: "image", source: { type: "base64", media_type: mimeType, data: base64Data } };

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 600,
      system: "Bạn là trợ lý trích xuất dữ liệu từ hoá đơn/biên lai tiếng Việt. Đọc file/ảnh được cung cấp và CHỈ trả về một JSON object hợp lệ, không kèm giải thích, không dùng markdown code fence. Định dạng: {\"date\":\"YYYY-MM-DD\",\"seriesNo\":\"string\",\"invoiceNumber\":\"string\",\"note\":\"string\",\"sellerName\":\"string\",\"amount\":number,\"currency\":\"VND hoặc USD\"}. QUY TẮC NỘI DUNG (note): 1. Ký hiệu 1C26TAA, 1C26TYY, 1C26TNM: Nếu KHÔNG CÓ THUẾ VAT (0%, KCT) -> note = 'Cước vận chuyển quốc tế lô hàng xuất'; Nếu CÓ THUẾ VAT (5%, 8%, 10%...) -> note = 'Cước phí địa phương của lô hàng xuất'. 2. Ký hiệu 1K26TED: 'Phí bảo hiểm lô hàng xuất'. 3. Ký hiệu C26TML: 'Phí cấp C/O cho lô hàng'. 4. Ký hiệu 26T / Biên lai Cục Xuất Nhập Khẩu: 'Lệ phí cấp C/O cho lô hàng'. Các hoá đơn khác: lấy danh sách tên hàng hoá/dịch vụ ngắn gọn.",
      messages: [
        {
          role: "user",
          content: [
            mediaContent,
            { type: "text", text: "Trích xuất ngày, ký hiệu, số hoá đơn, người bán/đơn vị thu (ở trên cùng), tổng tiền thanh toán sau thuế (ở cuối bảng), loại tiền tệ, và danh sách tên hàng hoá/dịch vụ ngắn gọn từ bảng chi tiết dưới dạng JSON." }
          ]
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error('Claude API error: ' + response.status);
  }
  const data = await response.json();
  const textBlock = (data.content || []).find(c => c.type === 'text');
  if (!textBlock || !textBlock.text) throw new Error('Empty API response');
  let jsonStr = textBlock.text.trim();
  jsonStr = jsonStr.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

async function callGeminiExtractInvoiceFull(base64Data, apiKey, mimeType = "application/pdf") {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const prompt = `Bạn là trợ lý trích xuất dữ liệu từ hoá đơn/biên lai tiếng Việt. Đọc file hoá đơn/ảnh được cung cấp và CHỈ trả về một JSON object hợp lệ, không kèm giải thích, không dùng markdown code fence.
Định dạng JSON bắt buộc:
{
  "date": "YYYY-MM-DD",
  "seriesNo": "string (Ký hiệu, ví dụ: C26TML, 26T, 1C26TYY, 1K26TED, 1C26TDN)",
  "invoiceNumber": "string (Số hoá đơn/biên lai, giữ nguyên số 0 ở đầu)",
  "sellerName": "string (Chỉ lấy TÊN CÔNG TY/ĐƠN VỊ BÁN ở phần trên cùng. TUYỆT ĐỐI KHÔNG LẤY TIỀN TỐ như 'Đơn vị bán:', 'Tên người bán:', 'Bên bán:', 'Đơn vị thu:'. Ví dụ đúng: CÔNG TY TNHH VNFT GROUP, SỞ CÔNG THƯƠNG THÀNH PHỐ HÀ NỘI)",
  "amount": number (Tổng tiền thanh toán sau thuế ở cuối bảng, chỉ ghi số),
  "currency": "VND hoặc USD",
  "note": "string (QUY TẮC NOTE BẮT BUỘC: 1. Nếu ký hiệu 1C26TAA, 1C26TYY, 1C26TNM: Nếu KHÔNG CÓ THUẾ VAT -> 'Cước vận chuyển quốc tế lô hàng xuất'; Nếu CÓ THUẾ VAT -> 'Cước phí địa phương của lô hàng xuất'. 2. Nếu ký hiệu 1K26TED -> 'Phí bảo hiểm lô hàng xuất'. 3. Nếu C26TML -> 'Phí cấp C/O cho lô hàng'. 4. Nếu 26T hoặc Cục Xuất Nhập Khẩu -> 'Lệ phí cấp C/O cho lô hàng')"
}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Data } },
          { text: prompt }
        ]
      }],
      generationConfig: {
        response_mime_type: "application/json",
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    throw new Error('Gemini API error: ' + response.status);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty Gemini API response');
  let jsonStr = text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
  return JSON.parse(jsonStr);
}

// Export to window
window.extractInvoiceDataFromPdfFile = extractInvoiceDataFromPdfFile;
window.parseInvoiceText = parseInvoiceText;
window.callClaudeExtractInvoiceFull = callClaudeExtractInvoiceFull;
window.callGeminiExtractInvoiceFull = callGeminiExtractInvoiceFull;

