/* ==========================================================================
   music-card.js — 正文里的音乐卡片（{% music %}）

   卡片自己不造 <audio>：播放由固定播放器（js/player.js）承担，这里只做
   「显示 + 点击」三件事：

     · 播放键   → __restartPlayer.toggleUrl(地址, 曲名, 作者)：
                  这首在播就暂停；不在播放列表里就先补进去再播 ——
                  所以正文里的音乐不必事先登记到主题配置
     · 进度条   → 点击/拖动/方向键换算成比例，松手交给 __restartPlayer.seekRatio()
     · 进度与状态 → 听 #player-audio 自己的事件（同一个 <audio>，状态永远一致）

   判断「是不是正在放的那首」用地址而不是下标：补进歌单的歌，下标是运行时才有的，
   而地址在构建期就写进了 data-url（与播放器那份过了同一道 url_for）。

   播放器没开（music.enable 关了、或整首歌单为空）时给卡片加 .off：
   按钮变灰、点了没反应，而不是让人以为坏了。

   脚本挂在 #content 之外（layout.ejs），pjax 换页不会重放，
   所以自己监听 restart:page 重新绑定与同步。
   ========================================================================== */
(function () {
	'use strict';

	function api() { return window.__restartPlayer; }

	function cards() {
		return Array.prototype.slice.call(document.querySelectorAll('.music-card[data-url]'));
	}

	function urlOf(card) { return card.getAttribute('data-url') || ''; }

	function paint(card, ratio, live) {
		var bar = card.querySelector('.music-bar');
		var fill = card.querySelector('.music-fill');
		if (!bar || !fill) return;
		fill.style.width = (ratio * 100).toFixed(2) + '%';
		bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
		/* live：拖动中的预览，去掉过渡，免得进度慢半拍跟不上手指 */
		fill.style.transition = live ? 'none' : '';
	}

	/* 地址 + 进度 → 卡片的外观。所有卡片过一遍，代价可以忽略。 */
	function sync() {
		var p = api();
		cards().forEach(function (card) {
			var current = !!p && p.isCurrent(urlOf(card));
			card.classList.toggle('current', current);
			card.classList.toggle('playing', current && p.playing());
			card.classList.toggle('off', !p);
			/* 手指还按在进度条上时，宽度由拖动那一路说了算 */
			if (card.getAttribute('data-dragging')) return;
			paint(card, current ? p.ratio() : 0, false);
		});
	}

	/* 把指针横坐标换算成 0~1 的比例（只对「正在放的那首」生效） */
	function ratioAt(card, clientX) {
		var bar = card.querySelector('.music-bar');
		if (!bar) return null;
		var p = api();
		if (!p || !p.isCurrent(urlOf(card))) return null;
		var r = bar.getBoundingClientRect();
		if (!r.width) return null;
		return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
	}

	function bind(card) {
		if (card.getAttribute('data-ready')) return;
		card.setAttribute('data-ready', '1');

		var playBtn = card.querySelector('.music-play');
		var bar = card.querySelector('.music-bar');

		if (playBtn) {
			playBtn.addEventListener('click', function () {
				var p = api();
				if (!p) return;
				p.toggleUrl(urlOf(card), card.getAttribute('data-name') || '', card.getAttribute('data-artist') || '');
			});
		}

		if (bar) {
			/* 拖动：按下就接管，move 只预览，松手才真正 seek
			   （和播放器自己那条进度条同一套节奏，避免每帧 seek 抖动） */
			bar.addEventListener('pointerdown', function (e) {
				var r = ratioAt(card, e.clientX);
				if (r === null) return;
				e.preventDefault();
				if (bar.setPointerCapture) bar.setPointerCapture(e.pointerId);
				card.setAttribute('data-dragging', '1');
				paint(card, r, true);
			});

			bar.addEventListener('pointermove', function (e) {
				if (!card.getAttribute('data-dragging')) return;
				var r = ratioAt(card, e.clientX);
				if (r !== null) paint(card, r, true);
			});

			function release(e) {
				if (!card.getAttribute('data-dragging')) return;
				card.removeAttribute('data-dragging');
				var r = ratioAt(card, e.clientX);
				var p = api();
				if (r !== null && p) p.seekRatio(r);
				sync();
			}

			bar.addEventListener('pointerup', release);
			bar.addEventListener('pointercancel', release);

			/* 键盘：左右各 5%，和播放器那条进度条的方向键一致 */
			bar.addEventListener('keydown', function (e) {
				if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
				var p = api();
				if (!p || !p.isCurrent(urlOf(card))) return;
				e.preventDefault();
				var step = e.key === 'ArrowRight' ? 0.05 : -0.05;
				p.seekRatio(Math.min(1, Math.max(0, p.ratio() + step)));
			});
		}
	}

	var bound = false;

	function boot() {
		cards().forEach(bind);

		/* <audio> 全程只可能有一个，且换页不会重建，所以事件只绑一次 */
		if (!bound) {
			var a = document.getElementById('player-audio');
			if (a) {
				bound = true;
				['timeupdate', 'play', 'pause', 'ended', 'seeked', 'loadedmetadata', 'durationchange', 'emptied']
					.forEach(function (ev) { a.addEventListener(ev, sync); });
			}
		}
		sync();
	}

	boot();
	document.addEventListener('restart:page', boot);
})();
