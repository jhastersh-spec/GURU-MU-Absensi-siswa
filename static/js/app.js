const state = {
  csrfToken: '',
  username: '',
  page: 'dashboard',
  classes: [],
  students: [],
  cardStudents: [],
  sessionId: null,
  sessionOpen: false,
  roster: [],
  stream: null,
  cameraPermission: 'unknown',
  cameraPermissionStatus: null,
  detector: null,
  canvas: null,
  canvasContext: null,
  scanTimer: null,
  scanBusy: false,
  lastScanned: '',
  lastScannedAt: 0,
  clockTimer: null,
  refreshTimer: null,
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => Array.from(parent.querySelectorAll(selector));

async function api(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (method !== 'GET' && state.csrfToken) headers.set('X-CSRF-Token', state.csrfToken);
  const response = await fetch(url, { ...options, method, headers, credentials: 'same-origin' });
  const type = response.headers.get('content-type') || '';
  const result = type.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    if (response.status === 401 && !url.includes('/api/login')) {
      state.csrfToken = '';
      try {
        const authResponse = await fetch('/api/auth', { credentials: 'same-origin' });
        if (authResponse.ok) state.csrfToken = (await authResponse.json()).csrf_token;
      } catch (error) {
        console.error('Could not refresh the login token:', error);
      }
      showLogin();
    }
    throw new Error(result?.error || 'Permintaan gagal. Silakan coba kembali.');
  }
  return result;
}

function toast(message, kind = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  $('#toast-region').append(item);
  window.setTimeout(() => item.remove(), 4200);
}

function showLogin(message = '') {
  stopCamera();
  state.sessionId = null;
  state.sessionOpen = false;
  window.clearInterval(state.refreshTimer);
  $('#app-shell').hidden = true;
  $('#login-screen').hidden = false;
  $('#login-error').textContent = message;
}

function showApplication(username) {
  state.username = username;
  $('#sidebar-username').textContent = username;
  $('#welcome-name').textContent = username;
  $('#login-screen').hidden = true;
  $('#app-shell').hidden = false;
  startClock();
  loadDashboard().catch(error => toast(error.message, 'error'));
  window.clearInterval(state.refreshTimer);
  state.refreshTimer = window.setInterval(() => {
    if (!$('#app-shell').hidden) {
      loadDashboard().catch(error => console.error(error));
      if (state.page === 'scan' && state.sessionId) refreshRoster().catch(error => console.error(error));
    }
  }, 12000);
}

async function initialize() {
  $$('.nav-link[data-page], [data-page]').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      setPage(button.dataset.page);
    });
  });
  $$('[data-toggle-password]').forEach(button => {
    button.addEventListener('click', () => {
      const input = document.getElementById(button.dataset.togglePassword);
      input.type = input.type === 'password' ? 'text' : 'password';
      button.textContent = input.type === 'password' ? 'Lihat' : 'Sembunyi';
    });
  });
  $$('[data-close-dialog]').forEach(button => {
    button.addEventListener('click', () => document.getElementById(button.dataset.closeDialog).close());
  });

  $('#login-form').addEventListener('submit', handleLogin);
  $('#logout-button').addEventListener('click', handleLogout);
  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  $('#add-student-button').addEventListener('click', () => openStudentDialog());
  $('#student-form').addEventListener('submit', saveStudent);
  $('#student-search').addEventListener('input', debounce(() => loadStudents().catch(reportError), 250));
  $('#student-class-filter').addEventListener('change', () => loadStudents().catch(reportError));
  $('#card-search').addEventListener('input', debounce(renderCards, 200));
  $('#card-class-filter').addEventListener('change', renderCards);
  $('#print-all-cards').addEventListener('click', printAllCards);
  $('#print-card-button').addEventListener('click', () => window.print());
  $('#session-date').addEventListener('change', () => loadSessions().catch(reportError));
  $('#session-class').addEventListener('change', () => updateSessionButton());
  $('#open-session-button').addEventListener('click', openAttendanceSession);
  $('#session-select').addEventListener('change', chooseSession);
  $('#close-session-button').addEventListener('click', closeAttendanceSession);
  $('#start-camera').addEventListener('click', startCamera);
  $('#stop-camera').addEventListener('click', stopCamera);
  $('#manual-scan-button').addEventListener('click', () => submitScan($('#manual-token').value.trim()));
  $('#manual-token').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitScan($('#manual-token').value.trim());
    }
  });
  $('#report-period').addEventListener('change', updateReportPeriod);
  $('#report-refresh').addEventListener('click', () => loadReport().catch(reportError));
  $('#report-search').addEventListener('keydown', event => {
    if (event.key === 'Enter') loadReport().catch(reportError);
  });
  $('#report-class').addEventListener('change', () => loadReport().catch(reportError));
  $('#export-excel').addEventListener('click', () => downloadReport('xlsx').catch(reportError));
  $('#export-pdf').addEventListener('click', () => downloadReport('pdf').catch(reportError));
  $('#print-report').addEventListener('click', printReport);
  $('#password-form').addEventListener('submit', changePassword);
  $('#student-dialog').addEventListener('click', event => closeOnBackdrop(event, 'student-dialog'));
  $('#card-dialog').addEventListener('click', event => closeOnBackdrop(event, 'card-dialog'));

  const auth = await api('/api/auth');
  state.csrfToken = auth.csrf_token;
  await refreshCameraPermission();
  if (auth.authenticated) showApplication(auth.username);
  else showLogin();
}

function renderCameraPermissionHelp() {
  const help = $('#camera-permission-help');
  if (!help) return;
  const messages = {
    granted: 'Izin kamera aktif. Buka sesi absensi untuk mulai memindai.',
    denied: 'Izin kamera diblokir. Klik ikon pengaturan di kiri alamat situs, ubah Kamera menjadi Izinkan, lalu muat ulang halaman. Pastikan akses kamera juga diizinkan di Pengaturan Windows > Privasi & keamanan > Kamera.',
    prompt: 'Saat kamera diaktifkan, izinkan akses kamera pada dialog browser.',
  };
  help.textContent = messages[state.cameraPermission] || 'Kamera aktif setelah sesi absensi dibuka. Izinkan akses kamera jika browser memintanya.';
}

async function refreshCameraPermission() {
  if (!navigator.permissions?.query) {
    state.cameraPermission = 'unknown';
    renderCameraPermissionHelp();
    return;
  }
  if (state.cameraPermissionStatus) {
    state.cameraPermission = state.cameraPermissionStatus.state;
    renderCameraPermissionHelp();
    return;
  }
  try {
    const permission = await navigator.permissions.query({ name: 'camera' });
    state.cameraPermissionStatus = permission;
    state.cameraPermission = permission.state;
    permission.onchange = () => {
      state.cameraPermission = permission.state;
      renderCameraPermissionHelp();
    };
  } catch {
    state.cameraPermission = 'unknown';
  }
  renderCameraPermissionHelp();
}

async function handleLogin(event) {
  event.preventDefault();
  const formElement = event.currentTarget;
  $('#login-error').textContent = '';
  const form = new FormData(formElement);
  try {
    const result = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username: form.get('username'), password: form.get('password') }),
    });
    state.csrfToken = result.csrf_token;
    formElement.reset();
    showApplication(result.username);
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
}

async function handleLogout() {
  try {
    const response = await api('/api/logout', { method: 'POST', body: '{}' });
    state.csrfToken = response.csrf_token || '';
    showLogin();
  } catch (error) {
    toast(error.message, 'error');
  }
}

function startClock() {
  const update = () => {
    const now = new Date();
    $('#clock-label').textContent = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(now);
    $('#topbar-date').textContent = new Intl.DateTimeFormat('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(now);
  };
  update();
  window.clearInterval(state.clockTimer);
  state.clockTimer = window.setInterval(update, 1000);
}

async function setPage(page) {
  if (!page || !document.querySelector(`[data-view="${page}"]`)) return;
  if (page !== 'scan') stopCamera();
  state.page = page;
  $$('.page-view').forEach(view => { view.hidden = view.dataset.view !== page; });
  $$('.nav-link[data-page]').forEach(item => item.classList.toggle('active', item.dataset.page === page));
  const titles = { dashboard: 'Dashboard', scan: 'Scan Absensi', students: 'Data Siswa', reports: 'Rekap Absensi', cards: 'Kartu Siswa', settings: 'Pengaturan' };
  $('#page-heading').textContent = titles[page];
  $('#sidebar').classList.remove('open');
  try {
    if (page === 'dashboard') await loadDashboard();
    if (page === 'scan') {
      $('#session-date').value ||= localDateInput();
      await loadSessions();
      await loadAudit();
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopCamera();
    });
    if (page === 'students') await loadStudents();
    if (page === 'cards') await loadCardStudents();
    if (page === 'reports') {
      $('#report-date').value ||= localDateInput();
      $('#report-month').value ||= localMonthInput();
      await loadReport();
    }
  } catch (error) {
    reportError(error);
  }
}

async function loadDashboard() {
  const result = await api('/api/dashboard');
  state.classes = result.classes;
  populateClassOptions();
  $('#session-date').value ||= result.date;
  $('#dashboard-date').textContent = formatDate(result.date);
  const summary = result.summary;
  $('#stat-total').textContent = summary.total_students;
  $('#stat-present').textContent = summary.HADIR;
  $('#stat-izin').textContent = summary.IZIN;
  $('#stat-sakit').textContent = summary.SAKIT;
  $('#stat-alpa').textContent = summary.ALPA;
  $('#stat-pending').textContent = summary.belum_absen;
  $('#stat-percentage').textContent = `${summary.persentase_kehadiran}%`;
  const circumference = 2 * Math.PI * 50;
  $('#attendance-ring').setAttribute(
    'stroke-dashoffset',
    String(circumference * (1 - Math.min(summary.persentase_kehadiran, 100) / 100)),
  );
  $('#legend-present').textContent = summary.HADIR;
  $('#legend-izin').textContent = summary.IZIN;
  $('#legend-sakit').textContent = summary.SAKIT;
  $('#legend-alpa').textContent = summary.ALPA;
  renderDashboardSessions(result.sessions);
}

function populateClassOptions() {
  const selectors = ['#session-class', '#student-class-filter', '#report-class', '#card-class-filter'];
  const placeholders = ['Pilih kelas', 'Semua kelas', 'Semua kelas', 'Semua kelas'];
  selectors.forEach((selector, index) => {
    const select = $(selector);
    const selected = select.value;
    select.replaceChildren(new Option(placeholders[index], ''));
    state.classes.forEach(className => select.add(new Option(className, className)));
    if (state.classes.includes(selected)) select.value = selected;
  });
}

function renderDashboardSessions(sessions) {
  const container = $('#dashboard-sessions');
  container.replaceChildren();
  if (!sessions.length) {
    container.innerHTML = '<p class="empty-state">Belum ada sesi absensi hari ini.</p>';
    return;
  }
  sessions.forEach(item => {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.innerHTML = `<span class="session-avatar">${escapeHtml(item.class_name.slice(0, 2).toUpperCase())}</span>
      <span class="session-row-details"><strong>Kelas ${escapeHtml(item.class_name)}</strong><small>${item.hadir || 0} siswa hadir dari ${item.total || 0}</small></span>
      <span class="state-pill ${item.is_open ? 'open' : 'closed'}">${item.is_open ? 'Berlangsung' : 'Ditutup'}</span>`;
    container.append(row);
  });
}

async function loadStudents() {
  const query = new URLSearchParams();
  if ($('#student-search').value.trim()) query.set('search', $('#student-search').value.trim());
  if ($('#student-class-filter').value) query.set('class', $('#student-class-filter').value);
  const result = await api(`/api/students?${query}`);
  state.students = result.students;
  renderStudents();
}

function renderStudents() {
  const body = $('#students-body');
  body.replaceChildren();
  $('#student-count').textContent = `${state.students.length} siswa`;
  if (!state.students.length) {
    body.innerHTML = '<tr><td colspan="5" class="table-empty">Belum ada data siswa. Tambahkan siswa untuk memulai.</td></tr>';
    return;
  }
  state.students.forEach(student => {
    const row = document.createElement('tr');
    const initials = student.name.trim().split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
    const avatar = student.photo_url
      ? `<span class="student-avatar"><img src="${escapeHtml(student.photo_url)}" alt="" loading="lazy"></span>`
      : `<span class="student-avatar">${escapeHtml(initials)}</span>`;
    row.innerHTML = `<td><span class="student-cell">${avatar}<span class="student-name">${escapeHtml(student.name)}</span></span></td>
      <td>${escapeHtml(student.nis)}</td><td>${escapeHtml(student.class_name)}</td>
      <td><span class="status-badge belum">QR tersedia</span></td>
      <td><span class="table-actions"><button class="action-button edit-student" type="button">Edit</button><button class="action-button delete delete-student" type="button">Hapus</button></span></td>`;
    $('.edit-student', row).addEventListener('click', () => openStudentDialog(student));
    $('.delete-student', row).addEventListener('click', () => deleteStudent(student));
    body.append(row);
  });
}

function openStudentDialog(student = null) {
  const form = $('#student-form');
  form.reset();
  $('#student-form-error').textContent = '';
  $('#student-dialog-title').textContent = student ? 'Edit Siswa' : 'Tambah Siswa';
  form.elements.id.value = student?.id || '';
  form.elements.name.value = student?.name || '';
  form.elements.nis.value = student?.nis || '';
  form.elements.class_name.value = student?.class_name || '';
  form.elements.photo_url.value = student?.photo_url || '';
  $('#student-dialog').showModal();
}

async function saveStudent(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const payload = {
    name: form.elements.name.value.trim(),
    nis: form.elements.nis.value.trim(),
    class_name: form.elements.class_name.value.trim(),
    photo_url: form.elements.photo_url.value.trim(),
  };
  try {
    await api(id ? `/api/students/${id}` : '/api/students', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    $('#student-dialog').close();
    toast(id ? 'Data siswa berhasil diperbarui.' : 'Siswa baru berhasil ditambahkan.');
    await loadStudents();
    await loadDashboard();
  } catch (error) {
    $('#student-form-error').textContent = error.message;
  }
}

async function deleteStudent(student) {
  if (!window.confirm(`Hapus data ${student.name}? Riwayat absensi tetap tersimpan.`)) return;
  try {
    await api(`/api/students/${student.id}`, { method: 'DELETE' });
    toast(`${student.name} berhasil dihapus.`);
    await loadStudents();
    await loadDashboard();
  } catch (error) {
    reportError(error);
  }
}

async function loadSessions() {
  const day = $('#session-date').value || localDateInput();
  const result = await api(`/api/sessions?date=${encodeURIComponent(day)}`);
  state.classes = result.classes;
  populateClassOptions();
  const select = $('#session-select');
  const previous = state.sessionId;
  select.replaceChildren(new Option('Pilih sesi absensi', ''));
  result.sessions.forEach(item => {
    const suffix = item.is_open ? '— terbuka' : '— ditutup';
    select.add(new Option(`${item.class_name} ${suffix}`, item.id));
  });
  const matching = result.sessions.find(item => String(item.id) === String(previous))
    || result.sessions.find(item => item.is_open)
    || null;
  state.sessionId = matching ? Number(matching.id) : null;
  if (matching) select.value = String(matching.id);
  setSessionState(matching);
  await refreshRoster();
}

function setSessionState(attendanceSession) {
  state.sessionOpen = Boolean(attendanceSession?.is_open);
  $('#scanner-status').textContent = attendanceSession
    ? `${attendanceSession.class_name} · ${state.sessionOpen ? 'Sesi terbuka' : 'Sesi ditutup'}`
    : 'Sesi belum dipilih';
  $('#scanner-status').classList.toggle('session-open-pill', state.sessionOpen);
  $('#close-session-button').disabled = !state.sessionOpen;
  $('#open-session-button').textContent = state.sessionOpen ? 'Sesi Terbuka' : 'Buka Sesi';
  $('#open-session-button').disabled = state.sessionOpen;
  $('#start-camera').disabled = !state.sessionOpen;
  if (!state.sessionOpen) stopCamera();
}

function updateSessionButton() {
  $('#open-session-button').disabled = !$('#session-class').value || state.sessionOpen;
}

async function openAttendanceSession() {
  const className = $('#session-class').value;
  if (!className) return toast('Pilih kelas terlebih dahulu.', 'warning');
  try {
    const result = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ date: $('#session-date').value, class_name: className }),
    });
    state.sessionId = result.session.id;
    await loadSessions();
    await loadDashboard();
    toast(`Sesi absensi kelas ${className} dibuka.`);
  } catch (error) {
    reportError(error);
  }
}

async function chooseSession() {
  const nextSessionId = $('#session-select').value ? Number($('#session-select').value) : null;
  if (state.sessionId !== nextSessionId) stopCamera();
  state.sessionId = nextSessionId;
  const selected = state.sessionId ? $$('#session-select option').find(option => Number(option.value) === state.sessionId) : null;
  setSessionState(selected ? { is_open: selected.textContent.includes('terbuka'), class_name: selected.textContent.split(' — ')[0] } : null);
  await refreshRoster();
  await loadAudit();
}

async function closeAttendanceSession() {
  if (!state.sessionId || !window.confirm('Tutup sesi ini? Pemindaian kartu tidak dapat dilakukan sampai sesi dibuka kembali.')) return;
  try {
    await api(`/api/sessions/${state.sessionId}/close`, { method: 'POST', body: '{}' });
    await loadSessions();
    await loadDashboard();
    toast('Sesi absensi berhasil ditutup.');
  } catch (error) {
    reportError(error);
  }
}

async function refreshRoster() {
  const body = $('#roster-body');
  if (!state.sessionId) {
    state.roster = [];
    body.innerHTML = '<tr><td colspan="3" class="table-empty">Pilih atau buka sesi untuk melihat daftar siswa.</td></tr>';
    $('#roster-count').textContent = '0 siswa';
    return;
  }
  const result = await api(`/api/sessions/${state.sessionId}/roster`);
  state.sessionOpen = Boolean(result.session.is_open);
  $('#session-date').value = result.session.attendance_date;
  $('#session-class').value = result.session.class_name;
  setSessionState(result.session);
  state.roster = result.students;
  renderRoster();
}

function renderRoster() {
  const body = $('#roster-body');
  body.replaceChildren();
  $('#roster-count').textContent = `${state.roster.length} siswa`;
  if (!state.roster.length) {
    body.innerHTML = '<tr><td colspan="3" class="table-empty">Belum ada siswa di kelas ini.</td></tr>';
    return;
  }
  state.roster.forEach(student => {
    const row = document.createElement('tr');
    const status = student.status || 'BELUM ABSEN';
    row.innerHTML = `<td><span class="student-name">${escapeHtml(student.name)}</span></td>
      <td>${escapeHtml(student.nis)}</td>
      <td><select class="attendance-select" aria-label="Status ${escapeHtml(student.name)}">
        ${['HADIR', 'IZIN', 'SAKIT', 'ALPA', 'BELUM ABSEN'].map(option => `<option value="${option}" ${status === option ? 'selected' : ''}>${option}</option>`).join('')}
      </select></td>`;
    $('.attendance-select', row).addEventListener('change', event => setStudentStatus(student, event.currentTarget.value));
    body.append(row);
  });
}

async function setStudentStatus(student, status) {
  const note = status === 'IZIN' || status === 'SAKIT' || status === 'ALPA'
    ? window.prompt('Catatan (opsional):', '')
    : '';
  if (note === null) {
    renderRoster();
    return;
  }
  try {
    await api(`/api/sessions/${state.sessionId}/students/${student.id}`, {
      method: 'PUT',
      body: JSON.stringify({ status, note }),
    });
    toast(`Status ${student.name} diperbarui menjadi ${status}.`);
    await refreshRoster();
    await loadDashboard();
    await loadAudit();
  } catch (error) {
    reportError(error);
    await refreshRoster().catch(console.error);
  }
}

async function loadAudit() {
  const panel = $('#audit-panel');
  if (!state.sessionId || state.page !== 'scan') {
    panel.hidden = true;
    return;
  }
  const result = await api(`/api/audit?session_id=${state.sessionId}`);
  panel.hidden = false;
  const list = $('#audit-list');
  list.replaceChildren();
  if (!result.logs.length) {
    list.innerHTML = '<p class="muted">Belum ada perubahan status.</p>';
    return;
  }
  result.logs.forEach(item => {
    const row = document.createElement('div');
    row.className = 'audit-item';
    row.innerHTML = `<strong>${escapeHtml(item.student_name)}</strong><span>${escapeHtml(item.previous_status || '—')} → ${escapeHtml(item.new_status)}</span><span>${escapeHtml(item.username)} · ${formatDateTime(item.changed_at)}</span>${item.note ? `<span>${escapeHtml(item.note)}</span>` : ''}`;
    list.append(row);
  });
}

async function startCamera() {
  if (!state.sessionId || !state.sessionOpen) return toast('Buka sesi absensi sebelum mengaktifkan kamera.', 'warning');
  if (!window.isSecureContext) return toast('Kamera hanya dapat digunakan melalui HTTPS atau localhost.', 'error');
  if (!navigator.mediaDevices?.getUserMedia) return toast('Browser ini tidak mendukung akses kamera. Gunakan browser modern melalui HTTPS.', 'error');
  await refreshCameraPermission();
  if (state.cameraPermission === 'denied') {
    renderCameraPermissionHelp();
    return toast('Izin kamera diblokir. Izinkan kamera di setelan situs, lalu muat ulang halaman.', 'error');
  }
  if (typeof window.jsQR !== 'function') return toast('Pemindai QR gagal dimuat. Muat ulang halaman sebelum memindai.', 'error');
  try {
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (error) {
      if (!['OverconstrainedError', 'NotFoundError', 'TypeError'].includes(error.name)) throw error;
      state.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    const video = $('#camera-video');
    video.setAttribute('autoplay', '');
    video.srcObject = state.stream;
    await video.play();
    state.detector = null;
    if ('BarcodeDetector' in window) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.includes('qr_code')) state.detector = new BarcodeDetector({ formats: ['qr_code'] });
      } catch (error) {
        console.info('Native QR scanning unavailable; using the local QR decoder.', error);
      }
    }
    state.canvas = document.createElement('canvas');
    state.canvasContext = state.canvas.getContext('2d', { willReadFrequently: true });
    if (!state.canvasContext) throw new Error('Browser tidak dapat menyiapkan pemindai gambar.');
    $('#camera-video').parentElement.classList.add('scanning');
    $('.camera-indicator').classList.add('active');
    $('.camera-indicator').lastChild.textContent = state.detector ? ' Kamera' : ' Kamera · QR aktif';
    $('#start-camera').disabled = true;
    $('#stop-camera').disabled = false;
    state.stream.getVideoTracks().forEach(track => {
      track.addEventListener('ended', () => {
        if (state.stream) {
          stopCamera();
          toast('Koneksi kamera terputus. Aktifkan kamera kembali.', 'warning');
        }
      }, { once: true });
    });
    scanFrame();
  } catch (error) {
    stopCamera();
    const messages = {
      NotAllowedError: 'Akses kamera ditolak. Izinkan kamera pada setelan situs dan pengaturan privasi Windows, lalu muat ulang halaman.',
      NotFoundError: 'Kamera tidak ditemukan. Periksa koneksi kamera atau pilih perangkat yang memiliki kamera.',
      NotReadableError: 'Kamera sedang digunakan aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.',
      SecurityError: 'Browser memblokir akses kamera. Gunakan HTTPS atau localhost dan izinkan kamera.',
    };
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      state.cameraPermission = 'denied';
      renderCameraPermissionHelp();
    }
    toast(messages[error.name] || `Kamera tidak dapat dibuka: ${error.message}`, 'error');
  }
}

function stopCamera() {
  window.clearTimeout(state.scanTimer);
  if (state.stream) state.stream.getTracks().forEach(track => track.stop());
  state.stream = null;
  state.detector = null;
  state.canvas = null;
  state.canvasContext = null;
  state.scanBusy = false;
  const video = $('#camera-video');
  if (video) video.srcObject = null;
  const frame = $('.camera-frame');
  if (frame) frame.classList.remove('scanning');
  $('.camera-indicator')?.classList.remove('active');
  if ($('#start-camera')) $('#start-camera').disabled = !state.sessionOpen;
  if ($('#stop-camera')) $('#stop-camera').disabled = true;
}

async function scanFrame() {
  if (!state.stream || state.scanBusy) return;
  const video = $('#camera-video');
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    state.scanBusy = true;
    try {
      let token = '';
      if (state.detector) {
        const codes = await state.detector.detect(video);
        token = codes[0]?.rawValue || '';
      } else if (state.canvas && state.canvasContext && video.videoWidth && video.videoHeight) {
        const width = Math.min(video.videoWidth, 800);
        const height = Math.round(video.videoHeight * width / video.videoWidth);
        if (state.canvas.width !== width || state.canvas.height !== height) {
          state.canvas.width = width;
          state.canvas.height = height;
        }
        state.canvasContext.drawImage(video, 0, 0, width, height);
        const frame = state.canvasContext.getImageData(0, 0, width, height);
        token = window.jsQR(frame.data, width, height, { inversionAttempts: 'dontInvert' })?.data || '';
      }
      if (token) await submitScan(token);
    } catch (error) {
      stopCamera();
      console.error('QR scan failed:', error);
      toast(`Pemindaian QR terhenti: ${error.message}`, 'error');
    } finally {
      state.scanBusy = false;
    }
  }
  if (state.stream) state.scanTimer = window.setTimeout(scanFrame, state.detector ? 220 : 320);
}

async function submitScan(token) {
  if (!token) return toast('Kode QR tidak boleh kosong.', 'warning');
  if (!state.sessionId) return toast('Pilih sesi absensi terlebih dahulu.', 'warning');
  const now = Date.now();
  if (token === state.lastScanned && now - state.lastScannedAt < 2200) return;
  state.lastScanned = token;
  state.lastScannedAt = now;
  try {
    const result = await api('/api/scan', {
      method: 'POST',
      body: JSON.stringify({ qr_token: token, session_id: state.sessionId }),
    });
    $('#manual-token').value = '';
    $('#last-scan').textContent = `✓ ${result.message}`;
    $('#last-scan').hidden = false;
    toast(result.message, 'success');
    await Promise.all([refreshRoster(), loadDashboard(), loadAudit()]);
  } catch (error) {
    toast(error.message, error.message.includes('sudah melakukan') ? 'warning' : 'error');
  }
}

async function loadCardStudents() {
  const query = new URLSearchParams();
  if ($('#card-search').value.trim()) query.set('search', $('#card-search').value.trim());
  if ($('#card-class-filter').value) query.set('class', $('#card-class-filter').value);
  const result = await api(`/api/students?${query}`);
  state.cardStudents = result.students;
  renderCards();
}

function renderCards() {
  if (state.page !== 'cards') return;
  const search = $('#card-search').value.trim().toLocaleLowerCase();
  const className = $('#card-class-filter').value;
  const filtered = state.cardStudents.filter(student =>
    (!className || student.class_name === className)
    && (!search || student.name.toLocaleLowerCase().includes(search) || student.nis.toLocaleLowerCase().includes(search))
  );
  const body = $('#cards-body');
  body.replaceChildren();
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="4" class="table-empty">Tidak ada siswa yang cocok dengan pencarian.</td></tr>';
    return;
  }
  filtered.forEach(student => {
    const row = document.createElement('tr');
    row.innerHTML = `<td><span class="student-name">${escapeHtml(student.name)}</span></td><td>${escapeHtml(student.nis)}</td><td>${escapeHtml(student.class_name)}</td><td><button class="button secondary print-single-card">Cetak Kartu</button></td>`;
    $('.print-single-card', row).addEventListener('click', () => showStudentCard(student.id));
    body.append(row);
  });
}

async function showStudentCard(studentId) {
  try {
    const result = await api(`/api/students/${studentId}/card`);
    $('#card-preview').innerHTML = cardMarkup(result);
    $('#card-dialog').showModal();
  } catch (error) {
    reportError(error);
  }
}

async function printAllCards() {
  const button = $('#print-all-cards');
  button.disabled = true;
  try {
    const query = new URLSearchParams();
    if ($('#card-search').value.trim()) query.set('search', $('#card-search').value.trim());
    if ($('#card-class-filter').value) query.set('class', $('#card-class-filter').value);
    const result = await api(`/api/students?${query}`);
    if (!result.students.length) return toast('Tidak ada kartu untuk dicetak.', 'warning');
    const cards = await Promise.all(result.students.map(student => api(`/api/students/${student.id}/card`)));
    $('#card-preview').innerHTML = cards.map(cardMarkup).join('');
    $('#card-dialog').showModal();
    window.setTimeout(() => window.print(), 250);
  } catch (error) {
    reportError(error);
  } finally {
    button.disabled = false;
  }
}

function cardMarkup(result) {
  const student = result.student;
  return `<article class="student-card"><div class="student-card-copy"><p class="student-card-label">KARTU ABSENSI SISWA</p><h3>${escapeHtml(student.name)}</h3><p>Nomor Induk: <strong>${escapeHtml(student.nis)}</strong></p><p>Kelas: <strong>${escapeHtml(student.class_name)}</strong></p></div><img class="student-card-qr" src="${result.qr_data_url}" alt="QR Code absensi ${escapeHtml(student.name)}"></article>`;
}

function updateReportPeriod() {
  const monthly = $('#report-period').value === 'monthly';
  $('#report-date-wrap').hidden = monthly;
  $('#report-month-wrap').hidden = !monthly;
}

function reportQuery() {
  const query = new URLSearchParams({ period: $('#report-period').value });
  if ($('#report-period').value === 'monthly') query.set('month', $('#report-month').value);
  else query.set('date', $('#report-date').value);
  if ($('#report-class').value) query.set('class', $('#report-class').value);
  if ($('#report-search').value.trim()) query.set('search', $('#report-search').value.trim());
  return query;
}

async function loadReport() {
  const result = await api(`/api/reports?${reportQuery()}`);
  $('#report-range').textContent = result.range.start === result.range.end
    ? `Tanggal ${formatDate(result.range.start)}`
    : `${formatDate(result.range.start)} — ${formatDate(result.range.end)}`;
  $('#report-hadir').textContent = result.totals.HADIR;
  $('#report-izin').textContent = result.totals.IZIN;
  $('#report-sakit').textContent = result.totals.SAKIT;
  $('#report-alpa').textContent = result.totals.ALPA;
  const body = $('#report-body');
  body.replaceChildren();
  if (!result.students.length) {
    body.innerHTML = '<tr><td colspan="8" class="table-empty">Belum ada catatan absensi pada periode ini.</td></tr>';
    return;
  }
  result.students.forEach(student => {
    const row = document.createElement('tr');
    row.innerHTML = `<td><span class="student-name">${escapeHtml(student.name)}</span></td><td>${escapeHtml(student.nis)}</td><td>${escapeHtml(student.class_name)}</td><td>${student.HADIR}</td><td>${student.IZIN}</td><td>${student.SAKIT}</td><td>${student.ALPA}</td><td>${student.attendance_percentage}%</td>`;
    body.append(row);
  });
}

async function downloadReport(format) {
  const response = await fetch(`/api/reports/export.${format}?${reportQuery()}`, { credentials: 'same-origin' });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Ekspor laporan gagal.');
  }
  const file = await response.blob();
  const disposition = response.headers.get('content-disposition') || '';
  const fileName = disposition.match(/filename="?([^";]+)"?/i)?.[1] || `rekap-absensi.${format}`;
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(file);
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function printReport() {
  document.body.classList.add('printing-report');
  window.print();
  document.body.classList.remove('printing-report');
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const currentPassword = form.elements.current_password.value;
  const newPassword = form.elements.new_password.value;
  const confirmPassword = form.elements.confirm_password.value;
  const message = $('#password-message');
  message.classList.remove('error');
  message.textContent = '';
  if (newPassword !== confirmPassword) {
    message.textContent = 'Konfirmasi password baru tidak sama.';
    message.classList.add('error');
    return;
  }
  try {
    const result = await api('/api/settings/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    });
    state.csrfToken = result.csrf_token;
    form.reset();
    message.textContent = 'Password berhasil diganti.';
    message.classList.remove('error');
    toast('Password berhasil diganti.');
  } catch (error) {
    message.textContent = error.message;
    message.classList.add('error');
  }
}

function closeOnBackdrop(event, dialogId) {
  if (event.target === document.getElementById(dialogId)) event.target.close();
}

function formatDate(value) {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(year, month - 1, day));
}

function localDateInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function localMonthInput() {
  return localDateInput().slice(0, 7);
}

function formatDateTime(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('id-ID', { dateStyle: 'short', timeStyle: 'short' }).format(parsed);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function debounce(callback, delay) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}

function reportError(error) {
  toast(error.message || 'Terjadi kesalahan.', 'error');
}

document.addEventListener('DOMContentLoaded', () => {
  initialize().catch(error => {
    console.error(error);
    showLogin('Aplikasi belum siap. Periksa konfigurasi admin dan jalankan ulang server.');
  });
});
