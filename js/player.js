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
	var foldBtn = document.getElementById('player-fold');
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
	var bufferEl = document.getElementById('player-buffer');

	if (!audio || !playBtn) return;

	var KEY = 'restart-player';            /* 播放状态（会话级） */
	var MODE_KEY = 'restart-player-mode';  /* 播放模式（长期） */
	var VOL_KEY = 'restart-player-volume'; /* 音量（长期） */
	var MODES = ['list', 'single', 'shuffle'];
	var MODE_LABEL = { list: '列表循环', single: '单曲循环', shuffle: '随机播放' };

	/* 是否把整首抓成内存对象再播。默认开。
	   背景：hexo server 与 CF Pages 实测都不支持 HTTP Range（Range 请求照样返回
	   200 + 整个文件），浏览器 seek 到未缓冲位置时只能重载整个资源，
	   currentTime 会被重置为 0 —— 表现就是「拖完进度条从头播放」。
	   Blob 是内存对象，可任意随机访问，seek 与服务器能力无关。 */
	var wantBlob = root.getAttribute('data-blob') !== '0' &&
		typeof window.fetch === 'function' &&
		!!(window.URL && window.URL.createObjectURL);

	var i = 0;
	var mode = 'list';
	var pendingSeek = 0;
	var lastSave = 0;
	var lastVol = 0.7;
	/* 正在定位/正在拖动的目标秒数。不为 null 时界面只认它，
	   免得 timeupdate 拿着「还没跳过去的旧位置」把进度条拽回去。 */
	var seekTarget = null;
	var seekTimer = 0;
	/* 界面锁定的进度比例：拖动中、以及松手后等 seek 落地的这段时间非空。
	   非空时进度条只认它，任何播放事件（timeupdate / seeked）都不许回写。 */
	var uiRatio = null;
	/* 时长还没就绪时用户已经拖过进度条：把想跳到的比例记下来，
	   durationchange / loadedmetadata 到了再落地。 */
	var pendingRatio = null;
	/* 初始化完成前不落盘：load() 会把 currentTime 归零，
	   这时候写 sessionStorage 会把上次的进度覆盖掉。 */
	var ready = false;
	/* 用户是否已经动过播放器（自己按过播放/暂停/切歌）。
	   用于决定节日主题曲能不能顶掉当前这首：动过就不动。 */
	var userActive = false;

	/* ---------- Blob 播放状态 ---------- */
	var blobCache = {};   /* 原地址 -> blob: 地址 */
	var blobPending = {}; /* 原地址 -> 抓取中的 Promise（去重） */
	var blobFailed = {};  /* 抓取失败过的地址，不再重试 */
	var blobOrder = [];   /* 缓存顺序，用于淘汰 */
	var BLOB_MAX = 3;     /* 最多缓存几首，避免长歌单吃内存 */
	var swapping = false; /* 正在换源：期间忽略换源引发的事件与落盘 */
	var swapUnlock = false; /* 换源是为了完成一次拖动：位置补回后要解锁进度条 */

	/* ---------- 等待缓冲（抓不到 blob 时的降级路径） ---------- */
	var waitBuffer = null; /* 等缓冲时记下目标秒数 */
	var bufferTimer = 0;
	var bufferGiveUp = 0;

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
		/* 作者位置改写成「节日 · 主题曲」：头部栏只有这一处放得下小字，
		   换歌时 load() 会把 artistEl 恢复成真正的作者。 */
		if (artistEl) artistEl.textContent = (song.holiday || '节日') + ' · 主题曲';
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
		   仍处于暂停且当前不是第一首时，才把它切成默认曲目。
		   拖动进度条途中（uiRatio 已锁）也绝不切歌 —— 那会把 currentTime 归零。 */
		if (!userActive && audio.paused && i !== 0 && uiRatio === null) load(0, false);
	}

	window.__restartHolidaySong = applyHolidaySong;

	function fmt(t) {
		if (!isFinite(t) || t < 0) t = 0;
		var m = Math.floor(t / 60);
		var s = Math.floor(t % 60);
		return m + ':' + (s < 10 ? '0' : '') + s;
	}

	function save() {
		if (!ready || swapping) return;
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

	/* ---------- Blob 播放 ----------
	   把整首抓成内存对象（blob:）再播，seek 就与服务器的 Range 能力无关了。
	   策略是「先流式起播，后台抓整首，抓到再平滑换源」：
	     · 点播放立刻出声，不用等下载完；
	     · 抓到之后静默换成 blob 源，位置/播放状态原样保留；
	     · 换源之前用户就拖了进度条 → 走下面的「等待缓冲」，不会重置到 0。 */

	function blobReady(url) {
		return !!blobCache[url];
	}

	function isBlobSource() {
		return audio.src.indexOf('blob:') === 0;
	}

	function rememberBlob(url, blobUrl) {
		blobCache[url] = blobUrl;
		if (blobOrder.indexOf(url) < 0) blobOrder.push(url);

		/* 缓存上限：超出时淘汰最早的一首，正在播的和刚抓到的都不动 */
		while (blobOrder.length > BLOB_MAX) {
			var old = blobOrder[0];
			if (old === url || (songs[i] && songs[i].url === old)) break;
			blobOrder.shift();
			if (blobCache[old]) {
				try { window.URL.revokeObjectURL(blobCache[old]); } catch (e) {}
				delete blobCache[old];
			}
		}
	}

	function prefetchBlob(url) {
		if (!wantBlob || blobCache[url] || blobPending[url] || blobFailed[url]) return;

		blobPending[url] = fetch(url, { credentials: 'same-origin' })
			.then(function (res) {
				if (!res.ok) throw new Error('HTTP ' + res.status);
				return res.blob();
			})
			.then(function (blob) {
				delete blobPending[url];
				if (!blob || !blob.size) throw new Error('empty blob');
				var u = window.URL.createObjectURL(blob);
				rememberBlob(url, u);
				/* 抓完时用户可能已经切歌：只有当它还是当前这首才换源 */
				if (songs[i] && songs[i].url === url) swapToBlob(url);
				return u;
			})
			.catch(function () {
				delete blobPending[url];
				/* 抓不到（外链没开 CORS、离线等）就留在原地址，
				   seek 退化成「等到缓冲够了再跳」 */
				blobFailed[url] = true;
			});
	}

	/* 把当前这首歌的播放源换成 blob，位置与播放状态原样保留。
	   换源会让 currentTime 归零，所以借 pendingSeek 让 loadedmetadata
	   处理器把位置补回来 —— blob 一定能定位，这次 seek 必然成功。 */
	function swapToBlob(url) {
		var u = blobCache[url];
		if (!u || !songs[i] || songs[i].url !== url) return;
		if (isBlobSource()) return;
		if (uiRatio !== null) return; /* 用户正拖着：拖完再换（unlockProgress 会补一次） */

		var at = audio.currentTime;
		var wasPlaying = !audio.paused;

		swapping = true;
		if (at > 0.5) pendingSeek = at;
		try {
			audio.src = u;
		} catch (e) {
			swapping = false;
			return;
		}
		if (wasPlaying) play();
		swapping = false;
	}

	/* 拖完之后补一次换源：抓好了但当时正在拖的情况 */
	function scheduleBlobSwap() {
		var s = songs[i];
		if (!s || !blobReady(s.url) || isBlobSource()) return;
		setTimeout(function () { swapToBlob(s.url); }, 300);
	}

	/* 当前播放位置往前「连续可播」到第几秒。
	   没有它就没法判断 seek 目标是不是已经缓冲过 —— 未缓冲时贸然 seek
	   会让浏览器重载整个资源（服务端不支持 Range），位置被清零。 */
	function bufferedAhead() {
		var b = audio.buffered;
		if (!b || !b.length) return 0;
		var t = audio.currentTime;
		var best = 0;
		for (var n = 0; n < b.length; n++) {
			if (b.end(n) <= t + 0.2) continue;
			if (b.start(n) <= t + 0.2) return b.end(n); /* 当前位置所在区间 */
			if (!best || b.end(n) < best) best = b.end(n); /* 取最靠前的一段 */
		}
		return best;
	}

	function setBufferTip(on) {
		if (!bufferEl) return;
		bufferEl.hidden = !on;
		root.classList.toggle('buffering', !!on);
	}

	/* 目标位置还没缓冲：挂起等缓冲推进，够了再跳。
	   最多等 20 秒，超时就放弃这次拖动、回显真实位置。 */
	function waitForBuffer(t) {
		waitBuffer = t;
		setBufferTip(true);

		if (!bufferTimer) {
			bufferTimer = setInterval(function () {
				if (waitBuffer === null) return;
				/* 期间 blob 抓好了：直接换源，位置交给 pendingSeek */
				if (blobReady(songs[i] && songs[i].url) || isBlobSource()) {
					var want = waitBuffer;
					waitBuffer = null;
					stopBufferWait();
					issueSeek(want);
					return;
				}
				if (waitBuffer <= bufferedAhead() + 1) {
					var w = waitBuffer;
					waitBuffer = null;
					stopBufferWait();
					issueSeek(w);
				}
			}, 300);
		}

		clearTimeout(bufferGiveUp);
		bufferGiveUp = setTimeout(function () {
			if (waitBuffer === null) return;
			waitBuffer = null;
			stopBufferWait();
			unlockProgress(); /* 等不到了：回显真实位置，不再锁着 */
		}, 20000);
	}

	function stopBufferWait() {
		if (bufferTimer) {
			clearInterval(bufferTimer);
			bufferTimer = 0;
		}
		clearTimeout(bufferGiveUp);
		setBufferTip(false);
	}

	/* ---------- 拖动绑定（进度条 / 音量条共用） ----------
	   pointerdown 之后把 pointermove / pointerup 挂到 document 上，而不是只挂
	   在自己身上：这两条线只有十几像素高，指针稍微一歪就离开元素，
	   只监听自身会当场断掉（setPointerCapture 在部分浏览器/触摸场景下还会
	   直接失效）。拖动过程只预览界面，松手才提交，避免边拖边 seek 造成抖动。
	   指针事件一秒能来上百次，这里合并到一帧一次：既少重排，
	   也避免预览因为掉帧而看起来「跟不上手」。 */
	function bindDrag(el, currentRatio, onPreview, onCommit, onCancel) {
		var dragging = false;
		var raf = 0;
		var lastX = 0;

		function ratioAt(clientX) {
			/* 拿不到坐标（合成事件、某些辅助设备）就退回当前值，
			   不能让它变成 NaN 写进 style.width */
			if (typeof clientX !== 'number' || isNaN(clientX)) return currentRatio();
			var rect = el.getBoundingClientRect();
			if (!rect.width) return 0;
			return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		}

		function flush() {
			raf = 0;
			if (!dragging) return;
			onPreview(ratioAt(lastX));
		}

		function move(e) {
			if (!dragging) return;
			lastX = e.clientX;
			if (!raf) raf = window.requestAnimationFrame(flush);
			if (e.cancelable) e.preventDefault();
		}

		function stop() {
			dragging = false;
			if (raf) {
				window.cancelAnimationFrame(raf);
				raf = 0;
			}
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
			lastX = e.clientX;
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

	/* 能用来定位的时长。
	   audio.duration 并不可靠：服务端没给 Content-Length、MP3 缺 Xing 头时
	   它会一直是 Infinity，元数据没到时又是 NaN。这时退到 seekable 区间末端；
	   两个都拿不到才返回 0（此时确实无法定位）。 */
	function seekLength() {
		var d = audio.duration;
		if (isFinite(d) && d > 0) return d;
		try {
			var sk = audio.seekable;
			if (sk && sk.length) {
				var end = sk.end(sk.length - 1);
				if (isFinite(end) && end > 0) return end;
			}
		} catch (e) {}
		return 0;
	}

	/* 时长未知时也能让进度条跟手：只动界面，不定位置 */
	function paintRatio(r) {
		var pct = Math.min(100, Math.max(0, r * 100));
		fill.style.width = pct + '%';
		bar.setAttribute('aria-valuenow', String(Math.round(pct)));
		var d = seekLength();
		curEl.textContent = fmt(d ? r * d : audio.currentTime);
	}

	function paint(t) {
		var d = seekLength();
		var pct = d > 0 ? (t / d) * 100 : 0;
		fill.style.width = pct + '%';
		bar.setAttribute('aria-valuenow', String(Math.round(pct)));
		curEl.textContent = fmt(t);
		if (d > 0) durEl.textContent = fmt(d);
	}

	/* 画进度的唯一入口。
	   uiRatio 非空时界面就锁在这个比例上 —— 拖动中、以及松手后等 seek 落地
	   的这段时间，播放推进（timeupdate）一律不许回写，
	   否则就会出现「拖着拖着被播放位置拽回去」。 */
	function renderProgress() {
		if (uiRatio !== null) {
			paintRatio(uiRatio);
			return;
		}
		paint(audio.currentTime);
	}

	function setProgress() {
		renderProgress();
	}

	/* 解锁的唯一出口：确认 seek 落地、或放弃这次定位时调用，
	   把界面交还给真实的播放位置。 */
	function unlockProgress() {
		uiRatio = null;
		seekTarget = null;
		pendingRatio = null;
		clearTimeout(seekTimer);
		renderProgress();
		/* 拖完了：如果这首歌的 blob 已经抓好但还没换上，现在补上，
		   之后就不用再走「等缓冲」这条路了。 */
		scheduleBlobSwap();
	}

	/* 真正发出一次 seek。seekTarget 记下目标秒数，供 seeked / 超时校验。 */
	function issueSeek(t) {
		var d = seekLength();
		if (!d) return;
		t = Math.min(d, Math.max(0, t));

		var url = songs[i] && songs[i].url;

		/* 已经抓好 blob、但还是原地址在播：先把源换成 blob。
		   换源会把位置归零，用 pendingSeek 承接，换完再解锁界面 ——
		   这一步必须在「等缓冲」之前做，否则两边会来回弹。 */
		if (!isBlobSource() && url && blobReady(url)) {
			stopBufferWait();
			seekTarget = null;
			uiRatio = d > 0 ? t / d : uiRatio;
			pendingSeek = t;
			swapUnlock = true;
			try {
				audio.src = blobCache[url];
			} catch (e) {
				swapUnlock = false;
			}
			return;
		}

		/* 还没换成 blob 源时，如果目标位置没缓冲过，直接 seek 会让浏览器
		   重载整个资源、把位置清零（服务端不支持 Range）。
		   那就先挂起等缓冲推进到目标附近，再跳。 */
		if (!isBlobSource() && t > bufferedAhead() + 1) {
			seekTarget = null;
			waitForBuffer(t);
			return;
		}

		stopBufferWait();
		seekTarget = t;
		try { audio.currentTime = t; } catch (e) {}

		/* 等 seeked 来确认。超时了先重试一次，再不行就解锁回显真实位置 ——
		   至少让用户看到这次拖动到底有没有被浏览器接受，而不是一直锁死。 */
		clearTimeout(seekTimer);
		seekTimer = setTimeout(function () {
			if (seekTarget === null) {
				unlockProgress();
				return;
			}
			try { audio.currentTime = seekTarget; } catch (e) {}
			seekTimer = setTimeout(unlockProgress, 700);
		}, 1500);

		renderProgress();
	}

	/* 用户松手 / 键盘步进的目标比例：先把 UI 锁住，再按情况落地。 */
	function applySeekRatio(r) {
		uiRatio = r;
		var d = seekLength();
		if (!d) {
			/* 时长还没就绪：记下目标，loadedmetadata / durationchange 到了再 seek */
			pendingRatio = r;
			seekTarget = null;
			renderProgress();
			return;
		}
		pendingRatio = null;
		issueSeek(r * d);
	}

	bindDrag(bar,
		function () {
			if (uiRatio !== null) return uiRatio;
			var d = seekLength();
			return d > 0 ? audio.currentTime / d : 0;
		},
		function (r) {
			/* 拖动中只预览：把 UI 锁到手指位置，不真正 seek（否则每帧都 seek 会抖） */
			if (audio.preload !== 'auto') audio.preload = 'auto';
			clearTimeout(seekTimer); /* 作废上一次的超时判定 */
			uiRatio = r;
			renderProgress();
		},
		function (r) {
			applySeekRatio(r);
		},
		function () {
			/* 手势被系统打断：回到真实位置 */
			unlockProgress();
		}
	);

	/* ---------- 音量 ---------- */
	function renderVolume() {
		var r = audio.muted ? 0 : audio.volume;
		volFill.style.width = (r * 100) + '%';
		volBar.setAttribute('aria-valuenow', String(Math.round(r * 100)));
		if (volNum) volNum.textContent = Math.round(r * 100);
		/* 图标档位交给 .player[data-vol]，同样不在这里画 */
		root.setAttribute('data-vol', r === 0 ? 'off' : (r < 0.5 ? 'down' : 'up'));
		if (muteBtn) {
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
	/* 图标不在这里画：HTML 里各状态的 SVG 都放着，CSS 按 .playing /
	   data-mode / data-vol 决定显示哪一个，这里只负责改状态。 */
	function setIcon() {
		var playing = !audio.paused;
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
		/* 图标由 .player[data-mode] 决定，这里只改属性 */
		root.setAttribute('data-mode', mode);
		modeBtn.classList.toggle('on', mode !== 'list');
		modeBtn.setAttribute('aria-label', '播放模式：' + MODE_LABEL[mode]);
		modeBtn.setAttribute('title', '播放模式：' + MODE_LABEL[mode] + '（点击切换）');
		try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
	}

	/* ---------- 播放控制 ---------- */

	/* 决定这一首用哪个地址播：
	   · 已经抓成 blob 的 → 直接用 blob（seek 随便拖，与服务器无关）；
	   · 否则先用原地址流式起播，同时在后台抓整首，抓到再平滑换源；
	   · 关掉 blob 或抓取失败 → 留在原地址，seek 走「等缓冲」这条路。 */
	function useSource(url, autoplay) {
		if (blobReady(url)) {
			audio.src = blobCache[url];
		} else {
			audio.src = url;
			prefetchBlob(url);
		}
		if (autoplay) play();
	}

	function load(n, autoplay) {
		i = ((n % songs.length) + songs.length) % songs.length;
		var s = songs[i];
		/* 换歌要把跟进度有关的状态全部清干净：留着旧的锁定比例，
		   新歌的进度条会停在上一次的拖动位置上。 */
		seekTarget = null;
		uiRatio = null;
		pendingRatio = null;
		waitBuffer = null;
		stopBufferWait();
		clearTimeout(seekTimer);
		nameEl.textContent = s.name || '未命名';
		artistEl.textContent = s.artist || '';
		renderList();
		updateMediaSession();
		useSource(s.url, autoplay);
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
			pendingRatio = null;
			unlockProgress();
			try { audio.currentTime = 0; } catch (e) {}
			renderProgress();
			return;
		}
		load(i - 1, true);
	}

	/* 展开 / 收起面板。头部栏常驻，所以收起后播放键和曲名仍然在，
	   只是把进度、控制行收起来 —— 箭头图标由 CSS 按 .open 旋转。 */
	function setOpen(open) {
		root.classList.toggle('open', open);
		foldBtn.setAttribute('aria-expanded', String(open));
		foldBtn.setAttribute('aria-label', open ? '收起播放器' : '展开播放器');
		foldBtn.setAttribute('title', open ? '收起播放器' : '展开播放器');
		if (open) renderList();
	}

	/* ---------- 事件 ---------- */
	foldBtn.addEventListener('click', function () {
		setOpen(!root.classList.contains('open'));
	});

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
		/* 拖动中或等 seek 落地时不覆盖界面（renderProgress 里也锁着，这里省一次重排） */
		if (uiRatio === null) renderProgress();
		/* timeupdate 一秒能来好几次，5 秒落一次盘就够了 */
		var now = Date.now();
		if (now - lastSave > 5000) {
			lastSave = now;
			save();
		}
	});

	audio.addEventListener('seeked', function () {
		/* 只在「这次 seek 确实落到目标附近」时才解锁。
		   若这是上一次 seek 的迟到事件、或浏览器把位置吞掉（currentTime 停在
		   0/旧位置），这里不动 —— 交给 issueSeek 的超时去重试与回显。
		   这样进度条不会因为一次未落地的 seek 而跳回起始位置。 */
		if (seekTarget === null) return;
		if (Math.abs(audio.currentTime - seekTarget) <= 1.5) {
			unlockProgress();
		}
	});

	audio.addEventListener('loadedmetadata', function () {
		if (pendingSeek > 0) {
			try { audio.currentTime = pendingSeek; } catch (e) {}
			pendingSeek = 0;
		}
		applyPendingRatio();
		setProgress();
		/* 这次换源是为了完成一次拖动：位置已经补回来了，解锁进度条 */
		if (swapUnlock) {
			swapUnlock = false;
			unlockProgress();
		}
	});

	/* 有些源要等 durationchange 才知道总时长（分片、无 Content-Length 等），
	   这时把之前拖过的位置补上。 */
	audio.addEventListener('durationchange', function () {
		applyPendingRatio();
	});

	function applyPendingRatio() {
		if (pendingRatio === null) return;
		var d = seekLength();
		if (!d) return;
		var r = pendingRatio;
		pendingRatio = null;
		uiRatio = r;
		issueSeek(r * d);
	}

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
