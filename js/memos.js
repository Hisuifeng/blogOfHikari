/* ==========================================================================
   memos.js — 说说

   说说就是「/shuoshuo/ 这个路径下的 Twikoo 评论」。所以发布框、访客的二级评论、
   表情、搜索、往回翻历史的「加载更多」，全部交给 Twikoo 自己的界面与逻辑，
   主题只做两件事：

     · 样式（css/memos.css）：顶层那条当成「说说」突出显示，二级评论保持紧凑；
     · 把顶层的发布框收起来，只在博主自己的浏览器上放出来（initOwnerGate）。

   首页还要一份只读的「最近说说」，那是自己画的紧凑列表（initRecent）。

   脚本不在 #content 里，换页不会重放，所以自己监听 restart:page；
   配置每次 boot() 都重新找一遍，因为换页后 #memos-config 是新节点。
   ========================================================================== */
(function () {
	'use strict';

	function pad(n) { return n < 10 ? '0' + n : String(n); }

	/* 相对时间更贴近「说说」的语气，超过一周就显示日期 */
	function fmtTime(ts) {
		var diff = Date.now() - ts;
		if (diff < 0) diff = 0;
		if (diff < 60e3) return '刚刚';
		if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
		if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
		if (diff < 604800e3) return Math.floor(diff / 86400e3) + ' 天前';
		var d = new Date(ts);
		return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
	}

	/* COMMENT_GET：Twikoo 云函数的事件名，收 url / page / pageSize / sort，
	   返回 { data, more, count }。失败时时间线只是停住，不会把页面带崩。 */
	function fetchPage(cfg, page, pageSize) {
		return fetch(cfg.envId, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				event: 'COMMENT_GET',
				url: cfg.path,
				page: page,
				pageSize: pageSize,
				sort: 'newest'
			})
		}).then(function (r) {
			if (!r.ok) throw new Error('HTTP ' + r.status);
			return r.json();
		});
	}

	/* ---------- 渲染一条 ---------- */

	function el(tag, cls, text) {
		var n = document.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}

	function renderOne(c) {
		var li = el('li', 'memo');

		var head = el('div', 'memo-head');

		if (c.avatar) {
			var img = document.createElement('img');
			img.className = 'memo-avatar';
			img.src = c.avatar;
			img.alt = '';
			img.loading = 'lazy';
			img.referrerPolicy = 'no-referrer';
			/* 头像挂了就退回首字母，别留一个破图 */
			img.onerror = function () {
				var fb = el('span', 'memo-avatar memo-avatar-text', (c.nick || '?').slice(0, 1));
				if (img.parentNode) img.parentNode.replaceChild(fb, img);
			};
			head.appendChild(img);
		} else {
			head.appendChild(el('span', 'memo-avatar memo-avatar-text', (c.nick || '?').slice(0, 1)));
		}

		var who = el('div', 'memo-who');
		if (c.link) {
			var a = document.createElement('a');
			a.className = 'memo-nick';
			a.href = c.link;
			a.target = '_blank';
			a.rel = 'noopener noreferrer nofollow';
			a.textContent = c.nick || '匿名';
			who.appendChild(a);
		} else {
			who.appendChild(el('span', 'memo-nick', c.nick || '匿名'));
		}
		who.appendChild(el('time', 'memo-time', fmtTime(c.created)));

		var body = el('div', 'memo-body');
		/* Twikoo 服务端已用 DOMPurify 消毒，这里直接放行 HTML */
		body.innerHTML = c.comment || '';

		li.appendChild(head);
		li.appendChild(who);
		li.appendChild(body);
		return li;
	}

	/* ---------- 首页：最近说说 ---------- */

	function initRecent(box, cfg) {
		var n = parseInt(box.getAttribute('data-count'), 10) || cfg.recentCount || 3;
		var list = box.querySelector('.memos-list');
		var empty = box.querySelector('.memos-empty');
		if (!list) return;

		fetchPage(cfg, 1, n).then(function (res) {
			var data = (res && res.data) || [];
			if (!data.length) {
				if (empty) empty.hidden = false;
				return;
			}
			data.forEach(function (c) { list.appendChild(renderOne(c)); });
		}).catch(function () {
			/* 拉不到就整块隐藏，别在首页留一个空盒子 */
			box.hidden = true;
		});
	}

	/* ---------- 说说页：发布框只对博主显示 ----------

	   Twikoo 没有「只有谁能发」的开关，服务端对谁都收（实测空昵称也收），
	   所以这里能给到的只是「页面上不给入口」这一层：默认藏起来，认对了再放出来。

	   判据故意跟 Twikoo 显示管理齿轮的规则保持一致 —— 浏览器里记住的昵称等于
	   ownerNick（主题配置 memos.owner_nick，没配就问 Twikoo 要它的 HIDE_ADMIN_CRYPT）。
	   也就是说它和那个齿轮防的是同一件事：顺手的人，不是存心的人。
	   真要挡住伪造，得把发布挪到一个需要密钥的接口后面。 */

	var ownerNick;   /* undefined = 还没问出结果 */

	function readNick() {
		try {
			var raw = localStorage.getItem('twikoo');
			if (raw) return (JSON.parse(raw) || {}).nick || '';
		} catch (e) {}
		return '';
	}

	function askOwnerNick(cfg, done) {
		if (ownerNick !== undefined) { done(ownerNick); return; }
		if (cfg.ownerNick) { ownerNick = cfg.ownerNick; done(ownerNick); return; }

		fetch(cfg.envId, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ event: 'GET_CONFIG' })
		}).then(function (r) { return r.json(); }).then(function (res) {
			ownerNick = ((res && res.config) || {}).HIDE_ADMIN_CRYPT || '';
			done(ownerNick);
		}).catch(function () {
			ownerNick = '';
			done('');
		});
	}

	function initOwnerGate(page, cfg) {
		askOwnerNick(cfg, function (owner) {
			/* 认不出博主是谁，就保持默认的「藏」——宁可博主自己多填一次昵称 */
			if (!owner) return;

			function sync() {
				page.classList.toggle('is-owner', readNick() === owner);
			}
			sync();

			/* 昵称随时可改：Twikoo 每敲一个字符就把它写进 localStorage，
			   这里跟着同步，填对了发布框就出来 */
			var tk = page.querySelector('.twikoo');
			if (!tk) return;
			['input', 'change', 'blur'].forEach(function (ev) {
				tk.addEventListener(ev, sync, true);
			});
		});
	}

	/* Twikoo 的空态文案是「还没有评论」，放在说说页读着别扭，换成「还没有说说」。
	   只在确实没有条目、且文案还是原文时改一次，不跟 Vue 的渲染打架。 */
	function initEmptyText(page) {
		function sync() {
			var container = page.querySelector('.tk-comments-container');
			if (!container || container.querySelector('.tk-comment')) return;
			var no = container.querySelector('.tk-comments-no');
			if (!no || no.textContent.trim() !== '还没有评论') return;
			no.textContent = '还没有说说';
		}
		sync();
		if (window.MutationObserver) {
			new MutationObserver(sync).observe(page, { childList: true, subtree: true });
		}
	}

	/* ---------- 入口 ---------- */

	/* 同一个节点只初始化一次：restart:page 有可能连发两次 */
	function once(node) {
		if (!node || node.getAttribute('data-memos')) return false;
		node.setAttribute('data-memos', '1');
		return true;
	}

	function boot() {
		var cfgEl = document.getElementById('memos-config');
		if (!cfgEl) return;

		var cfg;
		try { cfg = JSON.parse(cfgEl.textContent); } catch (e) { return; }
		if (!cfg || !cfg.envId) return;

		var recent = document.querySelector('.memos-recent');
		if (recent && once(recent)) initRecent(recent, cfg);

		var page = document.querySelector('.memos-page');
		if (page && once(page)) {
			initOwnerGate(page, cfg);
			initEmptyText(page);
		}
	}

	boot();
	/* 换页后是新的容器，重新来一遍 */
	document.addEventListener('restart:page', boot);
})();
