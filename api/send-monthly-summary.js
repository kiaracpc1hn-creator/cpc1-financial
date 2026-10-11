// api/send-monthly-summary.js
// Serverless Function chạy trên Vercel — được gọi tự động bởi Vercel Cron (xem vercel.json),
// vào ngày 12 hàng tháng. Tổng hợp TOÀN BỘ ĐNTT đã lập và hoá đơn đã được lập ĐNTT trong
// THÁNG TRƯỚC (tháng liền kề trước ngày gửi), KÈM danh sách Tạm ứng quá hạn tính tới thời điểm
// gửi mail (giống mục Tạm ứng quá hạn trong mail nhắc nợ hàng tuần), gửi 1 email báo cáo riêng
// cho từng nhóm (Nhóm EXP / Nhóm Docs), giống cơ chế gửi của api/send-overdue-reminders.js.
//
// Gửi qua Gmail SMTP (dùng App Password) — KHÔNG cần tên miền riêng.
//
// Quy tắc gửi:
//   - From : 1 tài khoản Gmail cố định đại diện Admin (biến môi trường GMAIL_USER)
//   - To   : email cá nhân của từng người có ĐNTT/hoá đơn thuộc nhóm đó trong tháng
//   - CC   : Google Group của đúng nhóm đó
//       • Nhóm Docs -> document-cpc1hn@googlegroups.com
//       • Nhóm EXP  -> exportcpc1hn2018@googlegroups.com
//   - Mục nào không thuộc nhóm nào ("Không") -> vẫn gửi cho cá nhân, không CC nhóm nào.

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const ADMIN_DISPLAY_NAME = process.env.ADMIN_DISPLAY_NAME || 'CPC1 Tài chính';

const ADVANCE_THRESHOLD_DAYS = 30;
const INVOICE_THRESHOLD_DAYS = 15;

const GROUP_CONFIG = {
  EXP: { label: 'Nhóm EXP', groupEmail: 'exportcpc1hn2018@googlegroups.com' },
  DOCS: { label: 'Nhóm Docs', groupEmail: 'document-cpc1hn@googlegroups.com' },
  NONE: { label: 'Không phân nhóm', groupEmail: null }
};

function normalizeGroup(g) {
  const s = String(g || '').toUpperCase();
  if (s.includes('EXP')) return 'EXP';
  if (s.includes('DOC')) return 'DOCS';
  return 'NONE';
}
// Sao chép đúng logic getUserGroup() bên app.js
function getUserGroupLabel(user) {
  if (!user) return 'Không';
  if (user.group) {
    const g = String(user.group).trim();
    if (g.toLowerCase() === 'không' || g.toLowerCase().includes('khong')) return 'Không';
    if (/DOC|CHỨNG TỪ|CHUNG TU|NHẬP|NHAP|IMPORT/i.test(g)) return 'Nhóm Docs';
    if (/EXP|XUẤT|XUAT|EXPORT/i.test(g)) return 'Nhóm EXP';
    return g;
  }
  const dept = String(user.department || '').trim();
  if (!dept) return 'Không';
  if (/EXP|XUẤT|XUAT|EXPORT/i.test(dept)) return 'Nhóm EXP';
  if (/DOC|CHỨNG TỪ|CHUNG TU|NHẬP|NHAP|IMPORT/i.test(dept)) return 'Nhóm Docs';
  return 'Không';
}
function fmtMoney(n, currency) {
  const s = Number(n || 0).toLocaleString('vi-VN');
  return currency === 'USD' ? s + ' USD' : s + ' VNĐ';
}
function fmtDateVN(d) {
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('vi-VN');
}
function monthLabelVN(year, monthIndex0) {
  return `Tháng ${monthIndex0 + 1}/${year}`;
}
function daysBetween(dateStr, now) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 3600 * 24));
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const STATUS_LABEL = {
  draft: 'Nháp',
  pending_signature: 'Chờ ký',
  signed: 'Đã ký',
  completed: 'Đã ký',
  cancelled: 'Đã huỷ'
};

const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function buildSectionHtml(num, color, title, cols, rowsHtml, emptyText) {
  return `
      <div style="padding:18px 28px;background:#fff;">
        <div style="display:flex;align-items:center;justify-content:center;gap:8px;font-size:14.5px;font-weight:700;margin:0 0 10px;padding-bottom:8px;border-bottom:2px solid #F1F5F9;color:#0F172A;font-family:${EMAIL_FONT};text-align:center;">
          <span style="width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:12px;font-family:${EMAIL_FONT};display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;">${num}</span>
          <span>${title}</span>
        </div>
        ${rowsHtml ? `
        <table style="border-collapse:collapse;width:100%;font-size:12.5px;font-family:${EMAIL_FONT};text-align:center;">
          <tr style="background:#F8FAFC;">${cols.map(c => `<th style="border:1px solid #E2E8F0;padding:7px 9px;font-size:11px;text-transform:uppercase;color:#64748B;text-align:center;">${c}</th>`).join('')}</tr>
          ${rowsHtml}
        </table>` : `<div style="color:#15803D;background:#F0FDF4;border:1px dashed #86EFAC;border-radius:8px;padding:10px 14px;font-size:12.5px;font-family:${EMAIL_FONT};text-align:center;">${emptyText}</div>`}
      </div>`;
}

function buildReportHtml(groupLabel, monthLabel, now, advanceRows, unmadeInvoiceRows, docRows, invRows, counts, totalDocAmountVnd, totalInvAmountVnd) {
  return `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
    </head>
    <body style="margin:0;padding:24px;background:#EEF1F5;font-family:${EMAIL_FONT};">
      <div style="max-width:860px;margin:0 auto;font-family:${EMAIL_FONT};">
        <div style="background:#0A2F52;color:#fff;padding:22px 28px;border-radius:10px 10px 0 0;text-align:center;">
          <h1 style="margin:0 0 4px;font-size:20px;font-family:${EMAIL_FONT};font-weight:700;letter-spacing:.01em;">📊 Báo cáo Tổng hợp ĐNTT ${esc(monthLabel)} — ${esc(groupLabel)}</h1>
          <p style="margin:0;font-size:12.5px;color:#B7C6D6;font-family:${EMAIL_FONT};">Gửi tự động ngày ${fmtDateVN(now)} · Tổng hợp định kỳ hàng tháng</p>
        </div>

        <div style="display:flex;gap:14px;padding:20px 28px 6px;background:#fff;flex-wrap:wrap;font-family:${EMAIL_FONT};">
          <div style="flex:1;min-width:150px;border:1px solid #E2E8F0;border-top:3px solid #E11D48;border-radius:10px;padding:14px 16px;text-align:center;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#9F1239;">⏰ Tạm ứng quá hạn</div>
            <div style="font-size:25px;font-weight:700;margin-top:6px;color:#E11D48;font-family:${EMAIL_FONT};">${counts.advances} khoản</div>
            <div style="font-size:11.5px;color:#64748B;margin-top:2px;">&gt; ${ADVANCE_THRESHOLD_DAYS} ngày chưa hoàn ứng (tính tới ngày gửi)</div>
          </div>
          <div style="flex:1;min-width:150px;border:1px solid #E2E8F0;border-top:3px solid #D97706;border-radius:10px;padding:14px 16px;text-align:center;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#92400E;">📥 Hoá đơn chưa làm ĐNTT</div>
            <div style="font-size:25px;font-weight:700;margin-top:6px;color:#D97706;font-family:${EMAIL_FONT};">${counts.unmadeInvoices} hoá đơn</div>
            <div style="font-size:11.5px;color:#64748B;margin-top:2px;">&gt; ${INVOICE_THRESHOLD_DAYS} ngày chưa lập phiếu (tính tới ngày gửi)</div>
          </div>
          <div style="flex:1;min-width:150px;border:1px solid #E2E8F0;border-top:3px solid #0D9488;border-radius:10px;padding:14px 16px;text-align:center;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#0F766E;">📄 ĐNTT đã lập trong tháng</div>
            <div style="font-size:25px;font-weight:700;margin-top:6px;color:#0D9488;font-family:${EMAIL_FONT};">${counts.docs} phiếu</div>
            <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Tổng giá trị: ${esc(fmtMoney(totalDocAmountVnd, 'VND'))}</div>
          </div>
          <div style="flex:1;min-width:150px;border:1px solid #E2E8F0;border-top:3px solid #0284C7;border-radius:10px;padding:14px 16px;text-align:center;">
            <div style="font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#0369A1;">🧾 Hoá đơn đã lập ĐNTT trong tháng</div>
            <div style="font-size:25px;font-weight:700;margin-top:6px;color:#0284C7;font-family:${EMAIL_FONT};">${counts.invoices} hoá đơn</div>
            <div style="font-size:11.5px;color:#64748B;margin-top:2px;">Tổng giá trị: ${esc(fmtMoney(totalInvAmountVnd, 'VND'))}</div>
          </div>
        </div>

        ${buildSectionHtml('1', '#E11D48', `Danh sách Tạm ứng quá hạn &gt; ${ADVANCE_THRESHOLD_DAYS} ngày chưa Hoàn ứng (tính tới ngày gửi)`,
          ['Mã phiếu', 'Người tạm ứng', 'Số tiền', 'Quá hạn'], advanceRows, 'Không có khoản tạm ứng nào quá hạn.')}

        ${buildSectionHtml('2', '#D97706', `Danh sách Hoá đơn &gt; ${INVOICE_THRESHOLD_DAYS} ngày chưa lập ĐNTT (tính tới ngày gửi)`,
          ['Số hoá đơn', 'Người phụ trách', 'Số tiền', 'Quá hạn'], unmadeInvoiceRows, 'Không có hoá đơn nào quá hạn chưa lập ĐNTT.')}

        ${buildSectionHtml('3', '#0D9488', `Danh sách ĐNTT đã lập trong ${esc(monthLabel)}`,
          ['Mã phiếu', 'Loại', 'Người đề nghị', 'Ngày lập', 'Số tiền', 'Trạng thái'], docRows, 'Không có ĐNTT nào được lập trong tháng này.')}

        ${buildSectionHtml('4', '#0284C7', `Danh sách Hoá đơn đã được lập ĐNTT trong ${esc(monthLabel)}`,
          ['Số hoá đơn', 'Người phụ trách', 'Nội dung', 'Số tiền'], invRows, 'Không có hoá đơn nào được lập ĐNTT trong tháng này.')}

        <div style="padding:16px 28px;background:#F8FAFC;font-size:12px;color:#64748B;border-top:1px solid #E2E8F0;border-radius:0 0 10px 10px;font-family:${EMAIL_FONT};text-align:center;">
          Email tự động từ Hệ thống Phiếu tài chính CPC1. Không cần trả lời email này.
        </div>
      </div>
    </body>
    </html>`;
}

let cachedTransporter = null;
function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
  return cachedTransporter;
}

module.exports = async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GMAIL_USER || !GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: 'Thiếu biến môi trường SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / GMAIL_USER / GMAIL_APP_PASSWORD' });
  }

  // Thêm ?dryRun=1 vào cuối URL để CHỈ XEM TRƯỚC sẽ gửi cho ai, KHÔNG gửi mail thật.
  const isDryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  // Thêm ?testEmail=you@gmail.com để gửi TOÀN BỘ mail test về đúng 1 địa chỉ này (không gửi
  // cho người thật, không CC vào Google Group) — dùng để xem thử mail thật trông thế nào.
  const testEmailOverride = req.query && req.query.testEmail ? String(req.query.testEmail).trim() : null;

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const transporter = getTransporter();
    const now = new Date();

    // Tháng trước (tháng liền kề trước ngày gửi — gửi ngày 12 nên luôn đủ dữ liệu tháng trước)
    const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevYear = prevMonthDate.getFullYear();
    const prevMonthIdx0 = prevMonthDate.getMonth();
    const rangeStart = new Date(prevYear, prevMonthIdx0, 1);
    const rangeEnd = new Date(prevYear, prevMonthIdx0 + 1, 1); // đầu tháng này (exclusive)
    const monthLabel = monthLabelVN(prevYear, prevMonthIdx0);

    const { data: voucherRows, error: vErr } = await supabase.from('cpc1_vouchers_list').select('id, data');
    if (vErr) throw vErr;
    const documents = (voucherRows || []).map(r => r.data).filter(Boolean);

    const { data: usersRow } = await supabase.from('cpc1_store').select('value').eq('key', 'users').maybeSingle();
    const users = usersRow && usersRow.value ? JSON.parse(usersRow.value) : [];

    const { data: invoicesRow } = await supabase.from('cpc1_store').select('value').eq('key', 'invoices').maybeSingle();
    const invoices = invoicesRow && invoicesRow.value ? JSON.parse(invoicesRow.value) : [];

    const findEmail = (idOrName) => {
      const u = users.find(x => x.id === idOrName || x.name === idOrName);
      return u && u.email ? u.email.trim() : null;
    };
    const findUser = (idOrName) => users.find(x => x.id === idOrName || x.name === idOrName) || null;
    const requesterGroupKey = (requesterId, requesterName) => {
      const u = findUser(requesterId) || findUser(requesterName);
      return normalizeGroup(getUserGroupLabel(u));
    };
    const inRange = (dateStr) => {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return false;
      return d >= rangeStart && d < rangeEnd;
    };
    function computeTotal(doc) {
      const arr = [...(doc.items || []), ...(doc.spentItems || [])];
      return arr.reduce((s, it) => s + (Number(it.amount) || 0), 0);
    }

    // ---- MỤC 0: Tạm ứng quá hạn > 30 ngày chưa hoàn ứng (tính tới thời điểm gửi, không giới hạn theo tháng) ----
    const overdueAdvances = documents.filter(d => {
      if (!d || d.type !== 'advance' || d.status !== 'signed') return false;
      const isReimbursed = documents.some(r => r.type === 'reimbursement' && (r.advanceRefs || []).includes(d.id));
      if (isReimbursed) return false;
      return daysBetween(d.documentDate || d.createdAt, now) > ADVANCE_THRESHOLD_DAYS;
    }).map(d => ({ doc: d, daysOverdue: daysBetween(d.documentDate || d.createdAt, now) }));

    // ---- MỤC 2: Hoá đơn quá hạn > 15 ngày chưa lập ĐNTT (tính tới thời điểm gửi, không giới hạn theo tháng) ----
    function invoiceIsUsed(rec) {
      const invNum = (rec.invoiceNumber || '').trim();
      if (!invNum) return false;
      return documents.some(d => {
        const arr = [...(d.items || []), ...(d.spentItems || [])];
        return arr.some(it => it.invoiceNo && it.invoiceNo.includes(invNum));
      });
    }
    const overdueInvoices = invoices.filter(r => {
      if (invoiceIsUsed(r)) return false;
      return daysBetween(r.date || r.uploadedAt, now) > INVOICE_THRESHOLD_DAYS;
    }).map(r => ({ rec: r, daysOverdue: daysBetween(r.date || r.uploadedAt, now) }));

    // ---- MỤC 1: ĐNTT đã lập trong tháng (mọi trạng thái, trừ đã huỷ) ----
    const docsThisMonth = documents.filter(d => {
      if (!d || d.status === 'cancelled') return false;
      return inRange(d.documentDate || d.createdAt);
    });

    // ---- MỤC 2: Hoá đơn đã được lập ĐNTT trong tháng (hoá đơn được dùng trong các ĐNTT ở Mục 1) ----
    const usedInvoiceNos = new Set();
    docsThisMonth.forEach(d => {
      const arr = [...(d.items || []), ...(d.spentItems || [])];
      arr.forEach(it => { if (it.invoiceNo && it.invoiceNo.trim()) usedInvoiceNos.add(it.invoiceNo.trim()); });
    });
    const invoicesThisMonth = invoices.filter(r => {
      const invNum = (r.invoiceNumber || '').trim();
      if (!invNum) return false;
      return Array.from(usedInvoiceNos).some(no => no.includes(invNum));
    });

    if (overdueAdvances.length === 0 && overdueInvoices.length === 0 && docsThisMonth.length === 0 && invoicesThisMonth.length === 0) {
      return res.status(200).json({ message: `Không có tạm ứng quá hạn / hoá đơn chưa làm ĐNTT / ĐNTT / hoá đơn nào trong ${monthLabel} — không gửi email.` });
    }

    // ---- Chia theo nhóm (EXP / Docs / Không) ----
    const buckets = {
      EXP: { advances: [], unmadeInvoices: [], docs: [], invoices: [] },
      DOCS: { advances: [], unmadeInvoices: [], docs: [], invoices: [] },
      NONE: { advances: [], unmadeInvoices: [], docs: [], invoices: [] }
    };
    overdueAdvances.forEach(o => buckets[requesterGroupKey(o.doc.requesterId, o.doc.requesterName)].advances.push(o));
    overdueInvoices.forEach(o => buckets[requesterGroupKey(o.rec.requesterId, o.rec.requesterName)].unmadeInvoices.push(o));
    docsThisMonth.forEach(d => buckets[requesterGroupKey(d.requesterId, d.requesterName)].docs.push(d));
    invoicesThisMonth.forEach(r => buckets[requesterGroupKey(r.requesterId, r.requesterName)].invoices.push(r));

    const sendResults = [];

    for (const groupKey of Object.keys(buckets)) {
      const bucket = buckets[groupKey];
      const total = bucket.advances.length + bucket.unmadeInvoices.length + bucket.docs.length + bucket.invoices.length;
      if (total === 0) continue;

      const cfg = GROUP_CONFIG[groupKey];

      const advanceRows = bucket.advances.map(o => `
        <tr>
          <td><b style="font-family:Consolas,Menlo,Monaco,monospace;">${esc(o.doc.docNo || o.doc.formCode || '')}</b></td>
          <td>${esc(o.doc.requesterName)}</td>
          <td style="text-align:right;font-family:Consolas,Menlo,Monaco,monospace;">${esc(fmtMoney((o.doc.items || []).reduce((s, it) => s + (it.amount || 0), 0), o.doc.currency))}</td>
          <td style="text-align:center;color:#E11D48;font-weight:700;">${o.daysOverdue} ngày</td>
        </tr>`).join('');

      const unmadeInvoiceRows = bucket.unmadeInvoices.map(o => `
        <tr>
          <td><b style="font-family:Consolas,Menlo,Monaco,monospace;">${esc(o.rec.seriesNo ? o.rec.seriesNo + '|' + o.rec.invoiceNumber : (o.rec.invoiceNumber || ''))}</b></td>
          <td>${esc(o.rec.requesterName)}</td>
          <td style="text-align:right;font-family:Consolas,Menlo,Monaco,monospace;">${esc(fmtMoney(o.rec.amount, o.rec.currency))}</td>
          <td style="text-align:center;color:#D97706;font-weight:700;">${o.daysOverdue} ngày</td>
        </tr>`).join('');

      const docRows = bucket.docs.map(d => `
        <tr>
          <td><b style="font-family:Consolas,Menlo,Monaco,monospace;">${esc(d.docNo || d.formCode || '')}</b></td>
          <td>${esc(d.title || d.type || '')}</td>
          <td>${esc(d.requesterName)}</td>
          <td style="text-align:center;">${esc(fmtDateVN(d.documentDate || d.createdAt))}</td>
          <td style="text-align:right;font-family:Consolas,Menlo,Monaco,monospace;">${esc(fmtMoney(computeTotal(d), d.currency))}</td>
          <td style="text-align:center;">${esc(STATUS_LABEL[d.status] || d.status || '')}</td>
        </tr>`).join('');

      const invRows = bucket.invoices.map(r => `
        <tr>
          <td><b style="font-family:Consolas,Menlo,Monaco,monospace;">${esc(r.seriesNo ? r.seriesNo + '|' + r.invoiceNumber : (r.invoiceNumber || ''))}</b></td>
          <td>${esc(r.requesterName)}</td>
          <td>${esc(r.note || '')}</td>
          <td style="text-align:right;font-family:Consolas,Menlo,Monaco,monospace;">${esc(fmtMoney(r.amount, r.currency))}</td>
        </tr>`).join('');

      const totalDocAmount = bucket.docs.reduce((s, d) => s + computeTotal(d), 0);
      const totalInvAmount = bucket.invoices.reduce((s, r) => s + (Number(r.amount) || 0), 0);

      // Gom email cá nhân liên quan trong nhóm này
      const toSet = new Set();
      bucket.advances.forEach(o => { const e = findEmail(o.doc.requesterId) || findEmail(o.doc.requesterName); if (e) toSet.add(e); });
      bucket.unmadeInvoices.forEach(o => { const e = findEmail(o.rec.requesterId) || findEmail(o.rec.requesterName); if (e) toSet.add(e); });
      bucket.docs.forEach(d => { const e = findEmail(d.requesterId) || findEmail(d.requesterName); if (e) toSet.add(e); });
      bucket.invoices.forEach(r => { const e = findEmail(r.requesterId) || findEmail(r.requesterName); if (e) toSet.add(e); });

      if (toSet.size === 0) {
        sendResults.push({ group: groupKey, skipped: 'Không tìm được email cá nhân nào để gửi.' });
        continue;
      }

      const reportHtml = buildReportHtml(cfg.label, monthLabel, now, advanceRows, unmadeInvoiceRows, docRows, invRows, {
        advances: bucket.advances.length, unmadeInvoices: bucket.unmadeInvoices.length, docs: bucket.docs.length, invoices: bucket.invoices.length
      }, totalDocAmount, totalInvAmount);

      const subjectPrefix = testEmailOverride ? '[TEST] ' : '';
      const subject = `${subjectPrefix}[CPC1HN] Báo cáo tổng hợp ĐNTT ${monthLabel} — ${cfg.label}`;

      const mailOptions = {
        from: `"${ADMIN_DISPLAY_NAME}" <${GMAIL_USER}>`,
        to: testEmailOverride || Array.from(toSet).join(', '),
        subject,
        html: reportHtml
      };
      if (cfg.groupEmail && !testEmailOverride) mailOptions.cc = cfg.groupEmail;

      if (isDryRun) {
        // Chế độ xem thử: KHÔNG gửi mail, chỉ trả về sẽ gửi cho ai
        sendResults.push({ group: groupKey, dryRun: true, to: testEmailOverride ? [testEmailOverride] : Array.from(toSet), cc: (!testEmailOverride && cfg.groupEmail) || null, subject, counts: { advances: bucket.advances.length, unmadeInvoices: bucket.unmadeInvoices.length, docs: bucket.docs.length, invoices: bucket.invoices.length } });
        continue;
      }

      const info = await transporter.sendMail(mailOptions);
      sendResults.push({ group: groupKey, to: testEmailOverride ? [testEmailOverride] : Array.from(toSet), cc: (!testEmailOverride && cfg.groupEmail) || null, counts: { advances: bucket.advances.length, unmadeInvoices: bucket.unmadeInvoices.length, docs: bucket.docs.length, invoices: bucket.invoices.length }, messageId: info.messageId });
    }

    return res.status(200).json({ ok: true, dryRun: isDryRun, month: monthLabel, sendResults });
  } catch (err) {
    console.error('[send-monthly-summary] Error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
};
