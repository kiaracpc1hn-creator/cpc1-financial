/**
 * CPC1 Financial Vouchers - Vietnamese Number to Words & Formatting Utilities
 */

const VN_DIGITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

function readThreeDigits(n, isFirst) {
  const hundred = Math.floor(n / 100);
  const ten = Math.floor((n % 100) / 10);
  const unit = n % 10;
  let s = '';

  if (!isFirst || hundred > 0) {
    s += VN_DIGITS[hundred] + ' trăm ';
  }
  if (ten === 0 && unit > 0 && (hundred > 0 || !isFirst)) {
    s += 'linh ';
  }
  if (ten >= 2) {
    s += VN_DIGITS[ten] + ' mươi ';
    if (unit === 1) s += 'mốt ';
    else if (unit === 5) s += 'lăm ';
    else if (unit > 0) s += VN_DIGITS[unit] + ' ';
  } else if (ten === 1) {
    s += 'mười ';
    if (unit === 5) s += 'lăm ';
    else if (unit > 0) s += VN_DIGITS[unit] + ' ';
  } else if (ten === 0 && unit > 0) {
    s += VN_DIGITS[unit] + ' ';
  }
  return s.trim();
}

function numberToWords(num, currency = 'VND') {
  num = Math.round(Number(num) || 0);
  if (num === 0) return currency === 'USD' ? 'Không đô la Mỹ.' : 'Không đồng.';
  if (num < 0) return 'Âm ' + numberToWords(Math.abs(num), currency).toLowerCase();

  const units = ['', ' nghìn', ' triệu', ' tỷ', ' nghìn tỷ', ' triệu tỷ'];
  let n = num;
  const groups = [];

  while (n > 0) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }

  const parts = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    if (groups[i] === 0) continue;
    parts.push(readThreeDigits(groups[i], i === groups.length - 1) + units[i]);
  }

  let result = parts.join(', ');
  result = result.charAt(0).toUpperCase() + result.slice(1);
  result += currency === 'USD' ? ' đô la Mỹ' : ' đồng';
  result += ' chẵn.';
  return result;
}

function fmtMoney(n, currency = 'VND') {
  const num = Number(n || 0);
  const formatted = num.toLocaleString('vi-VN');
  return currency === 'USD' ? `${formatted} USD` : `${formatted} VNĐ`;
}

function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function fmtDateVN(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  return `ngày ${dd} tháng ${mm} năm ${yyyy}`;
}

// Export to window
window.numberToWords = numberToWords;
window.fmtMoney = fmtMoney;
window.fmtDate = fmtDate;
window.fmtDateVN = fmtDateVN;
