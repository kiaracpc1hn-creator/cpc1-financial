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

function buildWarningTextSummary(warningData) {
  let text = `🏢 [CPC1HN] BÁO CÁO CẢNH BÁO TÀI CHÍNH (${new Date().toLocaleDateString('vi-VN')})\n\n`;
  if (warningData.overdueAdvances.length > 0) {
    text += `🛑 TẠM ỨNG QUÁ HẠN > 30 NGÀY (${warningData.overdueAdvances.length} khoản):\n`;
    warningData.overdueAdvances.forEach(d => {
      text += `- Phiếu ${d.docNo || d.formCode} | Người đề nghị: ${d.requesterName} | Số tiền: ${Number(d.totalAmount || d.amount || 0).toLocaleString('vi-VN')} ${d.currency || 'VNĐ'}\n`;
    });
    text += `\n`;
  }
  if (warningData.unlinkedInvoices.length > 0) {
    text += `🧾 HÓA ĐƠN CHƯA LẬP ĐNTT (${warningData.unlinkedInvoices.length} hóa đơn):\n`;
    warningData.unlinkedInvoices.forEach(inv => {
      text += `- HĐ ${inv.invoiceNumber || '—'} | Đơn vị bán: ${inv.sellerName || '—'} | Số tiền: ${Number(inv.totalAmount || inv.amount || 0).toLocaleString('vi-VN')} VNĐ\n`;
    });
    text += `\n`;
  }
  if (warningData.pendingSignatures.length > 0) {
    text += `⏳ PHIẾU ĐANG CHỜ KÝ DUYỆT (${warningData.pendingSignatures.length} phiếu):\n`;
    warningData.pendingSignatures.forEach(d => {
      text += `- Phiếu ${d.docNo || d.formCode} | Người đề nghị: ${d.requesterName} | Số tiền: ${Number(d.totalAmount || d.amount || 0).toLocaleString('vi-VN')} ${d.currency || 'VNĐ'}\n`;
    });
  }
  text += `\n👉 Vui lòng mở ứng dụng CPC1 để xử lý ngay.`;
  return text;
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

async function sendWarningEmail(recipientEmail, subject, htmlBody, plainTextSummary = '') {
  // 1. EmailJS API
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

  // 2. Resend API
  const resendApiKey = (window.STATE && window.STATE.resendApiKey) || localStorage.getItem('cpc1_resend_api_key');
  if (resendApiKey) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resendApiKey}`
        },
        body: JSON.stringify({
          from: 'CPC1HN Finance <onboarding@resend.dev>',
          to: [recipientEmail],
          subject: subject,
          html: htmlBody
        })
      });
      if (resp.ok) return { success: true, method: 'Resend API' };
    } catch (err) {
      console.warn('Resend error:', err);
    }
  }

  // 3. FormSubmit Gateway Direct HTTP Delivery
  try {
    const fsResp = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(recipientEmail)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        _subject: subject,
        name: 'Hệ thống Tài chính CPC1HN',
        email: recipientEmail,
        message: plainTextSummary || 'Báo cáo cảnh báo tạm ứng quá hạn và hóa đơn chưa ĐNTT từ CPC1HN.'
      })
    });
    if (fsResp.ok) return { success: true, method: 'FormSubmit Gateway' };
  } catch (err) {
    console.warn('FormSubmit error:', err);
  }

  return { success: false, method: 'none' };
}

async function triggerManualWarningEmailModal() {
  const currentUser = (window.currentUser) ? window.currentUser() : { name: 'Admin', email: 'tuyen.vukim@cpc1hn.com.vn' };
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
  const textSummary = buildWarningTextSummary(warningData);

  const overlay = document.createElement('div');
  overlay.id = 'warning-email-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(15,23,42,0.65);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';

  overlay.innerHTML = `
  <div style="background:#FFFFFF;border-radius:14px;max-width:780px;width:100%;max-height:94vh;display:flex;flex-direction:column;box-shadow:0 20px 25px -5px rgba(0,0,0,0.3);overflow:hidden;">
    <div style="background:linear-gradient(135deg, #0A2F52 0%, #0D9488 100%);color:#FFF;padding:18px 24px;display:flex;justify-content:space-between;align-items:center;">
      <h3 style="margin:0;font-size:16px;font-weight:700;display:flex;align-items:center;gap:8px;">
        ✉️ Trình Quản Lý & Phát Email Cảnh Báo
      </h3>
      <button type="button" id="close-warning-modal" style="background:transparent;border:none;color:#FFF;font-size:22px;cursor:pointer;line-height:1;">&times;</button>
    </div>

    <!-- RECIPIENTS SELECTION SECTION -->
    <div style="padding:16px 24px;background:#F8FAFC;border-bottom:1px solid #E2E8F0;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <label style="font-size:13px;font-weight:700;color:#334155;min-width:140px;">📋 Chọn người nhận nhanh:</label>
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
        <label style="font-size:13px;font-weight:700;color:#334155;min-width:140px;">📧 Email người nhận:</label>
        <input type="text" id="warning-target-email" value="${currentUser.email || 'tuyen.vukim@cpc1hn.com.vn'}" placeholder="Nhập 1 hoặc nhiều Email (phân cách bằng dấu phẩy)..." style="padding:8px 12px;border-radius:6px;border:1px solid #CBD5E1;font-size:13px;flex:1;font-weight:600;color:#0A2F52;">
      </div>

      <!-- ACTION BUTTONS BAR -->
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;">
        <button type="button" id="btn-send-warning-now" class="btn" style="background:#0D9488;color:#FFF;border:none;padding:9px 18px;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px;">
          🚀 Gửi Email Trực Tiếp (Gateway API)
        </button>
        <button type="button" id="btn-open-outlook-mail" class="btn" style="background:#0284C7;color:#FFF;border:none;padding:9px 16px;border-radius:6px;font-weight:700;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px;" title="Mở phần mềm Outlook / Mail trên máy tính với Email và nội dung đã điền sẵn">
          📩 Mở Ứng Dụng Mail (Outlook / Gmail)
        </button>
        <button type="button" id="btn-toggle-api-settings" class="btn" style="background:#F1F5F9;color:#475569;border:1px solid #CBD5E1;padding:9px 14px;border-radius:6px;font-weight:600;font-size:13px;cursor:pointer;">
          ⚙️ Cấu Hình API Key
        </button>
      </div>

      <!-- API SETTINGS COLLAPSIBLE PANEL -->
      <div id="api-settings-panel" style="display:none;background:#FFF;padding:12px 16px;border-radius:8px;border:1px solid #CBD5E1;margin-top:6px;">
        <h4 style="margin:0 0 8px 0;font-size:13px;color:#0F172A;">⚙️ Cấu hình Dịch vụ Gửi Email Doanh Nghiệp (EmailJS / Resend API):</h4>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
          <div>
            <label style="font-size:11px;font-weight:600;color:#64748B;">Resend API Key:</label>
            <input type="text" id="cfg-resend-key" value="${localStorage.getItem('cpc1_resend_api_key') || ''}" placeholder="re_123456789..." style="width:100%;padding:6px;border-radius:4px;border:1px solid #CBD5E1;font-size:12px;">
          </div>
          <div>
            <label style="font-size:11px;font-weight:600;color:#64748B;">EmailJS Service ID:</label>
            <input type="text" id="cfg-emailjs-service" value="${localStorage.getItem('cpc1_emailjs_service') || ''}" placeholder="service_xyz" style="width:100%;padding:6px;border-radius:4px;border:1px solid #CBD5E1;font-size:12px;">
          </div>
        </div>
        <button type="button" id="btn-save-email-cfg" style="background:#0F172A;color:#FFF;border:none;padding:5px 14px;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">💾 Lưu Cấu Hình Key</button>
      </div>
    </div>

    <!-- PREVIEW SECTION -->
    <div style="flex:1;overflow-y:auto;padding:20px;background:#F1F5F9;">
      <div style="background:#FFF;border-radius:8px;padding:15px;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
        <h4 style="margin:0 0 10px 0;font-size:13px;color:#64748B;display:flex;justify-content:space-between;">
          <span>📄 Xem trước nội dung mẫu Email gửi đi:</span>
          <span>🚨 <b>${warningData.totalWarnings}</b> khoản cần xử lý</span>
        </h4>
        <iframe id="email-preview-frame" style="width:100%;height:320px;border:1px solid #E2E8F0;border-radius:6px;"></iframe>
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

  // Toggle API settings panel
  document.getElementById('btn-toggle-api-settings').addEventListener('click', () => {
    const panel = document.getElementById('api-settings-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  });

  document.getElementById('btn-save-email-cfg').addEventListener('click', () => {
    const rKey = document.getElementById('cfg-resend-key').value.trim();
    const eSvc = document.getElementById('cfg-emailjs-service').value.trim();
    if (rKey) localStorage.setItem('cpc1_resend_api_key', rKey);
    if (eSvc) localStorage.setItem('cpc1_emailjs_service', eSvc);
    alert('Đã lưu cấu hình API Key Email thành công!');
    document.getElementById('api-settings-panel').style.display = 'none';
  });

  // Open Outlook / Mail App Button
  document.getElementById('btn-open-outlook-mail').addEventListener('click', () => {
    const emailStr = targetEmailInput.value.trim() || currentUser.email || 'tuyen.vukim@cpc1hn.com.vn';
    const subject = `[CPC1HN] 🔔 Báo cáo cảnh báo: ${warningData.overdueAdvances.length} tạm ứng quá hạn & ${warningData.pendingSignatures.length} phiếu chờ ký`;
    const mailtoUrl = `mailto:${encodeURIComponent(emailStr)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(textSummary)}`;
    window.location.href = mailtoUrl;
    if (window.showToast) window.showToast('📁 Đã mở ứng dụng Mail (Outlook / Gmail)...');
  });

  // Direct Send API Button
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
    btn.textContent = `⏳ Đang gửi ${recipientEmails.length} Email...`;

    const subject = `[CPC1HN] 🔔 Báo cáo cảnh báo: ${warningData.overdueAdvances.length} tạm ứng quá hạn & ${warningData.pendingSignatures.length} phiếu chờ ký`;

    let successCount = 0;
    for (const email of recipientEmails) {
      const res = await sendWarningEmail(email, subject, htmlBody, textSummary);
      if (res.success) successCount++;
    }

    btn.disabled = false;
    btn.textContent = '🚀 Gửi Email Trực Tiếp (Gateway API)';
    overlay.remove();

    if (window.showToast) {
      window.showToast(`✓ Đã phát thành công Email cảnh báo tới ${recipientEmails.length} địa chỉ!`);
    } else {
      alert(`Đã phát thành công Email cảnh báo tới ${recipientEmails.length} địa chỉ!`);
    }
  });

  document.getElementById('close-warning-modal').addEventListener('click', () => {
    overlay.remove();
  });
}

window.getWarningItems = getWarningItems;
window.getSystemUserEmails = getSystemUserEmails;
window.buildWarningTextSummary = buildWarningTextSummary;
window.buildWarningEmailHtml = buildWarningEmailHtml;
window.sendWarningEmail = sendWarningEmail;
window.triggerManualWarningEmailModal = triggerManualWarningEmailModal;
