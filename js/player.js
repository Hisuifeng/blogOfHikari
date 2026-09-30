/* ==========================================================
   player.js — 固定音乐播放器
   与 layout/_partial/player.ejs（结构）、css/player.css（样式）配套。

   为什么切页不会断：
     · 播放器节点在 #content 之外，pjax（js/pjax.js）换页只替换 #content，
       这个 <audio> 从头到尾没被销毁，解码也就没有中断；
     · 万一走了整页刷新（没开 pjax、或 pjax 失败退化成跳转），
       这里还会把「第几首 + 播到几秒 + 是否在播」写进 sessionStorage，
       新页面加载后原地恢复；被自动播放策略拦下时，等用户第一次交互再续上。

   状态只存在 sessionStorage / localStorage，不往服务端发任何东西。
   ========================================================== */
(function () {
	'use strict';

	var root = document.getElementById('player');
	var dataEl = document.getElementById('player-data');
	if (!root || !dataEl) return;

	var songs = [];
	var holidayRanges = [];
	var holidaySongs = {};
	try {
		var raw = JSON.parse(dataEl.textContent);
		if (Array.isArray(raw)) {
			songs = raw; /* 兼容旧结构：整份数据就是一个歌曲数组 */
		} else if (raw) {
			songs = raw.songs || [];
			holidayRanges = raw.holidayRanges || [];
			holidaySongs = raw.holidaySongs || {};
		}
	} catch (e) {}

	var audio = document.getElementById('player-audio');
	var toggle = document.getElementById('player-toggle');
	var closeBtn = document.getElementById('player-close');
	var nameEl = document.getElementById('player-name');
	var artistEl = document.getElementById('player-artist');
	var bar = document.getElementById('player-bar');
	var fill = document.getElementById('player-fill');
	var curEl = document.getElementById('player-cur');
	var durEl = document.getElementById('player-dur');
	var playBtn = document.getElementById('player-play');
	var prevBtn = document.getElementById('player-prev');
	var nextBtn = document.getElementById('player-next');
	var modeBtn = document.getElementById('player-mode');
	var listBtn = document.getElementById('player-list-btn');
	var listEl = document.getElementById('player-list');
	var muteBtn = document.getElementById('player-mute');
	var volBar = document.getElementById('player-vol-bar');
	var volFill = document.getElementById('player-vol-fill');
	var volNum = document.getElementById('player-vol-num');

	if (!audio || !playBtn) return;

	var KEY = 'restart-player';            /* 播放状态（会话级） */
	var MODE_KEY = 'restart-player-mode';  /* 播放模式（长期） */
	var VOL_KEY = 'restart-player-volume'; /* 音量（长期） */
	var MODES = ['list', 'single', 'shuffle'];
	var MODE_ICON = { list: 'fa-repeat', single: 'fa-repeat', shuffle: 'fa-random' };
	var MODE_LABEL = { list: '列表循环', single: '单曲循环', shuffle: '随机播放' };

	var i = 0;
	var mode = 'list';
	var pendingSeek = 0;
	var lastSave = 0;
	var lastVol = 0.7;
	/* 正在定位/正在拖动的目标秒数。不为 null 时界面只认它，
	   免得 timeupdate 拿着「还没跳过去的旧位置」把进度条拽回去。 */
	var seekTarget = null;
	var seekTimer = 0;
	/* 初始化完成前不落盘：load() 会把 currentTime 归零，
	   这时候写 sessionStorage 会把上次的进度覆盖掉。 */
	var ready = false;
	/* 用户是否已经动过播放器（自己按过播放/暂停/切歌）。
	   用于决定节日主题曲能不能顶掉当前这首：动过就不动。 */
	var userActive = false;

	/* ---------- 小工具 ---------- */
	function pad2(n) {
		return (n < 10 ? '0' : '') + n;
	}

	function todayKey() {
		var d = new Date();
		return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
	}

	function indexOfUrl(u) {
		for (var n = 0; n < songs.length; n++) {
			if (songs[n].url === u) return n;
		}
		return -1;
	}

	/* ---------- 节日主题曲 ----------
	   今天落在某个节假日区间里、且该节日配了主题曲，就把这首歌顶到列表第一位。
	   区间和歌单都由服务端输出（_partial/player.ejs），这里只比日期字符串：
	   区间两端都是补零的 YYYY-MM-DD，字典序比较就等于时间先后。 */
	function findThemeSong() {
		if (!holidayRanges.length) return null;
		var k = todayKey();
		for (var n = 0; n < holidayRanges.length; n++) {
			var r = holidayRanges[n];
			if (!r || !r.start || k < r.start || k > r.end) continue;
			var s = holidaySongs[r.name];
			if (s && s.url) {
				return {
					name: s.name || r.name + '主题曲',
					artist: s.artist || '',
					url: s.url,
					holiday: r.name
				};
			}
			/* 这个节日没配主题曲：继续看后面还有没有命中的区间 */
		}
		return null;
	}

	var themeSong = findThemeSong();

	if (themeSong) {
		var at = indexOfUrl(themeSong.url);
		if (at < 0) {
			songs.unshift(themeSong); /* 不在常规歌单里就直接插到最前 */
		} else if (at > 0) {
			songs.unshift(songs.splice(at, 1)[0]);
		}
	}

	/* 常规歌单为空、今天又没有主题曲时，这个播放器没有内容可放，直接撤掉 */
	if (!songs.length) {
		if (root.parentNode) root.parentNode.removeChild(root);
		return;
	}

	/* ---------- 节日主题曲的运行期接入 ----------
	   首页日历那边可能从接口拿到「今天是某个节日」（内置表还没覆盖的年份），
	   它会通过 window.__restartHolidaySong 把对应的主题曲交过来。
	   首屏时本脚本还没执行，日历会先把数据推进 __restartHolidaySongQueue，
	   初始化完再取队列里最后一条应用。 */
	function markTheme(song) {
		root.classList.add('has-theme');
		var capEl = document.getElementById('player-cap');
		if (capEl) capEl.textContent = (song.holiday || '节日') + ' · 主题曲';
	}

	function applyHolidaySong(song) {
		if (!song || !song.url) return;

		var at = indexOfUrl(song.url);

		if (at === 0) {
			/* 已经在第一位：补个标记就行，列表和当前曲目都不用动 */
			markTheme(song);
			if (ready) renderList();
			return;
		}

		/* 记住当前这首「歌」本身 —— 下面列表要整体挪位，下标会失效 */
		var playing = songs[i];

		if (at < 0) {
			songs.unshift(song);
		} else {
			songs.unshift(songs.splice(at, 1)[0]);
		}

		/* 挪位后按地址把当前曲目重新定位，否则 i 会指到别的歌上，
		   连 save() 都会把错误的地址写进会话状态 */
		var back = indexOfUrl((playing || song).url);
		i = back < 0 ? 0 : back;

		markTheme(song);

		if (!ready) return; /* 初始化途中：当前曲目由 init 统一决定 */

		renderList();

		/* 只调顺序，不打断播放：正在放、或用户已经动过播放器就到此为止；
		   仍处于暂停且当前不是第一首时，才把它切成默认曲目。 */
		if (!userActive && audio.paused && i !== 0) load(0, false);
	}

	window.__restartHolidaySong = applyHolidaySong;

	function fmt(t) {
		if (!isFinite(t) || t < 0) t = 0;
		var m = Math.floor(t / 60);
		var s = Math.floor(t % 60);
		return m + ':' + (s < 10 ? '0' : '') + s;
	}

	function icon(btn, cls) {
		btn.innerHTML = '<i class="fa ' + cls + '" aria-hidden="true"></i>';
	}

	function save() {
		if (!ready) return;
		try {
			sessionStorage.setItem(KEY, JSON.stringify({
				/* 存地址而不是下标：节日主题曲会改变列表顺序，
				   只记下标的话刷新后会指到别的歌上。i 留着兼容旧数据。 */
				u: (songs[i] && songs[i].url) || '',
				i: i,
				t: audio.currentTime || 0,
				p: !audio.paused && !audio.ended,
				m: mode
			}));
		} catch (e) {}
	}

	/* ---------- 拖动绑定（进度条 / 音量条共用） ----------
	   pointerdown 之后把 pointermove / pointerup 挂到 document 上，而不是只挂
	   在自己身上：这两条线只有 12~14px 高，指针稍微一歪就离开元素，
	   只监听自身会当场断掉（setPointerCapture 在部分浏览器/触摸场景下还会
	   直接失效）。拖动过程只预览界面，松手才提交，避免边拖边 seek 造成抖动。 */
	function bindDrag(el, currentRatio, onPreview, onCommit, onCancel) {
		var dragging = false;

		function ratioAt(clientX) {
			/* 拿不到坐标（合成事件、某些辅助设备）就退回当前值，
			   不能让它变成 NaN 写进 style.width */
			if (typeof clientX !== 'number' || isNaN(clientX)) return currentRatio();
			var rect = el.getBoundingClientRect();
			if (!rect.width) return 0;
			return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		}

		function move(e) {
			if (!dragging) return;
			onPreview(ratioAt(e.clientX));
			if (e.cancelable) e.preventDefault();
		}

		function stop() {
			dragging = false;
			el.classList.remove('dragging');
			document.removeEventListener('pointermove', move);
			document.removeEventListener('pointerup', up);
			document.removeEventListener('pointercancel', cancel);
		}

		function up(e) {
			if (!dragging) return;
			var r = ratioAt(e.clientX);
			stop();
			onCommit(r);
		}

		function cancel() {
			if (!dragging) return;
			stop();
			if (onCancel) onCancel();
		}

		el.addEventListener('pointerdown', function (e) {
			if (e.button) return; /* 只响应左键与触摸 */
			dragging = true;
			el.classList.add('dragging');
			document.addEventListener('pointermove', move);
			document.addEventListener('pointerup', up);
			document.addEventListener('pointercancel', cancel);
			try {
				if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
			} catch (err) {}
			onPreview(ratioAt(e.clientX));
			e.preventDefault();
		});

		/* 键盘：左右键 5% 步进，直接提交 */
		el.addEventListener('keydown', function (e) {
			var step = e.key === 'ArrowRight' ? 0.05 : (e.key === 'ArrowLeft' ? -0.05 : 0);
			if (!step) return;
			e.preventDefault();
			var r = Math.min(1, Math.max(0, currentRatio() + step));
			onPreview(r);
			onCommit(r);
		});
	}

	/* ---------- 进度 ---------- */
	function paint(t) {
		var d = audio.duration;
		var pct = (isFinite(d) && d > 0) ? (t / d) * 100 : 0;
		fill.style.width = pct + '%';
		bar.setAttribute('aria-valuenow', String(Math.round(pct)));
		curEl.textContent = fmt(t);
		if (isFinite(d)) durEl.textContent = fmt(d);
	}

	function setProgress() {
		paint(seekTarget !== null ? seekTarget : audio.currentTime);
	}

	function seekTo(t) {
		var d = audio.duration;
		if (!isFinite(d) || d <= 0) {
			seekTarget = null;
			setProgress();
			return;
		}
		seekTarget = Math.min(d, Math.max(0, t));
		try { audio.currentTime = seekTarget; } catch (e) {}
		/* 有的源不支持随机定位（服务端没开 Range 请求），seeked 永远不来。
		   1.2 秒后按播放器的真实位置回显，用户能看到这次拖动没生效，
		   而不是进度条一直停在手指松开的地方。 */
		clearTimeout(seekTimer);
		seekTimer = setTimeout(function () {
			seekTarget = null;
			setProgress();
		}, 1200);
		setProgress();
	}

	bindDrag(bar,
		function () {
			var d = audio.duration;
			if (seekTarget !== null && isFinite(d) && d > 0) return seekTarget / d;
			return (isFinite(d) && d > 0) ? audio.currentTime / d : 0;
		},
		function (r) {
			var d = audio.duration;
			if (!isFinite(d) || d <= 0) return;
			seekTarget = r * d;
			clearTimeout(seekTimer); /* 还在拖，别判超时 */
			paint(seekTarget);
		},
		function (r) {
			seekTo(r * (audio.duration || 0));
		},
		function () {
			/* 手势被系统打断：回到真实位置 */
			seekTarget = null;
			setProgress();
		}
	);

	/* ---------- 音量 ---------- */
	function renderVolume() {
		var r = audio.muted ? 0 : audio.volume;
		volFill.style.width = (r * 100) + '%';
		volBar.setAttribute('aria-valuenow', String(Math.round(r * 100)));
		if (volNum) volNum.textContent = Math.round(r * 100);
		if (muteBtn) {
			icon(muteBtn, r === 0 ? 'fa-volume-off' : (r < 0.5 ? 'fa-volume-down' : 'fa-volume-up'));
			muteBtn.setAttribute('aria-label', r === 0 ? '取消静音' : '静音');
		}
	}

	function setVolume(r, persist) {
		r = Math.min(1, Math.max(0, r));
		audio.muted = false;
		audio.volume = r;
		if (r > 0) lastVol = r;
		renderVolume();
		if (persist) {
			try { localStorage.setItem(VOL_KEY, String(r)); } catch (e) {}
		}
	}

	if (volBar && volFill) {
		bindDrag(volBar,
			function () { return audio.muted ? 0 : audio.volume; },
			function (r) {
				audio.muted = false;
				audio.volume = Math.min(1, Math.max(0, r));
				if (r > 0) lastVol = r;
				renderVolume();
			},
			function (r) { setVolume(r, true); },
			function () { renderVolume(); }
		);
	}

	if (muteBtn) {
		muteBtn.addEventListener('click', function () {
			if (audio.muted || audio.volume === 0) {
				setVolume(lastVol || 0.7, true);
				return;
			}
			lastVol = audio.volume;
			audio.muted = true;
			renderVolume();
		});
	}

	/* ---------- 图标 / 列表 / 媒体会话 ---------- */
	function setIcon() {
		var playing = !audio.paused;
		icon(playBtn, playing ? 'fa-pause' : 'fa-play');
		playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
		root.classList.toggle('playing', playing);
	}

	function renderList() {
		if (!listEl) return;
		listEl.innerHTML = '';
		songs.forEach(function (s, idx) {
			var li = document.createElement('li');
			if (idx === i) li.className = 'active';

			var n = document.createElement('span');
			n.className = 'player-idx';
			n.textContent = (idx + 1 < 10 ? '0' : '') + (idx + 1);

			var t = document.createElement('span');
			t.className = 'player-li-name';
			t.textContent = s.name || s.url;

			li.appendChild(n);
			li.appendChild(t);
			li.addEventListener('click', function () { load(idx, true); });
			listEl.appendChild(li);
		});
	}

	function updateMediaSession() {
		if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
		try {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: songs[i].name || '',
				artist: songs[i].artist || '',
				album: document.title
			});
		} catch (e) {}
	}

	function setMode(m) {
		mode = MODES.indexOf(m) === -1 ? 'list' : m;
		icon(modeBtn, MODE_ICON[mode]);
		modeBtn.classList.toggle('on', mode !== 'list');
		modeBtn.setAttribute('aria-label', '播放模式：' + MODE_LABEL[mode]);
		modeBtn.setAttribute('title', '播放模式：' + MODE_LABEL[mode] + '（点击切换）');
		try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
	}

	/* ---------- 播放控制 ---------- */
	function load(n, autoplay) {
		i = ((n % songs.length) + songs.length) % songs.length;
		var s = songs[i];
		seekTarget = null;
		clearTimeout(seekTimer);
		audio.src = s.url;
		nameEl.textContent = s.name || '未命名';
		artistEl.textContent = s.artist || '';
		renderList();
		updateMediaSession();
		if (autoplay) play();
		save();
	}

	function play() {
		userActive = true;
		var p;
		/* 老浏览器和一些异常状态下 play() 会同步抛错，不能让它把整个脚本带崩 */
		try {
			p = audio.play();
		} catch (e) {
			setIcon();
			return;
		}
		if (p && p.catch) p.catch(function () { setIcon(); });
	}

	function pause() {
		audio.pause();
	}

	function next() {
		if (mode === 'shuffle' && songs.length > 1) {
			var n = i;
			while (n === i) n = Math.floor(Math.random() * songs.length);
			load(n, true);
			return;
		}
		load(i + 1, true);
	}

	function prev() {
		/* 播过 3 秒之后按上一首，先回到本首开头 —— 和常见播放器一致 */
		if (audio.currentTime > 3) {
			seekTarget = null;
			audio.currentTime = 0;
			setProgress();
			return;
		}
		load(i - 1, true);
	}

	function setOpen(open) {
		root.classList.toggle('open', open);
		toggle.setAttribute('aria-expanded', String(open));
		if (open) renderList();
	}

	/* ---------- 事件 ---------- */
	toggle.addEventListener('click', function () {
		setOpen(!root.classList.contains('open'));
	});

	if (closeBtn) {
		closeBtn.addEventListener('click', function () { setOpen(false); });
	}

	playBtn.addEventListener('click', function () {
		if (audio.paused) play();
		else pause();
	});

	prevBtn.addEventListener('click', prev);
	nextBtn.addEventListener('click', next);

	modeBtn.addEventListener('click', function () {
		setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
		save();
	});

	if (listBtn && listEl) {
		listBtn.addEventListener('click', function () {
			var show = listEl.hidden;
			listEl.hidden = !show;
			listBtn.setAttribute('aria-expanded', String(show));
			listBtn.classList.toggle('on', show);
			if (show) renderList();
		});
	}

	audio.addEventListener('timeupdate', function () {
		/* 拖动或等待定位落地时不覆盖界面 */
		if (seekTarget === null) setProgress();
		/* timeupdate 一秒能来好几次，5 秒落一次盘就够了 */
		var now = Date.now();
		if (now - lastSave > 5000) {
			lastSave = now;
			save();
		}
	});

	audio.addEventListener('seeked', function () {
		if (seekTarget !== null) {
			seekTarget = null;
			clearTimeout(seekTimer);
		}
		setProgress();
	});

	audio.addEventListener('loadedmetadata', function () {
		if (pendingSeek > 0) {
			try { audio.currentTime = pendingSeek; } catch (e) {}
			pendingSeek = 0;
		}
		setProgress();
	});

	audio.addEventListener('play', setIcon);
	audio.addEventListener('pause', function () { setIcon(); save(); });
	audio.addEventListener('ended', function () {
		if (mode === 'single') {
			audio.currentTime = 0;
			play();
			return;
		}
		next();
	});
	audio.addEventListener('error', function () {
		artistEl.textContent = '加载失败，检查 music.songs 里的 url';
	});

	/* 整页刷新前的最后一次落盘（visibilitychange 覆盖移动端切后台） */
	window.addEventListener('pagehide', save);
	document.addEventListener('visibilitychange', function () {
		if (document.visibilityState === 'hidden') save();
	});

	/* 系统媒体控制（锁屏 / 耳机按键） */
	if ('mediaSession' in navigator) {
		try {
			navigator.mediaSession.setActionHandler('play', play);
			navigator.mediaSession.setActionHandler('pause', pause);
			navigator.mediaSession.setActionHandler('previoustrack', prev);
			navigator.mediaSession.setActionHandler('nexttrack', next);
		} catch (e) {}
	}

	/* ---------- 初始化 ---------- */
	var volume = parseFloat(root.getAttribute('data-volume'));
	if (isNaN(volume)) volume = 0.7;

	var savedVol = NaN;
	try { savedVol = parseFloat(localStorage.getItem(VOL_KEY)); } catch (e) {}
	setVolume(isNaN(savedVol) ? volume : savedVol, false);

	var saved = null;
	try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}

	var savedMode = null;
	try { savedMode = localStorage.getItem(MODE_KEY); } catch (e) {}

	setMode(savedMode || root.getAttribute('data-mode') || 'list');

	var start = 0;
	var resume = false;

	if (saved) {
		/* 上一次播放的位置优先于配置：整页刷新（pjax 之外的路径）也接着放。
		   先按地址找，找不到再退回旧版本存的下标。 */
		if (saved.m) setMode(saved.m);
		var back = saved.u ? indexOfUrl(saved.u) : -1;
		if (back < 0 && typeof saved.i === 'number' && songs[saved.i]) back = saved.i;
		start = back < 0 ? 0 : back;
		pendingSeek = saved.t || 0;
		resume = saved.p === true;
	} else {
		resume = root.getAttribute('data-autoplay') === '1';
	}

	/* 节日主题曲已经顶到第一位（见上面的 findThemeSong）：
	   正在播的话不动当前曲目，只让它在列表里排第一；
	   没在播就把它作为默认曲目 —— 访客一进来看到的就是今天的主题曲。 */
	if (themeSong && !resume) start = 0;

	load(start, false);

	if (themeSong) markTheme(themeSong);

	if (audio.readyState >= 1 && pendingSeek > 0) {
		try { audio.currentTime = pendingSeek; } catch (e) {}
		pendingSeek = 0;
	}

	setIcon();
	setProgress();
	renderVolume();
	renderList();
	ready = true;

	if (resume) {
		var p = audio.play();
		if (p && p.catch) {
			/* 自动播放被策略拦下是常态：位置已经恢复好了，
			   等用户第一次交互（点击/按键）再自己续上，不用他去找播放键。 */
			p.catch(function () {
				setIcon();
				var once = function () {
					document.removeEventListener('pointerdown', once);
					document.removeEventListener('keydown', once);
					if (audio.paused) play();
				};
				document.addEventListener('pointerdown', once);
				document.addEventListener('keydown', once);
			});
		}
	}

	/* 最后再处理日历先交过来的节日主题曲（那时本脚本还没执行）。
	   放在 resume 之后：此刻才分得清「正在播」和「暂停着」，不会把播放中的歌换掉。 */
	var earlyTheme = window.__restartHolidaySongQueue;
	window.__restartHolidaySongQueue = { push: applyHolidaySong };
	if (earlyTheme && earlyTheme.length) applyHolidaySong(earlyTheme[earlyTheme.length - 1]);
})();
