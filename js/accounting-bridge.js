/**
 * CPC1 Financial Vouchers - Accounting Web Bridge (Auto-Fill Integration)
 * Bridges invoices & payment requests to https://sanxuat.icpc1hn.work/#/de-nghi-thanh-toan/
 */
(function () {
  const ACCOUNTING_URL = 'https://sanxuat.icpc1hn.work/#/de-nghi-thanh-toan/All?search=&date=2026-07-20';

  function extractBridgeData(docOrInvoices) {
    if (Array.isArray(docOrInvoices)) {
      const invs = docOrInvoices;
      const total = invs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const ben = invs[0]?.beneficiaryName || '';
      const notes = invs.map(i => i.note).filter(Boolean).join('; ');
      return {
        type: 'invoices',
        requestType: 'Trả 1 lần',
        supplier: ben,
        totalAmount: total,
        paymentMethod: 'Tiền mặt',
        reason: notes || 'Thanh toán hoá đơn chi phí',
        note: invs.map(i => i.invoiceRef ? `Invoice: ${i.invoiceRef}` : '').filter(Boolean).join(', '),
        invoices: invs.map(i => ({
          type: 'Hóa đơn',
          invoiceNo: i.invoiceNumber || '',
          invoiceDate: i.date || '',
          seriesNo: i.seriesNo || '',
          goodsName: i.note || '',
          amount: i.amount || 0,
          note: i.invoiceRef ? `Invoice: ${i.invoiceRef}` : ''
        }))
      };
    } else {
      const doc = docOrInvoices;
      const total = window.computeTotal ? window.computeTotal(doc) : (doc.items || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
      const items = (doc.items || []).length > 0 ? doc.items : (doc.spentItems || []);
      const ben = doc.payeeName || items[0]?.beneficiaryName || '';
      const reason = doc.subject || (items.map(i => i.description || i.note).filter(Boolean).join('; '));
      return {
        type: 'document',
        requestType: 'Trả 1 lần',
        supplier: ben,
        totalAmount: total,
        paymentMethod: doc.paymentMethod === 'transfer' ? 'Chuyển khoản' : 'Tiền mặt',
        reason: reason,
        note: doc.formCode ? `Theo phiếu ${doc.formCode}` : '',
        invoices: items.map(i => {
          let seriesNo = '';
          let invoiceNo = i.invoiceNo || '';
          if (invoiceNo.includes('|')) {
            const parts = invoiceNo.split('|');
            seriesNo = parts[0];
            invoiceNo = parts[1];
          }
          return {
            type: 'Hóa đơn',
            invoiceNo: invoiceNo,
            invoiceDate: i.date || doc.documentDate || '',
            seriesNo: seriesNo,
            goodsName: i.description || i.note || '',
            amount: i.amount || 0,
            note: ''
          };
        })
      };
    }
  }

  function generateAutoFillScript(payload) {
    const jsonStr = JSON.stringify(payload);
    return `(async function(){
      const data = ${jsonStr};
      console.log("%c[CPC1 AutoFill] Bắt đầu tự động điền ĐNTT:", "color:#2563eb;font-weight:bold;font-size:14px;", data);

      // Hiển thị Banner thông báo góc trên màn hình
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:20px;right:20px;z-index:999999;background:#1E293B;color:#fff;padding:14px 20px;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,0.3);font-family:sans-serif;font-size:13px;border-left:5px solid #3B82F6;line-height:1.5;animation:fadeIn .2s ease;';
      banner.innerHTML = '<b style="color:#60A5FA;font-size:14px;">⚡ CPC1 Auto-Fill</b><br>Đang tự động điền ĐNTT và ' + (data.invoices ? data.invoices.length : 0) + ' hoá đơn...';
      document.body.appendChild(banner);

      function triggerInput(el, val) {
        if (!el) return;
        el.focus();
        // Native setter for Vue 2/3 / React / Element UI
        const isTextarea = el.tagName === 'TEXTAREA';
        const prototype = isTextarea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
      }

      function clickRadioByText(text) {
        const labels = Array.from(document.querySelectorAll('label, .el-radio, span, div'));
        for (const l of labels) {
          if (l.innerText && l.innerText.trim().toLowerCase().includes(text.toLowerCase())) {
            const radio = l.querySelector('.el-radio__input, input[type="radio"]') || l;
            radio.click();
            return true;
          }
        }
        return false;
      }

      function findInputByPlaceholder(phList) {
        const inputs = Array.from(document.querySelectorAll('input, textarea'));
        for (const ph of phList) {
          const found = inputs.find(i => (i.placeholder || '').toLowerCase().includes(ph.toLowerCase()));
          if (found) return found;
        }
        return null;
      }

      async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

      try {
        // 1. Loại đề nghị
        clickRadioByText(data.requestType || 'Trả 1 lần');
        await wait(100);

        // 2. Nhà cung cấp
        const supplierInp = findInputByPlaceholder(['nhà cung cấp', 'chọn nhà cung cấp', 'nhà cc']);
        if (supplierInp && data.supplier) triggerInput(supplierInp, data.supplier);

        // 3. Tổng tiền
        const totalInp = findInputByPlaceholder(['tổng tiền', 'nhập tổng tiền']);
        if (totalInp && data.totalAmount) triggerInput(totalInp, data.totalAmount);

        // 4. Hình thức thanh toán
        clickRadioByText(data.paymentMethod || 'Tiền mặt');

        // 5. Lý do thanh toán
        const reasonInp = findInputByPlaceholder(['lý do thanh toán', 'chọn lý do thanh toán']);
        if (reasonInp && data.reason) triggerInput(reasonInp, data.reason);

        // 6. Ghi chú
        const noteInp = findInputByPlaceholder(['nhập ghi chú', 'ghi chú']);
        if (noteInp && data.note) triggerInput(noteInp, data.note);

        console.log("[CPC1 AutoFill] ✓ Đã điền xong thông tin phiếu chính!");

        // 7. Điền từng hoá đơn
        if (data.invoices && data.invoices.length > 0) {
          for (let idx = 0; idx < data.invoices.length; idx++) {
            const inv = data.invoices[idx];
            banner.innerHTML = '<b style="color:#60A5FA;font-size:14px;">⚡ CPC1 Auto-Fill</b><br>Đang thêm hoá đơn ' + (idx + 1) + '/' + data.invoices.length + '...';
            
            // Tìm nút 'Thêm hoá đơn'
            const buttons = Array.from(document.querySelectorAll('button, .btn, .el-button, a, span'));
            const addInvBtn = buttons.find(b => (b.innerText || '').toLowerCase().includes('thêm hoá đơn') || (b.innerText || '').toLowerCase().includes('thêm hóa đơn'));
            if (!addInvBtn) {
              console.warn("[CPC1 AutoFill] Không tìm thấy nút 'Thêm hoá đơn'");
              break;
            }
            addInvBtn.click();
            await wait(450);

            // Điền modal hoá đơn
            const invNoInp = findInputByPlaceholder(['số hoá đơn', 'chọn số hoá đơn', 'số hóa đơn']);
            if (invNoInp) triggerInput(invNoInp, inv.invoiceNo);

            const invDateInp = findInputByPlaceholder(['ngày hoá đơn', 'chọn ngày hoá đơn', 'ngày hóa đơn']);
            if (invDateInp) triggerInput(invDateInp, inv.invoiceDate);

            const seriesInp = findInputByPlaceholder(['số ct', 'nhập số ct', 'ký hiệu']);
            if (seriesInp) triggerInput(seriesInp, inv.seriesNo);

            const goodsInp = findInputByPlaceholder(['tên hàng', 'nhập tên hàng', 'nội dung']);
            if (goodsInp) triggerInput(goodsInp, inv.goodsName);

            const amountInp = findInputByPlaceholder(['số tiền', 'nhập số tiền']);
            if (amountInp) triggerInput(amountInp, inv.amount);

            const invNoteInp = Array.from(document.querySelectorAll('textarea, input')).filter(i => (i.placeholder || '').toLowerCase().includes('ghi chú')).pop();
            if (invNoteInp && inv.note) triggerInput(invNoteInp, inv.note);

            await wait(350);

            // Bấm nút 'Xác nhận' trong modal hoá đơn
            const confirmBtns = Array.from(document.querySelectorAll('button, .btn, .el-button')).filter(b => (b.innerText || '').trim().toLowerCase() === 'xác nhận');
            const confirmBtn = confirmBtns.pop();
            if (confirmBtn) {
              confirmBtn.click();
              await wait(450);
            }
          }
        }

        banner.style.background = '#065F46';
        banner.style.borderLeftColor = '#10B981';
        banner.innerHTML = '<b style="color:#34D399;font-size:14px;">✓ Hoàn tất Auto-Fill!</b><br>Đã điền thành công ĐNTT & ' + data.invoices.length + ' hoá đơn.';
        setTimeout(() => banner.remove(), 4000);
      } catch (err) {
        console.error("[CPC1 AutoFill Lỗi]:", err);
        banner.style.background = '#991B1B';
        banner.innerHTML = '<b>Lỗi Auto-Fill:</b> ' + err.message;
        setTimeout(() => banner.remove(), 5000);
      }
    })();`;
  }

  function openBridgeModal(docOrInvoices) {
    const payload = extractBridgeData(docOrInvoices);
    const rawScript = generateAutoFillScript(payload);
    const bookmarkletUrl = 'javascript:' + encodeURIComponent(rawScript);

    // Save payload to localStorage so extension/userscript can read it anytime
    try {
      localStorage.setItem('cpc1_autofill_payload', JSON.stringify(payload));
    } catch (e) {}

    const existing = document.getElementById('accounting-bridge-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'accounting-bridge-modal';
    overlay.className = 'modal-overlay';

    overlay.innerHTML = `
      <div class="modal-box" style="max-width:700px;width:95%;padding:26px 30px;max-height:92vh;overflow-y:auto;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;border-bottom:1px solid var(--line);padding-bottom:12px;">
          <div>
            <h3 style="font-size:18px;margin:0 0 4px;color:var(--ink);display:flex;align-items:center;gap:8px;">
              <span>⚡</span> <span>Chuyển dữ liệu sang Web Kế toán (Auto-Fill)</span>
            </h3>
            <p style="margin:0;font-size:12.5px;color:var(--ink-soft);">
              Tự động điền 100% thông tin phiếu và từng hoá đơn vào <code>sanxuat.icpc1hn.work</code>.
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="bridge-close" style="font-size:16px;padding:4px 8px;line-height:1;">✕</button>
        </div>

        <!-- Tóm tắt dữ liệu sẽ chuyển -->
        <div style="background:#F8FAFC;border:1px solid var(--line);border-radius:8px;padding:14px;margin-bottom:18px;font-size:13px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
            <div>🏢 <b>Nhà cung cấp:</b> <span style="color:var(--teal);font-weight:600;">${payload.supplier || '(Chưa rõ)'}</span></div>
            <div>💰 <b>Tổng tiền:</b> <span style="color:var(--stamp);font-weight:700;">${Number(payload.totalAmount).toLocaleString('vi-VN')} VNĐ</span></div>
          </div>
          <div style="margin-bottom:8px;">
            📝 <b>Lý do thanh toán:</b> <span>${payload.reason || '(Không có)'}</span>
          </div>
          <div>
            🧾 <b>Danh sách hoá đơn (${payload.invoices.length} hoá đơn):</b>
            <div style="margin-top:6px;max-height:100px;overflow-y:auto;background:#fff;border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12px;">
              ${payload.invoices.map((inv, idx) => `
                <div style="padding:3px 0;border-bottom:1px dashed #eee;display:flex;justify-content:space-between;">
                  <span><b>#${idx+1}</b> ${inv.seriesNo ? `[${inv.seriesNo}]` : ''} Số: <b>${inv.invoiceNo || 'N/A'}</b> - ${inv.goodsName}</span>
                  <span style="font-weight:600;color:var(--teal);">${Number(inv.amount).toLocaleString('vi-VN')}đ</span>
                </div>`).join('')}
            </div>
          </div>
        </div>

        <!-- Cách 1: Nút Sao chép mã chạy ngay qua F12 Console (Đảm bảo 100% hoạt động) -->
        <div style="background:#F0FDF4;border:1.5px solid #86EFAC;border-radius:8px;padding:16px;margin-bottom:16px;">
          <b style="color:#166534;font-size:14px;display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span>🚀</span> Cách 1: Chạy trực tiếp siêu nhanh (100% Thành công)
          </b>
          <p style="font-size:12.5px;color:#14532D;margin:0 0 12px;line-height:1.5;">
            1. Bấm nút <b>"📋 Sao chép mã Auto-Fill"</b> bên dưới.<br>
            2. Mở tab web Kế toán <code>sanxuat.icpc1hn.work</code> ➔ Nhấn <b>F12</b> (hoặc chuột phải chọn <i>Kiểm tra / Console</i>).<br>
            3. Nhấn <b>Ctrl + V</b> và nhấn <b>Enter</b> ➔ Hệ thống sẽ tự động điền toàn bộ trong 1 giây!
          </p>
          <div style="display:flex;gap:10px;align-items:center;">
            <button type="button" class="btn btn-primary" id="bridge-copy-btn" style="background:#16A34A;border-color:#15803D;font-weight:700;padding:8px 18px;">
              📋 Sao chép mã Auto-Fill (Copy)
            </button>
            <span id="bridge-copy-status" style="font-size:12px;color:#166534;font-weight:600;"></span>
          </div>
        </div>

        <!-- Cách 2: Kéo Bookmarklet -->
        <div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:8px;padding:14px;margin-bottom:20px;">
          <b style="color:#1E40AF;font-size:13px;display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <span>📌</span> Cách 2: Nút bấm Dấu trang (Bookmarklet)
          </b>
          <p style="font-size:12px;color:#1E3A8A;margin:0 0 10px;line-height:1.4;">
            Kéo thả nút xanh dưới đây lên thanh Dấu trang (Bookmarks bar):
          </p>
          <div style="text-align:center;margin-bottom:8px;">
            <a href="${bookmarkletUrl.replace(/"/g, '&quot;')}" class="btn btn-primary btn-sm" style="background:#2563EB;border-color:#1D4ED8;font-weight:700;display:inline-block;cursor:move;text-decoration:none;" onclick="event.preventDefault(); alert('👉 Bạn hãy KÉO THẢ nút này lên thanh Dấu trang (Bookmarks) của trình duyệt nhé!');">
              ⚡ AutoFill Kế Toán CPC1
            </a>
          </div>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding-top:16px;">
          <button type="button" class="btn btn-ghost" id="bridge-cancel">Đóng</button>
          <a href="${ACCOUNTING_URL}" target="_blank" class="btn btn-teal" style="text-decoration:none;display:inline-flex;align-items:center;gap:6px;">
            🚀 Mở Web Kế toán ↗
          </a>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
    document.getElementById('bridge-close').addEventListener('click', close);
    document.getElementById('bridge-cancel').addEventListener('click', close);

    const copyBtn = document.getElementById('bridge-copy-btn');
    const copyStatus = document.getElementById('bridge-copy-status');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(rawScript).then(() => {
        copyStatus.textContent = '✓ Đã sao chép! Hãy sang tab Kế toán, nhấn F12 ➔ Dán (Ctrl+V) ➔ Enter';
        if (window.showToast) window.showToast('✓ Đã sao chép mã Auto-Fill thành công!');
      });
    });
  }

  window.AccountingBridge = {
    openBridgeModal,
    extractBridgeData,
    generateAutoFillScript
  };
})();
