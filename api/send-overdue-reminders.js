// api/send-overdue-reminders.js
// Serverless Function chạy trên Vercel — được gọi tự động bởi Vercel Cron (xem vercel.json),
// KHÔNG cần ai mở web. Tự đọc dữ liệu từ Supabase, gửi 1 EMAIL BÁO CÁO TỔNG HỢP RIÊNG cho
// từng nhóm (Nhóm EXP / Nhóm Docs), gồm 2 mục: Tạm ứng quá hạn / Hoá đơn chưa lập ĐNTT.
//
// (Mục "ĐNTT đã trình ký chưa có bản ký" đã được bỏ — quy trình ký giờ gộp làm 1 bước,
// Nháp chuyển thẳng sang Đã ký khi đính kèm bản scan chữ ký, không còn trạng thái chờ ký nữa.)
//
// Gửi qua Gmail SMTP (dùng App Password) — KHÔNG cần tên miền riêng, vì công ty đang dùng
// email @gmail.com thường, không có domain riêng để xác minh với dịch vụ email ngoài (Resend...).
//
// Quy tắc gửi:
//   - From : 1 tài khoản Gmail cố định đại diện Admin (đặt ở biến môi trường GMAIL_USER)
//   - To   : email cá nhân của từng người có mục quá hạn thuộc nhóm đó
//   - CC   : Google Group của đúng nhóm đó
//       • Nhóm Docs -> document-cpc1hn@googlegroups.com
//       • Nhóm EXP  -> exportcpc1hn2018@googlegroups.com
//   - Mục nào không thuộc nhóm nào ("Không") -> vẫn gửi cho cá nhân, không CC nhóm nào.

const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // Khoá "service_role", KHÔNG phải anon key
const GMAIL_USER = process.env.GMAIL_USER; // VD: cpc1.taichinh@gmail.com — tài khoản Gmail dùng để gửi
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD; // Mật khẩu ứng dụng 16 ký tự (không phải mật khẩu đăng nhập thường)
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
// Sao chép đúng logic getUserGroup() bên app.js — LUÔN lấy nhóm hiện tại của nhân viên
// từ hồ sơ "Quản lý thành viên", KHÔNG dùng trường group cũ lưu sẵn trên từng phiếu/hoá đơn
// (vì phiếu cũ có thể lưu nhóm đã lỗi thời nếu nhân viên được đổi nhóm sau đó).
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
function daysBetween(dateStr, now) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 0;
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 3600 * 24));
}
function fmtMoney(n, currency) {
  const s = Number(n || 0).toLocaleString('vi-VN');
  return currency === 'USD' ? s + ' USD' : s + ' VNĐ';
}
function fmtDateVN(d) {
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSectionHtml(num, color, title, cols, rowsHtml, emptyText) {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  return `
      <div style="padding:18px 28px;background:#fff;">
        <table role="presentation" width="100%" style="border-collapse:collapse;margin:0 0 10px;">
          <tr>
            <td align="left" style="padding:0;">
              <table role="presentation" style="border-collapse:collapse;">
                <tr>
                  <td style="width:26px;padding:0 8px 0 0;vertical-align:middle;">
                    <table role="presentation" style="border-collapse:collapse;"><tr><td style="width:22px;height:22px;border-radius:50%;background:${color};color:#fff;font-size:12px;font-family:${font};text-align:center;vertical-align:middle;">${num}</td></tr></table>
                  </td>
                  <td style="vertical-align:middle;font-size:14.5px;font-weight:700;color:#0F172A;font-family:${font};">${title}</td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
        <div style="border-bottom:2px solid #F1F5F9;margin:0 0 12px;"></div>
        <table style="border-collapse:collapse;width:100%;font-size:12.5px;font-family:${font};text-align:center;">
          <tr style="background:#F8FAFC;">${cols.map(c => `<th style="border:1px solid #E2E8F0;padding:7px 9px;font-size:11px;text-transform:uppercase;color:#64748B;text-align:center;">${c}</th>`).join('')}</tr>
          ${rowsHtml || `<tr><td colspan="${cols.length}" style="border:1px solid #E2E8F0;padding:14px;color:#15803D;background:#F0FDF4;text-align:center;">${emptyText}</td></tr>`}
        </table>
      </div>`;
}

const EMAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function buildReportHtml(groupLabel, now, advanceRows, invoiceRows, counts) {
  return `
    <!DOCTYPE html>
    <html lang="vi">
    <head>
      <meta charset="UTF-8">
    </head>
    <body style="margin:0;padding:24px;background:#EEF1F5;font-family:${EMAIL_FONT};">
      <div style="max-width:820px;margin:0 auto;font-family:${EMAIL_FONT};">
        <div style="background:#0A2F52;color:#fff;padding:22px 28px;border-radius:10px 10px 0 0;text-align:center;">
          <h1 style="margin:0 0 4px;font-size:20px;font-family:${EMAIL_FONT};font-weight:700;letter-spacing:.01em;">📊 Báo cáo Cảnh báo Tài chính CPC1 — ${esc(groupLabel)}</h1>
          <p style="margin:0;font-size:12.5px;color:#B7C6D6;font-family:${EMAIL_FONT};">Cập nhật ngày ${fmtDateVN(now)} · Tự động gửi định kỳ hàng tuần</p>
        </div>

        <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:7px 0;padding:20px 24px 10px;background:#fff;font-family:${EMAIL_FONT};">
          <tr>
            <td style="width:50%;border:1px solid #E2E8F0;border-top:3px solid #E11D48;border-radius:10px;padding:18px 16px;text-align:center;vertical-align:top;">
              <div style="font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#9F1239;">⏰ Tạm ứng quá hạn</div>
              <div style="font-size:30px;font-weight:700;margin-top:8px;color:#E11D48;font-family:${EMAIL_FONT};">${counts.advances} khoản</div>
              <div style="font-size:12px;color:#64748B;margin-top:4px;">&gt; ${ADVANCE_THRESHOLD_DAYS} ngày chưa hoàn ứng</div>
            </td>
            <td style="width:50%;border:1px solid #E2E8F0;border-top:3px solid #0284C7;border-radius:10px;padding:18px 16px;text-align:center;vertical-align:top;">
              <div style="font-size:12px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;color:#0369A1;">📥 Hoá đơn chưa ĐNTT</div>
              <div style="font-size:30px;font-weight:700;margin-top:8px;color:#0284C7;font-family:${EMAIL_FONT};">${counts.invoices} hoá đơn</div>
              <div style="font-size:12px;color:#64748B;margin-top:4px;">&gt; ${INVOICE_THRESHOLD_DAYS} ngày chưa lập phiếu</div>
            </td>
          </tr>
        </table>

        ${buildSectionHtml('1', '#E11D48', `Danh sách Tạm ứng quá hạn &gt; ${ADVANCE_THRESHOLD_DAYS} ngày chưa Hoàn ứng`,
          ['Mã phiếu', 'Người tạm ứng', 'Số tiền', 'Quá hạn'], advanceRows, 'Không có khoản tạm ứng nào quá hạn.')}

        ${buildSectionHtml('2', '#0284C7', `Danh sách Hoá đơn &gt; ${INVOICE_THRESHOLD_DAYS} ngày chưa lập ĐNTT`,
          ['Số hoá đơn', 'Ngày hoá đơn', 'Người phụ trách', 'Số tiền', 'Quá hạn'], invoiceRows, 'Không có hoá đơn nào quá hạn.')}

        <div style="padding:16px 28px;background:#F8FAFC;font-size:12px;color:#64748B;border-top:1px solid #E2E8F0;border-radius:0 0 10px 10px;font-family:${EMAIL_FONT};text-align:center;">
          Email tự động từ Hệ thống Phiếu tài chính CPC1. Vui lòng khẩn trương xử lý các mục trên. Không cần trả lời email này.
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
  // BẮT BUỘC có mã bí mật CRON_SECRET (đặt trong Vercel → Environment Variables).
  // Vercel tự gửi mã này khi chạy lịch định kỳ. Khi muốn gọi thủ công để xem thử, thêm &key=MÃ_BÍ_MẬT vào link.
  // Không có mã đúng thì từ chối — tránh người lạ gọi link này để gửi mail hàng loạt hoặc xem danh sách người nhận.
  const secret = process.env.CRON_SECRET;
  const provided = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || String((req.query && req.query.key) || '');
  if (!secret || provided !== secret) {
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

    const { data: voucherRows, error: vErr } = await supabase.from('cpc1_vouchers_list').select('id, data');
    if (vErr) throw vErr;
    // Loại bỏ các phiếu đã nằm trong Thùng rác: đôi khi bản xoá trên bảng phiếu chưa kịp thực hiện
    // (lỗi mạng thoáng qua), khiến phiếu "ma" vẫn nằm trên Cloud dù người dùng không còn thấy nó trong web.
    let trashIds = new Set();
    try {
      const { data: trashRow } = await supabase.from('cpc1_store').select('value').eq('key', 'trash').maybeSingle();
      const trashList = trashRow && trashRow.value ? JSON.parse(trashRow.value) : [];
      trashIds = new Set((Array.isArray(trashList) ? trashList : []).map(t => t && t.id).filter(Boolean));
    } catch (e) { /* không đọc được thùng rác thì bỏ qua bước lọc */ }
    const documents = (voucherRows || []).map(r => r.data).filter(d => d && !trashIds.has(d.id));

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

    // ---- MỤC 1: Tạm ứng quá hạn ----
    const overdueAdvances = documents.filter(d => {
      if (!d || d.type !== 'advance' || d.status !== 'signed') return false;
      const isReimbursed = documents.some(r => r.type === 'reimbursement' && (r.advanceRefs || []).includes(d.id));
      if (isReimbursed) return false;
      return daysBetween(d.documentDate || d.createdAt, now) > ADVANCE_THRESHOLD_DAYS;
    }).map(d => ({ doc: d, daysOverdue: daysBetween(d.documentDate || d.createdAt, now) }));

    // ---- MỤC 2: Hoá đơn quá hạn chưa lập ĐNTT ----
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

    if (overdueAdvances.length === 0 && overdueInvoices.length === 0) {
      return res.status(200).json({ message: 'Không có mục nào cần cảnh báo hôm nay — không gửi email.' });
    }

    // ---- Chia theo nhóm (EXP / Docs / Không) ----
    const buckets = {
      EXP: { advances: [], invoices: [] },
      DOCS: { advances: [], invoices: [] },
      NONE: { advances: [], invoices: [] }
    };
    overdueAdvances.forEach(o => buckets[requesterGroupKey(o.doc.requesterId, o.doc.requesterName)].advances.push(o));
    overdueInvoices.forEach(o => buckets[requesterGroupKey(o.rec.requesterId, o.rec.requesterName)].invoices.push(o));

    const sendResults = [];

    for (const groupKey of Object.keys(buckets)) {
      const bucket = buckets[groupKey];
      const total = bucket.advances.length + bucket.invoices.length;
      if (total === 0) continue;

      const cfg = GROUP_CONFIG[groupKey];

      const advanceRows = bucket.advances.map(o => `
        <tr>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;"><b style="font-family:Consolas,Menlo,Monaco,monospace;">${esc(o.doc.docNo || o.doc.formCode || '')}</b></td>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;">${esc(o.doc.requesterName)}</td>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;font-family:Consolas,Menlo,Monaco,monospace;">${esc(fmtMoney((o.doc.items || []).reduce((s, it) => s + (it.amount || 0), 0), o.doc.currency))}</td>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;color:#E11D48;font-weight:700;">${o.daysOverdue} ngày</td>
        </tr>`).join('');

      const invoiceRows = bucket.invoices.map(o => `
        <tr>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;"><b style="font-family:Consolas,Menlo,Monaco,monospace;">${esc(o.rec.seriesNo ? o.rec.seriesNo + '|' + o.rec.invoiceNumber : (o.rec.invoiceNumber || ''))}</b></td>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;">${esc(fmtDateVN(o.rec.date || o.rec.uploadedAt))}</td>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;">${esc(o.rec.requesterName)}</td>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;font-family:Consolas,Menlo,Monaco,monospace;">${esc(fmtMoney(o.rec.amount, o.rec.currency))}</td>
          <td style="padding:7px 9px;border:1px solid #E2E8F0;text-align:center;color:#E11D48;font-weight:700;">${o.daysOverdue} ngày</td>
        </tr>`).join('');

      // Gom email cá nhân liên quan trong nhóm này
      const toSet = new Set();
      bucket.advances.forEach(o => { const e = findEmail(o.doc.requesterId) || findEmail(o.doc.requesterName); if (e) toSet.add(e); });
      bucket.invoices.forEach(o => { const e = findEmail(o.rec.requesterId) || findEmail(o.rec.requesterName); if (e) toSet.add(e); });

      if (toSet.size === 0) {
        sendResults.push({ group: groupKey, skipped: 'Không tìm được email cá nhân nào để gửi.' });
        continue;
      }

      const reportHtml = buildReportHtml(cfg.label, now, advanceRows, invoiceRows, {
        advances: bucket.advances.length, invoices: bucket.invoices.length
      });

      const subjectPrefix = testEmailOverride ? '[TEST] ' : '';
      const subject = `${subjectPrefix}[CPC1HN] Báo cáo Cảnh báo Tài chính tuần — ${cfg.label} (${total} mục)`;

      const mailOptions = {
        from: `"${ADMIN_DISPLAY_NAME}" <${GMAIL_USER}>`,
        to: testEmailOverride || Array.from(toSet).join(', '),
        subject,
        html: reportHtml
      };
      if (cfg.groupEmail && !testEmailOverride) mailOptions.cc = cfg.groupEmail;

      if (isDryRun) {
        // Chế độ xem thử: KHÔNG gửi mail, chỉ trả về sẽ gửi cho ai
        sendResults.push({ group: groupKey, dryRun: true, to: testEmailOverride ? [testEmailOverride] : Array.from(toSet), cc: (!testEmailOverride && cfg.groupEmail) || null, subject, counts: { advances: bucket.advances.length, invoices: bucket.invoices.length } });
        continue;
      }

      const info = await transporter.sendMail(mailOptions);
      sendResults.push({ group: groupKey, to: testEmailOverride ? [testEmailOverride] : Array.from(toSet), cc: (!testEmailOverride && cfg.groupEmail) || null, counts: { advances: bucket.advances.length, invoices: bucket.invoices.length }, messageId: info.messageId });
    }

    return res.status(200).json({ ok: true, dryRun: isDryRun, sendResults });
  } catch (err) {
    console.error('[send-overdue-reminders] Error:', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
};
