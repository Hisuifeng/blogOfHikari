/* ==========================================================
   calendar.js — 首页日历 + 节假日提示 + 节假日数据兜底
   结构见 layout/_partial/calendar.ejs，数据见 _partial/calendar-data.ejs。

   渲染为什么放在浏览器：站点是静态的，构建日几乎不会是访客打开的日期。
   「今天是几号、是不是节假日、本月是哪个月」只有客户端知道。

   节假日数据的可靠性策略（由外到内共四层）：
     1. 内置表（_config.yml 的 holidays / workdays）—— 自带、离线可用、首屏同步生效；
     2. 接口兜底 —— 只在「内置表没覆盖的年份」请求，多个源顺次尝试；
     3. 浏览器缓存 —— 拿到就按年存 localStorage，缓存期内不再请求；
     4. 负缓存 —— 接口明确没有数据（例如次年安排还没公布）时短路一段时间，
        免得每次打开页面都去敲一遍。
   任何一层失败都只是「这一年的假期标不出来」，不会影响文章分布、不会报错、
   不会阻塞渲染，也不会向第三方发送访客信息（credentials: 'omit'）。

   首页走的是 pjax 无刷新换页（js/pjax.js），换回来时本脚本会被重新注入执行，
   所以这里不保存跨页状态；但 localStorage 里的年度数据会跨页复用。
   ========================================================== */
(function () {
	'use strict';

	var dataEl = document.getElementById('cal-data');
	if (!dataEl) return;

	var data;
	try {
		data = JSON.parse(dataEl.textContent);
	} catch (e) {
		return;
	}
	if (!data) return;

	var POSTS = data.posts || {};
	var WEEK = ['一', '二', '三', '四', '五', '六', '日'];

	var API = data.api || {};
	var API_URLS = API.urls || [];
	var API_ON = API.enable !== false && API_URLS.length > 0;
	var API_TIMEOUT = API.timeout > 0 ? API.timeout : 4000;
	var CACHE_DAYS = API.cacheDays > 0 ? API.cacheDays : 30;
	var RETRY_HOURS = API.retryHours > 0 ? API.retryHours : 6;

	var CACHE_PREFIX = 'restart-cal-';
	var MISS_PREFIX = 'restart-cal-nodata-';

	function pad(n) {
		return (n < 10 ? '0' : '') + n;
	}

	function key(d) {
		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
	}

	/* 'YYYY-MM-DD' -> 本地零点 Date。用 new Date(str) 会按 UTC 解析，
	   东八区以外整体差一天。 */
	function parseDay(s) {
		var p = String(s || '').split('-');
		if (p.length !== 3) return null;
		var d = new Date(+p[0], +p[1] - 1, +p[2]);
		return isNaN(d.getTime()) ? null : d;
	}

	function addDays(d, n) {
		return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
	}

	function nextKey(k) {
		var d = parseDay(k);
		return d ? key(addDays(d, 1)) : '';
	}

	/* ---------- 假期表 ---------- */
	var holidays = {};    /* 日期 -> {name, day, total} */
	var workdays = {};    /* 日期 -> true */
	var staticYears = {}; /* 内置表覆盖到的年份 */
	var covered = {};     /* 已经有数据的年份：不再请求 */
	var attempted = {};   /* 本次页面已经试过的年份：同一次浏览不重复请求 */

	function addRange(name, start, end, overwrite) {
		var s = parseDay(start);
		var e = parseDay(end || start);
		if (!s || !e) return;
		var total = Math.round((e - s) / 86400000) + 1;
		/* 上限兜底：正常假期最长 9 天，异常长的区间说明数据不对，直接不认 */
		if (total < 1 || total > 40) return;
		for (var n = 0; n < total; n++) {
			var k = key(addDays(s, n));
			if (!overwrite && holidays[k]) continue;
			holidays[k] = { name: name, day: n + 1, total: total };
		}
	}

	function addWorkday(d) {
		if (parseDay(d)) workdays[d] = true;
	}

	/* 内置表：先标记它覆盖了哪些年份，再写进表里。
	   staticYears 决定「哪些年份还需要问接口」。 */
	(data.holidays || []).forEach(function (h) {
		if (!h || !h.name || !h.start) return;
		var s = parseDay(h.start);
		if (s) staticYears[s.getFullYear()] = true;
		addRange(String(h.name), h.start, h.end || h.start, true);
	});

	(data.workdays || []).forEach(function (d) {
		var p = parseDay(d);
		if (p) staticYears[p.getFullYear()] = true;
		addWorkday(d);
	});

	/* ---------- 接口兜底 ---------- */

	function readStore(k) {
		try {
			var raw = localStorage.getItem(k);
			return raw ? JSON.parse(raw) : null;
		} catch (e) {
			return null; /* 隐私模式下 localStorage 会抛错，当成没有缓存 */
		}
	}

	function writeStore(k, v) {
		try {
			localStorage.setItem(k, JSON.stringify(v));
		} catch (e) {}
	}

	function removeStore(k) {
		try {
			localStorage.removeItem(k);
		} catch (e) {}
	}

	/* 带超时的 JSON 请求。不带 cookies：第三方接口不需要，
	   也不该把访客身份带出去。 */
	function fetchJson(url) {
		if (!window.fetch) return Promise.reject(new Error('no fetch'));

		var opt = { credentials: 'omit', cache: 'default' };
		var ac = null;
		var timer = 0;

		if (typeof AbortController === 'function') {
			ac = new AbortController();
			opt.signal = ac.signal;
			timer = setTimeout(function () { ac.abort(); }, API_TIMEOUT);
		}

		return fetch(url, opt).then(function (res) {
			if (timer) clearTimeout(timer);
			if (!res.ok) throw new Error('HTTP ' + res.status);
			return res.json();
		}, function (err) {
			if (timer) clearTimeout(timer);
			throw err;
		});
	}

	/* 把各家的返回统一成 {off: [{date, name}], work: [日期]}。
	   只认看得懂的字段组合，看不懂就返回 null 让下一个源接手。 */
	function normalize(payload, year) {
		var list = null;
		var i;

		if (!payload || typeof payload !== 'object') return null;

		if (Array.isArray(payload.days)) {
			/* holiday-cn: {year, papers, days:[{name, date, isOffDay}]} */
			list = payload.days;
		} else if (Array.isArray(payload)) {
			list = payload;
		} else if (payload.holiday && typeof payload.holiday === 'object') {
			/* timor.tech: {code, holiday: {'MM-DD': {holiday, name, date}}} */
			list = [];
			for (i in payload.holiday) {
				if (Object.prototype.hasOwnProperty.call(payload.holiday, i)) {
					list.push(payload.holiday[i]);
				}
			}
		} else if (payload.data && Array.isArray(payload.data.list)) {
			/* apihubs 一类：{code, data:{list:[...]}} */
			list = payload.data.list;
		}

		if (!list || list.length > 200) return null;

		var off = [];
		var work = [];

		list.forEach(function (item) {
			if (!item || typeof item !== 'object') return;

			var date = normDate(item.date !== undefined ? item.date : item.day, year);
			if (!date || date.slice(0, 4) !== String(year)) return;

			var flag = offDay(item);
			if (flag === null) return;

			if (flag) {
				off.push({ date: date, name: String(item.name || item.label || '假期').trim() });
			} else {
				work.push(date);
			}
		});

		return (off.length || work.length) ? { off: off, work: work } : null;
	}

	/* 只接受 2026-01-01 / 20260101 / 01-01 三种写法，年份不对就丢掉 */
	function normDate(raw, year) {
		if (raw === undefined || raw === null) return '';
		var s = String(raw).trim();
		var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s) || /^(\d{4})(\d{2})(\d{2})$/.exec(s);

		if (m) {
			var y = +m[1];
			var mo = +m[2];
			var d = +m[3];
			if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
			return y + '-' + pad(mo) + '-' + pad(d);
		}

		m = /^(\d{1,2})-(\d{1,2})$/.exec(s);
		if (m) {
			var m2 = +m[1];
			var d2 = +m[2];
			if (m2 < 1 || m2 > 12 || d2 < 1 || d2 > 31) return '';
			return year + '-' + pad(m2) + '-' + pad(d2);
		}

		return '';
	}

	/* 放假还是补班：各家字段名不同，逐个认 */
	function offDay(item) {
		if (typeof item.isOffDay === 'boolean') return item.isOffDay;
		if (typeof item.holiday === 'boolean') return item.holiday;
		if (item.holiday === 1 || item.holiday === '1') return true;
		if (item.holiday === 0 || item.holiday === '0') return false;
		if (typeof item.type === 'number') return item.type === 1;
		if (typeof item.workday === 'boolean') return !item.workday;
		return null;
	}

	/* 连续的放假日记成一段。刻意不按名字分组：
	   timor.tech 会把春节各天写成「除夕 / 初一 / 初二…」，
	   按名字分会把一个春节拆成七八段。 */
	function toRanges(off) {
		var sorted = off.slice().sort(function (a, b) {
			return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0);
		});

		var ranges = [];

		sorted.forEach(function (d) {
			var last = ranges[ranges.length - 1];
			if (last && nextKey(last.end) === d.date) {
				last.end = d.date;
				return;
			}
			ranges.push({ name: d.name, start: d.date, end: d.date });
		});

		return ranges;
	}

	function applyRanges(ranges, overwrite) {
		ranges.forEach(function (r) {
			addRange(r.name, r.start, r.end, overwrite);
		});
	}

	/* 已经拿到的年度数据直接落表 */
	function applyYear(res, overwrite) {
		applyRanges(res.ranges, overwrite);
		(res.work || []).forEach(addWorkday);
	}

	function loadYear(year, done) {
		if (!API_ON || covered[year]) {
			if (done) done();
			return;
		}

		var overwrite = API.mode === 'always';

		/* 内置表覆盖的年份不再打扰接口：离线也能用，请求也最少 */
		if (!overwrite && staticYears[year]) {
			covered[year] = true;
			if (done) done();
			return;
		}

		var cached = readStore(CACHE_PREFIX + year);
		if (cached && cached.t && Date.now() - cached.t <= CACHE_DAYS * 86400000) {
			applyYear(cached, overwrite);
			covered[year] = true;
			refresh();
			if (done) done();
			return;
		}

		/* 接口明确说过「没有这一年的数据」，短时间内不再问 */
		var miss = readStore(MISS_PREFIX + year);
		if (miss && miss.t && Date.now() - miss.t <= RETRY_HOURS * 3600000) {
			if (done) done();
			return;
		}

		if (attempted[year]) {
			if (done) done();
			return;
		}
		attempted[year] = true;

		var urls = API_URLS.map(function (u) {
			return String(u).replace('{year}', year);
		});

		(function tryNext(i) {
			if (i >= urls.length) {
				/* 所有源都没给出可用数据：短路一段时间，之后自然会再试 */
				writeStore(MISS_PREFIX + year, { t: Date.now() });
				if (done) done();
				return;
			}

			fetchJson(urls[i]).then(function (payload) {
				var res = normalize(payload, year);
				if (!res) throw new Error('unexpected payload');

				var ranges = toRanges(res.off);
				var record = { t: Date.now(), ranges: ranges, work: res.work };

				applyYear(record, overwrite);
				writeStore(CACHE_PREFIX + year, record);
				removeStore(MISS_PREFIX + year);
				covered[year] = true;
				refresh();
				if (done) done();
			}, function () {
				tryNext(i + 1);
			}).catch(function () {
				tryNext(i + 1);
			});
		})(0);
	}

	/* ---------- 节假日提示 ---------- */

	/* 把「今天是哪个节日」交给播放器：内置表没覆盖的年份是由接口补出来的，
	   那边只有静态区间可用，靠这一步才能在这类年份也放上节日主题曲。
	   歌单映射直接读 #player-data —— 那边已经把配置规范化过一遍，
	   这里不再重复实现一份。 */
	function notifyThemeSong(name) {
		var pd = document.getElementById('player-data');
		if (!pd || !name) return;

		var map = null;
		try {
			var raw = JSON.parse(pd.textContent);
			map = raw && raw.holidaySongs;
		} catch (e) {
			return;
		}

		var s = map && map[name];
		if (!s || !s.url) return;

		var payload = {
			name: s.name || name + '主题曲',
			artist: s.artist || '',
			url: s.url,
			holiday: name
		};

		/* 首屏时播放器还没执行：先排队，它初始化完会自己来取 */
		if (window.__restartHolidaySong) window.__restartHolidaySong(payload);
		else (window.__restartHolidaySongQueue = window.__restartHolidaySongQueue || []).push(payload);
	}

	function renderPrompt() {
		var box = document.getElementById('cal-prompt');
		var textEl = document.getElementById('cal-prompt-text');
		if (!box || !textEl) return;

		var todayK = key(new Date());
		var hit = holidays[todayK];
		var texts = data.promptTexts || {};
		var tpl = '';
		var vars = null;

		if (hit) {
			/* 分节日文案优先，其次通用文案 */
			tpl = texts[hit.name] || data.promptText || '';
			vars = { name: hit.name, day: hit.day, total: hit.total, date: todayK };
			notifyThemeSong(hit.name);
		} else if (data.workdayPrompt && workdays[todayK]) {
			tpl = data.workdayText || '';
			vars = { name: '调休', day: '', total: '', date: todayK };
		}

		if (!tpl) {
			box.hidden = true;
			return;
		}

		/* 未知占位符原样保留，方便一眼看出是配置写错了 */
		textEl.textContent = tpl.replace(/\{(\w+)\}/g, function (m, k) {
			return (vars[k] === undefined || vars[k] === null) ? m : String(vars[k]);
		});
		box.setAttribute('data-kind', hit ? 'holiday' : 'workday');
		box.hidden = false;
	}

	/* ---------- 月历 ---------- */
	var root = document.getElementById('cal');
	var now = new Date();

	/* 只开了提示、没开月历的情况：提示同样要能吃到接口数据，
	   所以这里也要为「今天所在的年份」发起一次兜底请求。 */
	if (!root) {
		renderPrompt();
		loadYear(now.getFullYear());
		return;
	}

	var titleEl = document.getElementById('cal-title');
	var weekEl = document.getElementById('cal-week');
	var gridEl = document.getElementById('cal-grid');
	var countEl = document.getElementById('cal-count');
	var listEl = document.getElementById('cal-posts');
	var barsEl = document.getElementById('cal-bars');
	var monthsEl = document.getElementById('cal-months');

	var view = { y: now.getFullYear(), m: now.getMonth() };
	var selected = null;

	/* 表头只画一次，换月不动它 */
	if (weekEl) {
		weekEl.innerHTML = '';
		WEEK.forEach(function (w) {
			var s = document.createElement('span');
			s.textContent = w;
			weekEl.appendChild(s);
		});
	}

	function postCount(y, m, d) {
		var n = 0;
		var last = d || 31;
		for (var i = 1; i <= last; i++) {
			var list = POSTS[y + '-' + pad(m + 1) + '-' + pad(i)];
			if (list) n += list.length;
		}
		return n;
	}

	/* 全年柱状分布：点柱子直接跳到那个月 */
	function renderBars() {
		if (!barsEl) return;
		barsEl.innerHTML = '';
		if (monthsEl) monthsEl.innerHTML = '';

		var counts = [];
		var max = 1;
		for (var m = 0; m < 12; m++) {
			var c = postCount(view.y, m);
			counts.push(c);
			if (c > max) max = c;
		}

		counts.forEach(function (c, m) {
			var b = document.createElement('button');
			b.type = 'button';
			b.className = 'cal-bar' + (c ? ' has-post' : '');
			b.title = (m + 1) + ' 月 · ' + c + ' 篇';
			b.setAttribute('aria-label', (m + 1) + ' 月，' + c + ' 篇文章');

			var bar = document.createElement('i');
			/* 有文章的月份至少给 20% 高度，否则 1 篇的柱子几乎看不见 */
			bar.style.height = c ? Math.max(20, Math.round((c / max) * 100)) + '%' : '1px';
			b.appendChild(bar);

			b.addEventListener('click', function () {
				view.m = m;
				render();
				loadYear(view.y);
			});

			barsEl.appendChild(b);

			if (monthsEl) {
				var s = document.createElement('span');
				s.textContent = m + 1;
				monthsEl.appendChild(s);
			}
		});
	}

	function showPosts(k) {
		if (!listEl) return;
		var list = POSTS[k] || [];

		listEl.innerHTML = '';

		if (!list.length) {
			listEl.hidden = true;
			return;
		}

		var head = document.createElement('li');
		head.className = 'cal-post-day';
		head.textContent = k.slice(5).replace('-', ' 月 ') + ' 日';
		listEl.appendChild(head);

		list.forEach(function (p) {
			var li = document.createElement('li');
			var a = document.createElement('a');
			a.href = p.u;
			a.textContent = p.t;
			li.appendChild(a);
			listEl.appendChild(li);
		});

		listEl.hidden = false;
	}

	function select(k, btn) {
		selected = k;
		Array.prototype.forEach.call(gridEl.querySelectorAll('.cal-day.selected'), function (el) {
			el.classList.remove('selected');
		});
		if (btn) btn.classList.add('selected');
		showPosts(k);
	}

	function render() {
		if (!titleEl || !gridEl) return;

		titleEl.textContent = view.y + ' 年 ' + (view.m + 1) + ' 月';
		gridEl.innerHTML = '';
		if (listEl) {
			listEl.hidden = true;
			listEl.innerHTML = '';
		}

		var first = new Date(view.y, view.m, 1);
		/* 周一当一周第一天：(getDay() 里周日是 0) */
		var lead = (first.getDay() + 6) % 7;
		var days = new Date(view.y, view.m + 1, 0).getDate();
		var total = 0;
		var i;
		var d;

		for (i = 0; i < lead; i++) {
			var blank = document.createElement('span');
			blank.className = 'cal-day is-empty';
			blank.setAttribute('aria-hidden', 'true');
			gridEl.appendChild(blank);
		}

		for (d = 1; d <= days; d++) {
			var k = view.y + '-' + pad(view.m + 1) + '-' + pad(d);
			var list = POSTS[k];
			var hol = holidays[k];
			var isWork = workdays[k];

			var btn = document.createElement('button');
			btn.type = 'button';
			btn.className = 'cal-day';
			btn.textContent = d;
			btn.setAttribute('data-date', k);

			if (list && list.length) {
				btn.classList.add('has-post');
				total += list.length;
			}
			if (hol) {
				btn.classList.add('is-holiday');
				btn.title = hol.name + ' 假期第 ' + hol.day + ' 天（共 ' + hol.total + ' 天）';
			}
			if (isWork) {
				btn.classList.add('is-workday');
				btn.title = '调休上班日';
			}
			if (k === todayKey) {
				btn.classList.add('is-today');
				btn.setAttribute('aria-current', 'date');
			}

			if (list && list.length) {
				btn.setAttribute('aria-label',
					(view.m + 1) + ' 月 ' + d + ' 日，' + list.length + ' 篇文章');
				btn.addEventListener('click', function (kk) {
					return function (e) {
						select(kk, e.currentTarget);
					};
				}(k));
			} else {
				btn.setAttribute('aria-label',
					(view.m + 1) + ' 月 ' + d + ' 日' + (hol ? '，' + hol.name : ''));
			}

			gridEl.appendChild(btn);
		}

		if (countEl) countEl.textContent = '本月 ' + total + ' 篇';

		renderBars();

		/* 接口数据是后到的：重画时把之前选中的那天补回来 */
		if (selected) {
			var sel = gridEl.querySelector('.cal-day[data-date="' + selected + '"]');
			if (sel) select(selected, sel);
		}

		/* 换到内置表没覆盖的年份时才去问接口 */
		loadYear(view.y);
	}

	function shift(n) {
		var m = view.m + n;
		view.y += Math.floor(m / 12);
		view.m = ((m % 12) + 12) % 12;
		render();
	}

	var todayKey = key(new Date());

	var prevBtn = document.getElementById('cal-prev');
	var nextBtn = document.getElementById('cal-next');
	if (prevBtn) prevBtn.addEventListener('click', function () { shift(-1); });
	if (nextBtn) nextBtn.addEventListener('click', function () { shift(1); });

	if (titleEl) {
		titleEl.addEventListener('click', function () {
			var t = new Date();
			view.y = t.getFullYear();
			view.m = t.getMonth();
			render();
		});
	}

	/* 接口数据到位后统一刷新：提示条与月历都重画一遍。
	   放在函数声明之后调用，避免 loadYear 里的回调拿到未初始化的 todayKey。 */
	function refresh() {
		renderPrompt();
		render();
	}

	render();
	renderPrompt();

	/* 今天的年份（提示条用）与当前看的年份各试一次，去重由 attempted 保证 */
	loadYear(now.getFullYear());
	loadYear(view.y);
})();
