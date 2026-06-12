const express = require('express');
const { Pool } = require('pg');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function q(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      owner      TEXT NOT NULL,
      status     TEXT DEFAULT '正常',
      notes      TEXT DEFAULT '',
      claims     JSONB DEFAULT '[]',
      created_at TEXT
    )
  `);
  console.log('数据库初始化完成');
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

const STATUS_COLOR = {
  '正常':       '#22c55e',
  '维修中':     '#f59e0b',
  '维修后待测试': '#3b82f6',
  '待维护':     '#ef4444',
  '无法维修':   '#6b7280',
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── 主页：设备列表 ───────────────────────────────────────────
app.get('/', async (req, res) => {
  const devices = await q('SELECT * FROM devices ORDER BY created_at');

  const cards = devices.map(d => {
    const currentClaim = d.claims.find(c => !c.returnedAt);
    return `
    <div class="device-card">
      <div class="card-head">
        <h3>${d.name}</h3>
        <span class="badge" style="background:${STATUS_COLOR[d.status] || '#6b7280'}">${d.status}</span>
      </div>
      <p class="meta">负责人：${d.owner}</p>
      ${currentClaim ? `<p class="meta" style="color:#f59e0b">使用中：${currentClaim.claimedBy}</p>` : '<p class="meta" style="color:#22c55e">当前空闲</p>'}
      <div class="card-actions">
        <a href="/device/${d.id}" class="btn">详情 / 领用</a>
        <a href="/qr/${d.id}" class="btn btn-outline">打印二维码</a>
      </div>
    </div>`;
  }).join('');

  res.send(html('设备管理系统', `
    <div class="top-bar"><h1>设备管理系统</h1></div>
    <div class="container">
      <div class="card">
        <h2 class="section-title">添加新设备</h2>
        <form method="POST" action="/device/add" class="add-form">
          <input name="name" placeholder="设备名称（如：笔记本电脑A）" required>
          <input name="owner" placeholder="负责人姓名" required>
          <button type="submit" class="btn">+ 添加</button>
        </form>
      </div>
      <div class="device-grid">
        ${cards || '<p class="empty">暂无设备，请先添加</p>'}
      </div>
    </div>
  `));
});

// ─── 添加设备 ─────────────────────────────────────────────────
app.post('/device/add', async (req, res) => {
  const id = genId();
  await q(
    `INSERT INTO devices (id, name, owner, status, notes, claims, created_at)
     VALUES ($1, $2, $3, '正常', '', '[]', $4)`,
    [id, req.body.name.trim(), req.body.owner.trim(), new Date().toLocaleString('zh-CN')]
  );
  res.redirect('/');
});

// ─── 设备详情页 ───────────────────────────────────────────────
app.get('/device/:id', async (req, res) => {
  const [d] = await q('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).send('设备不存在');

  const currentClaim = d.claims.find(c => !c.returnedAt);

  const historyRows = d.claims.length
    ? d.claims.slice().reverse().map(c => `
        <tr>
          <td>${c.claimedBy}</td>
          <td>${c.claimedAt}</td>
          <td>${c.returnedAt || '<span style="color:#f59e0b">使用中</span>'}</td>
          <td>${c.reason || '—'}</td>
        </tr>`).join('')
    : `<tr><td colspan="4" style="color:#aaa;text-align:center">暂无记录</td></tr>`;

  res.send(html(`${d.name} — 设备详情`, `
    <div class="top-bar">
      <a href="/" class="back">← 返回</a>
      <h1>${d.name}</h1>
    </div>
    <div class="container">

      <div class="card">
        <h2 class="section-title">设备信息</h2>
        <div class="info-row"><span>设备名称</span><span>${d.name}</span></div>
        <div class="info-row"><span>负责人</span><span>${d.owner}</span></div>
        <div class="info-row">
          <span>当前状态</span>
          <span class="badge" style="background:${STATUS_COLOR[d.status] || '#6b7280'}">${d.status}</span>
        </div>
        ${d.notes ? `<div class="info-row"><span>故障说明</span><span style="color:#ef4444">${d.notes}</span></div>` : ''}
        <div class="info-row">
          <span>当前使用人</span>
          <span style="color:${currentClaim ? '#f59e0b' : '#22c55e'};font-weight:600">
            ${currentClaim ? currentClaim.claimedBy : '空闲'}
          </span>
        </div>
      </div>

      <div class="card">
        <h2 class="section-title">修改基本信息</h2>
        <form method="POST" action="/device/${d.id}/edit" style="display:flex;gap:10px;flex-wrap:wrap">
          <div class="form-group" style="flex:1;min-width:140px;margin-bottom:0">
            <label>设备名称</label>
            <input name="name" value="${d.name}" required>
          </div>
          <div class="form-group" style="flex:1;min-width:140px;margin-bottom:0">
            <label>负责人</label>
            <input name="owner" value="${d.owner}" required>
          </div>
          <div style="display:flex;align-items:flex-end">
            <button type="submit" class="btn">保存</button>
          </div>
        </form>
      </div>

      <div class="card">
        <h2 class="section-title">更新状态</h2>
        <form method="POST" action="/device/${d.id}/status">
          <div class="form-group">
            <label>设备状态</label>
            <select name="status">
              <option value="正常"     ${d.status === '正常'     ? 'selected' : ''}>正常</option>
              <option value="维修中"     ${d.status === '维修中'     ? 'selected' : ''}>维修中</option>
              <option value="维修后待测试" ${d.status === '维修后待测试' ? 'selected' : ''}>维修后待测试</option>
              <option value="待维护"     ${d.status === '待维护'     ? 'selected' : ''}>待维护（请填写故障说明）</option>
              <option value="无法维修" ${d.status === '无法维修' ? 'selected' : ''}>无法维修</option>
            </select>
          </div>
          <div class="form-group">
            <label>故障说明（维修中 / 待维护时请填写）</label>
            <textarea name="notes" placeholder="例如：屏幕碎裂、键盘失灵、主板烧毁...">${d.notes || ''}</textarea>
          </div>
          <button type="submit" class="btn">保存状态</button>
        </form>
      </div>

      <div class="card">
        <h2 class="section-title">${currentClaim ? '归还设备' : '领用设备'}</h2>
        ${currentClaim ? `
          <div class="notice">
            当前使用人：<strong>${currentClaim.claimedBy}</strong>
            &nbsp;（领用于 ${currentClaim.claimedAt}）
          </div>
          <form method="POST" action="/device/${d.id}/return">
            <button type="submit" class="btn btn-green" style="width:100%">确认归还</button>
          </form>
        ` : `
          <form method="POST" action="/device/${d.id}/claim">
            <div class="form-group">
              <label>您的姓名 *</label>
              <input name="claimedBy" placeholder="请输入真实姓名" required>
            </div>
            <div class="form-group">
              <label>领用原因（选填）</label>
              <input name="reason" placeholder="例如：项目使用、出差借用...">
            </div>
            <button type="submit" class="btn btn-green" style="width:100%">确认领用</button>
          </form>
        `}
      </div>

      <div class="card">
        <h2 class="section-title">领用记录</h2>
        <div style="overflow-x:auto">
          <table>
            <thead><tr><th>姓名</th><th>领用时间</th><th>归还时间</th><th>原因</th></tr></thead>
            <tbody>${historyRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card" style="border:1px solid #fee2e2">
        <h2 class="section-title" style="color:#ef4444">危险操作</h2>
        <p style="font-size:14px;color:#666;margin-bottom:14px">删除后无法恢复，包括所有领用记录。</p>
        <form method="POST" action="/device/${d.id}/delete"
              onsubmit="return confirm('确定要删除「${d.name}」吗？此操作不可撤销。')">
          <button type="submit" class="btn btn-red">删除此设备</button>
        </form>
      </div>

    </div>
  `));
});

// ─── 删除设备 ─────────────────────────────────────────────────
app.post('/device/:id/delete', async (req, res) => {
  await q('DELETE FROM devices WHERE id = $1', [req.params.id]);
  res.redirect('/');
});

// ─── 修改名称/负责人 ──────────────────────────────────────────
app.post('/device/:id/edit', async (req, res) => {
  await q(
    'UPDATE devices SET name = $1, owner = $2 WHERE id = $3',
    [req.body.name.trim(), req.body.owner.trim(), req.params.id]
  );
  res.redirect(`/device/${req.params.id}`);
});

// ─── 更新状态 ─────────────────────────────────────────────────
app.post('/device/:id/status', async (req, res) => {
  await q(
    'UPDATE devices SET status = $1, notes = $2 WHERE id = $3',
    [req.body.status, (req.body.notes || '').trim(), req.params.id]
  );
  res.redirect(`/device/${req.params.id}`);
});

// ─── 领用 ─────────────────────────────────────────────────────
app.post('/device/:id/claim', async (req, res) => {
  const [d] = await q('SELECT claims FROM devices WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).send('设备不存在');
  const claims = [...d.claims, {
    claimedBy: req.body.claimedBy.trim(),
    reason: (req.body.reason || '').trim(),
    claimedAt: new Date().toLocaleString('zh-CN'),
    returnedAt: null,
  }];
  await q('UPDATE devices SET claims = $1 WHERE id = $2', [JSON.stringify(claims), req.params.id]);
  res.redirect(`/device/${req.params.id}`);
});

// ─── 归还 ─────────────────────────────────────────────────────
app.post('/device/:id/return', async (req, res) => {
  const [d] = await q('SELECT claims FROM devices WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).send('设备不存在');
  const claims = d.claims.map(c =>
    !c.returnedAt ? { ...c, returnedAt: new Date().toLocaleString('zh-CN') } : c
  );
  await q('UPDATE devices SET claims = $1 WHERE id = $2', [JSON.stringify(claims), req.params.id]);
  res.redirect(`/device/${req.params.id}`);
});

// ─── 二维码页 ─────────────────────────────────────────────────
app.get('/qr/:id', async (req, res) => {
  const [d] = await q('SELECT * FROM devices WHERE id = $1', [req.params.id]);
  if (!d) return res.status(404).send('设备不存在');

  const url = `https://${req.headers.host}/device/${d.id}`;
  const qrImg = await QRCode.toDataURL(url, { width: 280, margin: 2, color: { dark: '#1a1a1a' } });

  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${d.name} 二维码</title>
  <style>
    body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
         background:#f0f2f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
    .qr-card{background:white;border-radius:16px;padding:36px 32px;text-align:center;
             box-shadow:0 4px 24px rgba(0,0,0,.12);max-width:340px;width:100%}
    h1{font-size:22px;margin-bottom:4px}
    .owner{color:#888;font-size:14px;margin-bottom:24px}
    img{width:240px;height:240px;border:8px solid #f4f4f4;border-radius:8px}
    .url{font-size:11px;color:#bbb;margin-top:10px;word-break:break-all}
    .btns{margin-top:20px;display:flex;gap:10px;justify-content:center}
    .btn{padding:10px 20px;border-radius:8px;font-size:13px;cursor:pointer;border:none}
    .btn-blue{background:#1a73e8;color:white}
    .btn-outline{background:white;color:#1a73e8;border:1px solid #1a73e8;text-decoration:none;display:inline-block}
    @media print{.btns{display:none}body{background:white}}
  </style>
</head>
<body>
  <div class="qr-card">
    <h1>${d.name}</h1>
    <p class="owner">负责人：${d.owner}</p>
    <img src="${qrImg}" alt="QR Code">
    <p class="url">${url}</p>
    <div class="btns">
      <button class="btn btn-blue" onclick="window.print()">打印</button>
      <a class="btn btn-outline" href="/device/${d.id}">详情页</a>
    </div>
  </div>
</body>
</html>`);
});

// ─── 公共 HTML 模板 ───────────────────────────────────────────
function html(title, body) {
  return `<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f0f2f5;color:#333}
    .top-bar{background:#1a73e8;color:white;padding:14px 24px;display:flex;align-items:center;gap:14px}
    .top-bar h1{font-size:18px}
    .back{color:white;text-decoration:none;font-size:20px;line-height:1}
    .container{max-width:720px;margin:24px auto;padding:0 16px 40px}
    .card{background:white;border-radius:12px;padding:22px;margin-bottom:16px;box-shadow:0 2px 8px rgba(0,0,0,.07)}
    .section-title{font-size:13px;color:#888;text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}
    .info-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #f4f4f4;font-size:15px}
    .info-row:last-child{border-bottom:none}
    .badge{color:white;padding:4px 12px;border-radius:20px;font-size:12px}
    .form-group{margin-bottom:14px}
    .form-group label{display:block;font-size:13px;color:#666;margin-bottom:6px}
    .form-group input,.form-group select,.form-group textarea{width:100%;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px;outline:none}
    .form-group input:focus,.form-group select:focus,.form-group textarea:focus{border-color:#1a73e8}
    .form-group textarea{resize:vertical;min-height:80px}
    .btn{background:#1a73e8;color:white;border:none;padding:10px 22px;border-radius:8px;cursor:pointer;font-size:14px;text-decoration:none;display:inline-block}
    .btn:hover{background:#1557b0}
    .btn-outline{background:white;color:#1a73e8;border:1px solid #1a73e8}
    .btn-outline:hover{background:#f0f7ff}
    .btn-green{background:#22c55e}
    .btn-green:hover{background:#16a34a}
    .btn-red{background:#ef4444}
    .btn-red:hover{background:#dc2626}
    .notice{background:#fff8e1;border-radius:8px;padding:12px 16px;font-size:14px;margin-bottom:14px}
    .device-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
    .device-card{background:white;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.07)}
    .card-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
    .card-head h3{font-size:16px}
    .meta{color:#666;font-size:14px;margin-bottom:6px}
    .card-actions{margin-top:14px;display:flex;gap:8px}
    .add-form{display:flex;gap:10px;flex-wrap:wrap}
    .add-form input{flex:1;min-width:140px;padding:10px 14px;border:1px solid #ddd;border-radius:8px;font-size:14px}
    .empty{color:#aaa;text-align:center;padding:48px 0;font-size:15px}
    table{width:100%;border-collapse:collapse;font-size:14px}
    th{text-align:left;padding:10px;background:#f8f9fa;color:#666;font-weight:500}
    td{padding:10px;border-bottom:1px solid #f4f4f4}
  </style>
</head>
<body>${body}</body>
</html>`;
}

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`设备管理系统已启动：http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('数据库连接失败:', err.message);
  process.exit(1);
});
