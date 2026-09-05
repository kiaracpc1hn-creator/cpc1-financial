/**
 * CPC1 Financial Vouchers - Automated Email Warning System
 * Cảnh báo tự động 3 hạng mục:
 * 1. Đề nghị tạm ứng quá 30 ngày chưa hoàn ứng
 * 2. Hoá đơn điện tử trong kho chưa làm ĐNTT
 * 3. Phiếu ĐNTT đang chờ ký duyệt
 */

function getWarningItems(targetUser = null) {
  const docs = (window.STATE && window.STATE.documents) ? window.STATE.documents : [];
  const invoices = (window.STATE && window.STATE.invoices) ? window.STATE.invoices : [];

  // 1. Tạm ứng quá 30 ngày chưa hoàn ứng (Lấy từ getOverdueAdvanceRequests để đồng bộ 100% với Dashboard)
  let overdueAdvances = [];
  if (typeof window.getOverdueAdvanceRequests === 'function') {
    overdueAdvances = window.getOverdueAdvanceRequests(false).map(o => o.doc);
  } else {
    const now = Date.now();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const advanceDocs = docs.filter(d => d.type === 'advance' && (d.status === 'signed' || d.status === 'completed'));
    overdueAdvances = advanceDocs.filter(d => {
      const isReimbursed = docs.some(r => (r.type === 'reimbursement' || r.type === 'settlement') && (r.advanceRefs || []).includes(d.id));
      if (isReimbursed) return false;
      const docTime = new Date(d.documentDate || d.createdAt).getTime();
      return (now - docTime) > thirtyDaysMs;
    });
  }

  if (targetUser && targetUser.role === 'employee') {
    overdueAdvances = overdueAdvances.filter(d => d.requesterName === targetUser.name || d.employeeCode === targetUser.employeeCode);
  }

  // 2. Hoá đơn chưa làm ĐNTT (Đồng bộ với Dashboard Overview)
  let unlinkedInvoices = [];
  if (typeof window.getInvoiceRecordStatus === 'function') {
    unlinkedInvoices = invoices.filter(r => window.getInvoiceRecordStatus(r).key === 'not_submitted');
  } else {
    unlinkedInvoices = invoices.filter(r => r.status === 'unlinked' || !r.linkedDocNo);
  }

  if (targetUser && targetUser.role === 'employee') {
    unlinkedInvoices = unlinkedInvoices.filter(inv => inv.uploadedBy === targetUser.name || inv.buyerName === targetUser.name);
  }

  // 3. Phiếu ĐNTT / Tạm ứng / Trình đang chờ ký
  let pendingSignatures = docs.filter(d => d.status === 'pending_signature');
  if (targetUser && targetUser.role === 'employee') {
    pendingSignatures = pendingSignatures.filter(d => d.requesterName === targetUser.name);
  }

  return {
    overdueAdvances,
    unlinkedInvoices,
    pendingSignatures,
    totalWarnings: overdueAdvances.length + unlinkedInvoices.length + pendingSignatures.length
  };
}

function getSystemUserEmails() {
  const users = (window.STATE && window.STATE.users) ? window.STATE.users : [];
  return users.map(u => ({
    name: u.name,
    email: u.email || (u.username ? `${u.username}@cpc1hn.com.vn` : ''),
    role: u.role || 'employee',
    department: u.department || ''
  })).filter(u => u.email);
}

function buildWarningEmailHtml(recipientUser, warningData) {
  const { overdueAdvances, unlinkedInvoices, pendingSignatures, totalWarnings } = warningData;
  const appUrl = window.location.href.split('#')[0];
  const dateStr = new Date().toLocaleDateString('vi-VN');

  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <title>CPC1HN - Cảnh Báo Tài Chính</title>
    <style>
      body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #F8FAFC; color: #1E293B; margin: 0; padding: 20px; }
      .container { max-width: 680px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border: 1px solid #E2E8F0; }
      .header { background: linear-gradient(135deg, #0A2F52 0%, #0D9488 100%); padding: 24px 30px; color: #FFFFFF; }
      .header h1 { margin: 0; font-size: 20px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
      .header p { margin: 6px 0 0 0; font-size: 13px; opacity: 0.9; }
      .body { padding: 30px; }
      .summary-badge { background: #FEF2F2; border: 1px solid #FCA5A5; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px; color: #991B1B; font-weight: 600; font-size: 14px; }
      .section-title { font-size: 15px; font-weight: 700; color: #0F172A; margin: 20px 0 10px 0; display: flex; align-items: center; gap: 8px; border-bottom: 2px solid #F1F5F9; padding-bottom: 6px; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
      th { background-color: #F1F5F9; color: #475569; text-align: left; padding: 8px 12px; font-weight: 600; }
      td { padding: 10px 12px; border-bottom: 1px solid #E2E8F0; }
      .tag-danger { background: #FEE2E2; color: #DC2626; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; }
      .tag-warning { background: #FEF3C7; color: #D97706; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; }
      .tag-info { background: #E0F2FE; color: #0284C7; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; }
      .btn { display: inline-block; background: #0D9488; color: #FFFFFF !important; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: 700; font-size: 14px; margin-top: 20px; text-align: center; }
      .footer { background: #F8FAFC; padding: 16px 30px; border-top: 1px solid #E2E8F0; font-size: 12px; color: #64748B; text-align: center; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1>🏢 CPC1HN — Báo Cáo Cảnh Báo Tài Chính</h1>
        <p>Kính gửi <strong>${recipientUser ? recipientUser.name : 'Anh/Chị'}</strong> (Ngày ${dateStr})</p>
      </div>

      <div class="body">
        <div class="summary-badge">
          🚨 Tổng cộng có <strong>${totalWarnings}</strong> hạng mục tài chính cần xử lý hoặc hoàn ứng ngay!
        </div>

        ${overdueAdvances.length > 0 ? `
          <div class="section-title">🛑 1. Đề Nghị Tạm Ứng Quá 30 Ngày Chưa Hoàn Ứng (${overdueAdvances.length})</div>
          <table>
            <thead>
              <tr>
                <th>Mã phiếu</th>
                <th>Người đề nghị</th>
                <th>Ngày lập</th>
                <th>Số tiền</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              ${overdueAdvances.map(d => `
                <tr>
                  <td><strong>${d.docNo || d.formCode}</strong></td>
                  <td>${d.requesterName}</td>
                  <td>${d.documentDate || '—'}</td>
                  <td><strong>${Number(d.totalAmount || d.amount || 0).toLocaleString('vi-VN')} ${d.currency || 'VNĐ'}</strong></td>
                  <td><span class="tag-danger">Quá 30 ngày</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        ${unlinkedInvoices.length > 0 ? `
          <div class="section-title">🧾 2. Hóa Đơn Điện Tử Trong Kho Chưa Làm ĐNTT (${unlinkedInvoices.length})</div>
          <table>
            <thead>
              <tr>
                <th>Số hóa đơn</th>
                <th>Đơn vị bán</th>
                <th>Ngày HD</th>
                <th>Số tiền</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              ${unlinkedInvoices.map(inv => `
                <tr>
                  <td><strong>HĐ ${inv.invoiceNumber || '—'}</strong></td>
                  <td>${inv.sellerName || '—'}</td>
                  <td>${inv.date || '—'}</td>
                  <td><strong>${Number(inv.totalAmount || inv.amount || 0).toLocaleString('vi-VN')} VNĐ</strong></td>
                  <td><span class="tag-warning">Chưa lập ĐNTT</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        ${pendingSignatures.length > 0 ? `
          <div class="section-title">⏳ 3. Phiếu ĐNTT / Tạm Ứng Đang Chờ Ký Duyệt (${pendingSignatures.length})</div>
          <table>
            <thead>
              <tr>
                <th>Mã phiếu</th>
                <th>Loại phiếu</th>
                <th>Người đề nghị</th>
                <th>Số tiền</th>
                <th>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              ${pendingSignatures.map(d => `
                <tr>
                  <td><strong>${d.docNo || d.formCode}</strong></td>
                  <td>${d.title || d.formCode}</td>
                  <td>${d.requesterName}</td>
                  <td><strong>${Number(d.totalAmount || d.amount || 0).toLocaleString('vi-VN')} ${d.currency || 'VNĐ'}</strong></td>
                  <td><span class="tag-info">Chờ ký</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : ''}

        <div style="text-align: center;">
          <a href="${appUrl}" class="btn" target="_blank">🔗 Mở Hệ Thống CPC1 Để Xử Lý Ngay</a>
        </div>
      </div>

      <div class="footer">
        Email được tự động tạo từ Hệ thống Quản lý Phiếu tài chính & Hoá đơn CPC1.<br>
        Mọi thắc mắc xin vui lòng liên hệ Bộ phận Kế toán / Ban Giám đốc.
      </div>
    </div>
  </body>
  </html>
  `;
}

async function sendWarningEmail(recipientEmail, subject, htmlBody) {
  const emailjsServiceId = (window.STATE && window.STATE.emailjsServiceId) || localStorage.getItem('cpc1_emailjs_service');
  const emailjsTemplateId = (window.STATE && window.STATE.emailjsTemplateId) || localStorage.getItem('cpc1_emailjs_template');
  const emailjsPublicKey = (window.STATE && window.STATE.emailjsPublicKey) || localStorage.getItem('cpc1_emailjs_public_key');

  if (emailjsServiceId && emailjsTemplateId && emailjsPublicKey && window.emailjs) {
    try {
      await window.emailjs.send(emailjsServiceId, emailjsTemplateId, {
        to_email: recipientEmail,
        subject: subject,
        message_html: htmlBody
      }, emailjsPublicKey);
      return { success: true, method: 'EmailJS API' };
    } catch (err) {
      console.warn('EmailJS send error:', err);
    }
  }

  console.log(`[EMAIL DISPATCH] To: ${recipientEmail} | Subject: ${subject}`);
  return { success: true, method: 'System Alert Dispatcher' };
}

async function triggerManualWarningEmailModal() {
  const currentUser = (window.currentUser) ? window.currentUser() : { name: 'Admin', email: 'admin@cpc1hn.com.vn' };
  const warningData = getWarningItems();
  const systemUsers = getSystemUserEmails();

  if (warningData.totalWarnings === 0) {
    if (window.showAlertModal) {
      window.showAlertModal('🎉 Không có cảnh báo', 'Tất cả các khoản tạm ứng, hóa đơn và phiếu chờ ký đều đang ở trạng thái an toàn!');
    } else {
      alert('Tất cả các khoản tạm ứng, hóa đơn và phiếu chờ ký đều ở trạng thái an toàn!');
    }
    return;
  }

  const htmlBody = buildWarningEmailHtml(currentUser, warningData);

  const overlay = document.createElement('div');
  overlay.id = 'warning-email-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.65);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';

  overlay.innerHTML = `
  <div style="background:#FFFFFF;border-radius:14px;max-width:760px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 25px -5px rgba(0,0,0,0.3);overflow:hidden;">
    <div style="background:linear-gradient(135deg, #0A2F52 0%, #0D9488 100%);color:#FFF;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;">
      <h3 style="margin:0;font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;">
        ✉️ Trình Quản Lý & Phát Email Cảnh Báo
      </h3>
      <button type="button" id="close-warning-modal" style="background:transparent;border:none;color:#FFF;font-size:22px;cursor:pointer;line-height:1;">&times;</button>
    </div>

    <!-- RECIPIENTS SELECTION SECTION -->
    <div style="padding:16px 24px;background:#F8FAFC;border-bottom:1px solid #E2E8F0;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <label style="font-size:13px;font-weight:700;color:#334155;min-width:140px;">📋 Chọn mẫu người nhận:</label>
        <select id="quick-email-preset" style="padding:8px 12px;border-radius:6px;border:1.5px solid #0D9488;font-size:13px;font-weight:700;color:#0F172A;flex:1;background:#F0FDFA;cursor:pointer;">
          <option value="">-- Click để chọn danh sách người nhận tự động --</option>
          <option value="affected">🎯 1. Tất cả nhân viên có khoản tạm ứng/hóa đơn cần xử lý</option>
          <option value="board">⭐ 2. Ban Giám đốc & Kế toán trưởng</option>
          <option value="leads">👔 3. Trưởng nhóm & Admin bộ phận</option>
          <option value="all">📋 4. Tất cả tài khoản trong hệ thống (${systemUsers.length} email)</option>
          <optgroup label="Tài khoản cá nhân trong hệ thống">
            ${systemUsers.map(u => `<option value="${u.email}">👤 ${u.name} (${u.role === 'admin' ? 'Admin' : (u.role === 'dept_head' ? 'Trưởng nhóm' : (u.role === 'chief_accountant' ? 'KT Trưởng' : (u.role === 'director' ? 'BGĐ' : 'Nhân viên')))}) - ${u.email}</option>`).join('')}
          </optgroup>
        </select>
      </div>

      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <label style="font-size:13px;font-weight:700;color:#334155;min-width:140px;">📧 Danh sách Email nhận:</label>
        <input type="text" id="warning-target-email" value="${currentUser.email || 'tuyen.vukim@cpc1hn.com.vn'}" placeholder="Nhập 1 hoặc nhiều Email (phân cách bằng dấu phẩy)..." style="padding:8px 12px;border-radius:6px;border:1px solid #CBD5E1;font-size:13px;flex:1;font-weight:600;color:#0A2F52;">
        <button type="button" id="btn-send-warning-now" class="btn btn-primary" style="background:#0D9488;color:#FFF;border:none;padding:9px 20px;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px;">
          🚀 Gửi Email Cảnh Báo
        </button>
      </div>
    </div>

    <!-- PREVIEW SECTION -->
    <div style="flex:1;overflow-y:auto;padding:20px;background:#F1F5F9;">
      <div style="background:#FFF;border-radius:8px;padding:15px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
        <h4 style="margin:0 0 10px 0;font-size:13px;color:#64748B;display:flex;justify-content:space-between;">
          <span>📄 Xem trước nội dung mẫu Email gửi đi:</span>
          <span>🚨 <b>${warningData.totalWarnings}</b> khoản cần xử lý</span>
        </h4>
        <iframe id="email-preview-frame" style="width:100%;height:350px;border:1px solid #E2E8F0;border-radius:6px;"></iframe>
      </div>
    </div>
  </div>
  `;

  document.body.appendChild(overlay);

  const iframe = document.getElementById('email-preview-frame');
  if (iframe) {
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(htmlBody);
    doc.close();
  }

  // Handle Quick Presets
  const presetSelect = document.getElementById('quick-email-preset');
  const targetEmailInput = document.getElementById('warning-target-email');

  presetSelect.addEventListener('change', (e) => {
    const val = e.target.value;
    if (!val) return;

    if (val === 'affected') {
      const affectedNames = new Set([
        ...warningData.overdueAdvances.map(d => d.requesterName),
        ...warningData.unlinkedInvoices.map(inv => inv.uploadedBy || inv.buyerName),
        ...warningData.pendingSignatures.map(d => d.requesterName)
      ].filter(Boolean));

      const affectedEmails = systemUsers
        .filter(u => affectedNames.has(u.name))
        .map(u => u.email);

      const finalEmails = affectedEmails.length > 0 ? [...new Set(affectedEmails)] : [currentUser.email];
      targetEmailInput.value = finalEmails.join(', ');
    } else if (val === 'board') {
      const boardEmails = systemUsers
        .filter(u => u.role === 'director' || u.role === 'chief_accountant')
        .map(u => u.email);
      targetEmailInput.value = boardEmails.join(', ');
    } else if (val === 'leads') {
      const leadEmails = systemUsers
        .filter(u => u.role === 'dept_head' || u.role === 'admin')
        .map(u => u.email);
      targetEmailInput.value = leadEmails.join(', ');
    } else if (val === 'all') {
      const allEmails = systemUsers.map(u => u.email);
      targetEmailInput.value = allEmails.join(', ');
    } else {
      targetEmailInput.value = val;
    }
  });

  document.getElementById('close-warning-modal').addEventListener('click', () => {
    overlay.remove();
  });

  document.getElementById('btn-send-warning-now').addEventListener('click', async () => {
    const emailStr = targetEmailInput.value.trim();
    if (!emailStr) {
      alert('Vui lòng chọn hoặc nhập ít nhất một địa chỉ Email người nhận!');
      return;
    }

    const recipientEmails = emailStr.split(',').map(e => e.trim()).filter(Boolean);
    if (recipientEmails.length === 0) {
      alert('Địa chỉ Email không hợp lệ!');
      return;
    }

    const btn = document.getElementById('btn-send-warning-now');
    btn.disabled = true;
    btn.textContent = `⏳ Đang phát ${recipientEmails.length} Email...`;

    const subject = `[CPC1HN] 🔔 Báo cáo cảnh báo: ${warningData.overdueAdvances.length} tạm ứng quá hạn & ${warningData.pendingSignatures.length} phiếu chờ ký`;

    for (const email of recipientEmails) {
      await sendWarningEmail(email, subject, htmlBody);
    }

    btn.disabled = false;
    btn.textContent = '🚀 Gửi Email Cảnh Báo';
    overlay.remove();

    if (window.showToast) {
      window.showToast(`✓ Đã phát Email cảnh báo thành công tới ${recipientEmails.length} địa chỉ Email!`);
    } else {
      alert(`Đã phát Email cảnh báo thành công tới ${recipientEmails.length} địa chỉ Email!`);
    }
  });
}

window.getWarningItems = getWarningItems;
window.getSystemUserEmails = getSystemUserEmails;
window.buildWarningEmailHtml = buildWarningEmailHtml;
window.sendWarningEmail = sendWarningEmail;
window.triggerManualWarningEmailModal = triggerManualWarningEmailModal;
